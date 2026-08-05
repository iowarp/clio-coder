import { readClioVersion, readPiMonoVersion } from "../../core/package-root.js";
import { withRunOverrides } from "../../core/run-overrides.js";
import {
	type PendingSkillRequest,
	type SkillActivation,
	skillActivationFromToolDetails,
} from "../../core/skill-activation.js";
import { ToolNames } from "../../core/tool-names.js";
import { createRunReceiptQuality } from "../../domains/dispatch/receipt-findings.js";
import { openLedger } from "../../domains/dispatch/state.js";
import type { RunKind, RunOutcome, RunReceiptDraft, ToolCallStat } from "../../domains/dispatch/types.js";
import type { AgentMessage, ImageContent } from "../../engine/types.js";
import type { ChatLoop, ChatLoopEvent } from "../../interactive/chat-loop.js";
import { type RunUsageSummary, sumRunUsage } from "../../interactive/chat-loop-messages.js";
import { flushRawStdout, writeRawStdout } from "../output-guard.js";
import { setupSteerChannel } from "../steer-channel.js";
import { serializeJsonLine } from "./jsonl.js";

export interface HeadlessSamplingOverrides {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
	repeatPenalty?: number;
}

export interface HeadlessMainAgentOptions {
	prompt: string;
	images?: ReadonlyArray<ImageContent>;
	workingContextPaths?: ReadonlyArray<string>;
	sampling?: HeadlessSamplingOverrides;
	pendingSkillRequests?: ReadonlyArray<PendingSkillRequest>;
	mode?: "text" | "json";
	jsonEvents?: "full" | "terminal";
	steerChannel?: string;
	getSessionHeader?: () => unknown | null;
}

interface HeadlessMainAgentResult {
	text: string;
	error: string | null;
	/**
	 * True when the most recent tool result ended the turn via
	 * `ToolResult.terminate` (artifact plan/review/report) with no error. These
	 * tools are the whole turn by design: the agent loop skips the follow-up
	 * call that would otherwise produce assistant text, so an empty `text`
	 * here is the turn completing exactly as intended, not a missing
	 * response.
	 */
	sawTerminatingToolResult: boolean;
	/**
	 * The interrupt reason from a cancelled turn (`notice` event keyed
	 * "turn.interrupted"). An interrupted turn always reports a nonzero exit
	 * with this reason, never a fabricated answer.
	 */
	abortReason: string | null;
	/** Most recent transcript notice; failure detail when the turn never answered. */
	lastNotice: string | null;
}

interface HeadlessMainAgentReceiptStats {
	toolStats: Map<string, ToolCallStat>;
	skillActivations: SkillActivation[];
	usage: RunUsageSummary | null;
}

function assistantText(message: AgentMessage | undefined): string {
	if (!message || typeof message !== "object" || message.role !== "assistant") return "";
	const content = Array.isArray(message.content) ? message.content : [];
	return content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("");
}

function assistantError(message: AgentMessage | undefined): string | null {
	if (!message || typeof message !== "object" || message.role !== "assistant") return null;
	const stopReason = (message as { stopReason?: unknown }).stopReason;
	if (stopReason !== "error" && stopReason !== "aborted") return null;
	const raw = (message as { errorMessage?: unknown }).errorMessage;
	if (typeof raw === "string" && raw.length > 0) return raw;
	return stopReason === "aborted" ? "request aborted" : "provider returned an error";
}

/**
 * Fold one chat-loop event into the turn's result. Derivation keys on event
 * types and stop reasons only: notices are typed `notice` events and can
 * never masquerade as the assistant's answer, and an assistant message is
 * the answer only when its stop reason is not a failure.
 */
function resultFromEvent(event: ChatLoopEvent, current: HeadlessMainAgentResult): HeadlessMainAgentResult {
	if (event.type === "tool_execution_end") {
		const terminate = (event.result as { terminate?: boolean } | undefined)?.terminate === true;
		return { ...current, sawTerminatingToolResult: terminate && !event.isError };
	}
	if (event.type === "notice") {
		if (event.surface !== "transcript") return current;
		if (event.key === "turn.interrupted") {
			return { ...current, lastNotice: event.text, abortReason: event.text };
		}
		return { ...current, lastNotice: event.text };
	}
	if (event.type !== "message_end") return current;
	const message = event.message;
	const error = assistantError(message);
	if (error) return { ...current, text: "", error };
	const text = assistantText(message).trimEnd();
	if (text.length === 0) return current;
	return { ...current, text, error: null };
}

function blankToolStat(tool: string): ToolCallStat {
	return { tool, count: 0, ok: 0, errors: 0, blocked: 0, totalDurationMs: 0 };
}

function durationMsFromEvent(event: ChatLoopEvent): number | undefined {
	const value = (event as { durationMs?: unknown }).durationMs;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function recordToolEnd(stats: HeadlessMainAgentReceiptStats, event: ChatLoopEvent): void {
	if (event.type !== "tool_execution_end") return;
	const tool = typeof event.toolName === "string" && event.toolName.length > 0 ? event.toolName : "tool";
	const stat = stats.toolStats.get(tool) ?? blankToolStat(tool);
	stat.count += 1;
	const durationMs = durationMsFromEvent(event);
	if (durationMs !== undefined) stat.totalDurationMs += durationMs;
	if (event.isError) stat.errors += 1;
	else stat.ok += 1;
	stats.toolStats.set(tool, stat);
	if (tool === ToolNames.Context) {
		const rawTurnId = (event as { turnId?: unknown }).turnId;
		const turnId = typeof rawTurnId === "string" ? rawTurnId : undefined;
		const activation = skillActivationFromToolDetails(
			(event.result as { details?: unknown } | undefined)?.details,
			turnId,
		);
		if (activation) stats.skillActivations.push(activation);
	}
}

function addRunUsage(left: RunUsageSummary, right: RunUsageSummary): RunUsageSummary {
	return {
		tokens: left.tokens + right.tokens,
		costUsd: left.costUsd + right.costUsd,
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		reasoning: left.reasoning + right.reasoning,
		apiCalls: left.apiCalls + right.apiCalls,
		hadReasoning: left.hadReasoning || right.hadReasoning,
		hadUsage: true,
	};
}

function sortedToolStats(stats: Map<string, ToolCallStat>): ToolCallStat[] {
	return [...stats.values()].sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

function countToolStats(stats: Map<string, ToolCallStat>): number {
	let count = 0;
	for (const stat of stats.values()) count += stat.count;
	return count;
}

const TERMINAL_JSON_EVENT_TYPES = new Set([
	"agent_start",
	"agent_end",
	"message_end",
	"notice",
	"tool_execution_start",
	"tool_execution_end",
]);

function isMainAgentRunKind(value: string): value is RunKind {
	return value === "http" || value === "sdk" || value === "subprocess";
}

async function recordHeadlessMainAgentReceipt(input: {
	chat: ChatLoop;
	task: string;
	startedAt: string;
	endedAt: string;
	exitCode: number;
	failureMessage: string | null;
	stats: HeadlessMainAgentReceiptStats;
}): Promise<void> {
	const snapshot = input.chat.lastRunSnapshot?.();
	if (!snapshot) return;
	if (!isMainAgentRunKind(snapshot.runtimeKind)) return;
	const usage = input.stats.usage;
	const tokenCount = usage?.tokens ?? 0;
	const inputTokenCount = usage?.input ?? 0;
	const outputTokenCount = usage?.output ?? 0;
	const cacheReadTokenCount = usage?.cacheRead ?? 0;
	const cacheWriteTokenCount = usage?.cacheWrite ?? 0;
	const reasoningTokenCount = usage?.reasoning ?? 0;
	const costUsd = usage?.costUsd ?? 0;
	const status = input.exitCode === 0 ? "completed" : "failed";
	const outcome: RunOutcome = input.exitCode === 0 ? "succeeded" : "failed";
	const outcomeDetail = input.exitCode === 0 ? null : input.failureMessage;
	const ledger = openLedger();
	const envelope = ledger.create({
		agentId: "main-agent",
		executionRole: "builder",
		requestOrigin: "user",
		task: input.task,
		targetId: snapshot.targetId,
		wireModelId: snapshot.wireModelId,
		runtimeId: snapshot.runtimeId,
		runtimeKind: snapshot.runtimeKind,
		sessionId: snapshot.sessionId ?? input.chat.getSessionId(),
		cwd: snapshot.cwd,
	});
	const lineage = {
		parentRunId: null,
		rootRunId: envelope.id,
		attempt: 0,
		depth: 0,
	};
	const updated = ledger.update(envelope.id, {
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		status,
		outcome,
		outcomeDetail,
		lineage,
		exitCode: input.exitCode,
		tokenCount,
		inputTokenCount,
		outputTokenCount,
		cacheReadTokenCount,
		cacheWriteTokenCount,
		reasoningTokenCount,
		costUsd,
		promptSignature: snapshot.promptSignature,
		toolSignature: snapshot.toolSignature,
	});
	if (!updated) return;
	const toolStats = sortedToolStats(input.stats.toolStats);
	const receipt: RunReceiptDraft = {
		runId: envelope.id,
		agentId: "main-agent",
		executionRole: "builder",
		requestOrigin: "user",
		task: input.task,
		targetId: snapshot.targetId,
		wireModelId: snapshot.wireModelId,
		runtimeId: snapshot.runtimeId,
		runtimeKind: snapshot.runtimeKind,
		outcome,
		outcomeDetail,
		lineage,
		// A print-mode session run is the main agent, not a dispatched worker: no
		// validation tool gates it, and its cost comes from the session usage
		// meter rather than a resolved worker pricing table.
		verification: { state: "unverified", basis: "no-validation-tool" },
		routingIntent: {
			posture: "manual",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: createRunReceiptQuality({ runtimeEnforceable: false, enforcementPassed: null }),
		costProvenance: "unknown",
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		exitCode: input.exitCode,
		...(input.failureMessage !== null ? { failureMessage: input.failureMessage } : {}),
		tokenCount,
		inputTokenCount,
		outputTokenCount,
		cacheReadTokenCount,
		cacheWriteTokenCount,
		reasoningTokenCount,
		costUsd,
		compiledPromptHash: snapshot.compiledPromptHash,
		staticCompositionHash: snapshot.staticCompositionHash,
		promptSignature: snapshot.promptSignature,
		toolSignature: snapshot.toolSignature,
		clioVersion: readClioVersion(),
		piMonoVersion: readPiMonoVersion(),
		platform: process.platform,
		nodeVersion: process.version,
		toolCalls: countToolStats(input.stats.toolStats),
		toolStats,
		skillActivations: input.stats.skillActivations,
		autonomyEnforcement: { grade: "mediated", autonomy: snapshot.autonomy },
		...(snapshot.runtimeResolution ? { runtimeResolution: snapshot.runtimeResolution } : {}),
		sessionId: snapshot.sessionId ?? input.chat.getSessionId(),
	};
	ledger.recordReceipt(envelope.id, receipt);
	await ledger.persist();
}

export async function runHeadlessMainAgent(chat: ChatLoop, options: HeadlessMainAgentOptions): Promise<number> {
	const mode = options.mode ?? "text";
	const jsonEvents = options.jsonEvents ?? "full";
	const startedAt = new Date().toISOString();
	let result: HeadlessMainAgentResult = {
		text: "",
		error: null,
		sawTerminatingToolResult: false,
		abortReason: null,
		lastNotice: null,
	};
	const receiptStats: HeadlessMainAgentReceiptStats = {
		toolStats: new Map<string, ToolCallStat>(),
		skillActivations: [],
		usage: null,
	};
	let jsonHeaderWritten = false;
	const writeJsonHeader = (allowFallback: boolean): void => {
		if (jsonHeaderWritten) return;
		const header = options.getSessionHeader?.();
		if (header === undefined || header === null) {
			if (!allowFallback) return;
			const sessionId = chat.getSessionId();
			if (sessionId === null) return;
			jsonHeaderWritten = true;
			writeRawStdout(serializeJsonLine({ type: "session", id: sessionId, timestamp: startedAt, cwd: process.cwd() }));
			return;
		}
		jsonHeaderWritten = true;
		writeRawStdout(serializeJsonLine(header));
	};
	let terminalTurnStartWritten = false;
	const writeTerminalTurnStart = (): void => {
		if (terminalTurnStartWritten) return;
		terminalTurnStartWritten = true;
		writeJsonHeader(true);
		writeRawStdout(serializeJsonLine({ type: "turn_start", startedAt }));
	};
	const unsubscribe = chat.onEvent((event) => {
		if (mode === "json") {
			if (jsonEvents === "terminal") {
				writeTerminalTurnStart();
				writeJsonHeader(true);
				if (TERMINAL_JSON_EVENT_TYPES.has(event.type)) writeRawStdout(serializeJsonLine(event));
			} else {
				writeJsonHeader(false);
				writeRawStdout(serializeJsonLine(event));
			}
		}
		recordToolEnd(receiptStats, event);
		if (event.type === "agent_end") {
			// Notice-only agent_end events carry no usage; never let one clobber
			// the real run's totals with zeros. A headless turn can also span
			// several agent segments (middleware nudges and finish-contract
			// reprompts start new agent runs), and each agent_end carries only
			// its own segment's messages, so segments accumulate: keeping only
			// the last one recorded 23808 of a measured ~204640-token run.
			const usageSummary = sumRunUsage(event.messages);
			if (usageSummary.hadUsage) {
				receiptStats.usage = receiptStats.usage === null ? usageSummary : addRunUsage(receiptStats.usage, usageSummary);
			}
		}
		result = resultFromEvent(event, result);
	});

	let cleanupSteer: (() => void) | undefined;
	if (options.steerChannel) {
		cleanupSteer = setupSteerChannel(options.steerChannel, (line) => {
			chat.steer(line);
		});
	}
	try {
		if (mode === "json" && jsonEvents === "terminal") writeTerminalTurnStart();
		const submitOptions = {
			...(options.images && options.images.length > 0 ? { images: options.images } : {}),
			...(options.workingContextPaths && options.workingContextPaths.length > 0
				? { workingContextPaths: options.workingContextPaths }
				: {}),
			...(options.pendingSkillRequests && options.pendingSkillRequests.length > 0
				? { pendingSkillRequests: options.pendingSkillRequests }
				: {}),
		};
		// Sampling flags ride the scoped run-overrides transport for the turn;
		// see core/run-overrides.ts.
		await withRunOverrides(
			options.sampling && Object.keys(options.sampling).length > 0 ? { sampling: { ...options.sampling } } : {},
			async () => {
				await chat.submit(options.prompt, Object.keys(submitOptions).length > 0 ? submitOptions : undefined);
			},
		);
	} finally {
		if (cleanupSteer) {
			cleanupSteer();
		}
		unsubscribe();
	}

	const endedAt = new Date().toISOString();
	let exitCode = 0;
	let failureMessage: string | null = null;
	let stderrMessage: string | null = null;
	let stdoutMessage: string | null = null;
	if (result.abortReason !== null) {
		// An interrupted turn never answered, no matter what partial text or
		// internal error the abort left behind: nonzero exit, abort reason.
		exitCode = 1;
		failureMessage = result.abortReason;
		stderrMessage = result.abortReason;
	} else if (result.error) {
		exitCode = 1;
		failureMessage = result.error;
		stderrMessage = result.error;
	} else if (result.text.length === 0) {
		if (result.sawTerminatingToolResult) {
			exitCode = 0;
		} else {
			exitCode = 1;
			failureMessage =
				result.lastNotice !== null ? `clio run: no assistant response (${result.lastNotice})` : "clio run: no assistant response";
			stderrMessage = failureMessage;
		}
	} else if (mode === "text") {
		stdoutMessage = result.text;
	}

	if (mode === "json" && jsonEvents === "terminal") {
		writeJsonHeader(true);
		writeRawStdout(
			serializeJsonLine({
				type: "turn_end",
				startedAt,
				endedAt,
				exitCode,
				...(failureMessage !== null ? { error: failureMessage } : {}),
			}),
		);
	}

	try {
		await recordHeadlessMainAgentReceipt({
			chat,
			task: options.prompt,
			startedAt,
			endedAt,
			exitCode,
			failureMessage,
			stats: receiptStats,
		});
	} catch (error) {
		process.stderr.write(`clio run: receipt write failed: ${error instanceof Error ? error.message : String(error)}\n`);
	}

	if (stderrMessage !== null) {
		process.stderr.write(`${stderrMessage}\n`);
	} else if (stdoutMessage !== null) {
		writeRawStdout(`${stdoutMessage}\n`);
	}
	await flushRawStdout();
	return exitCode;
}
