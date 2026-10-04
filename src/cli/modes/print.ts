import { readDispatchScopeNotice } from "../../core/dispatch-scope-notice.js";
import { headlessRouteFailureText } from "../../core/gateway-routing.js";
import { readClioVersion } from "../../core/package-root.js";
import {
	addResponseModelIdObservationCounts,
	emptyResponseModelIdObservationCounts,
} from "../../core/response-model-id.js";
import { withRunOverrides } from "../../core/run-overrides.js";
import {
	type PendingSkillRequest,
	type SkillActivation,
	skillActivationFromToolDetails,
} from "../../core/skill-activation.js";
import { getTerminationCoordinator } from "../../core/termination.js";
import { type BuiltinToolName, ToolNames } from "../../core/tool-names.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import type { DispatchContract } from "../../domains/dispatch/contract.js";
import { runStatusForOutcome } from "../../domains/dispatch/outcome.js";
import {
	createRunReceiptQuality,
	deriveReceiptVerification,
	typedValidationFactsFromVerifyCalls,
	type VerifyCallOutcome,
	verifyCheckIdentity,
} from "../../domains/dispatch/receipt-findings.js";
import { newRunId, openLedger } from "../../domains/dispatch/state.js";
import type {
	RunKind,
	RunOutcome,
	RunReceiptDraft,
	RunReceiptSafetySummary,
	RunStatus,
	SafetyBlockedAttempt,
	ToolCallStat,
} from "../../domains/dispatch/types.js";
import type { CostAmount } from "../../domains/observability/cost.js";
import { aggregateCostAmounts } from "../../domains/observability/cost.js";
import type { ActionClass } from "../../domains/safety/action-classifier.js";
import { SESSION_COST_CEILING_EXIT_CODE, SESSION_COST_CEILING_REASON } from "../../domains/scheduling/budget.js";
import { readPiMonoVersion } from "../../engine/pi-mono-names.js";
import type { AgentMessage, ImageContent } from "../../engine/types.js";
import type { HeadlessRunDeadline } from "../../entry/boot-options.js";
import type { ChatLoop, ChatLoopEvent } from "../../session-control/chat-loop.js";
import { type RunUsageSummary, sumRunUsage } from "../../session-control/chat-loop-messages.js";
import { TOOL_PLANES } from "../../tools/policy.js";
import { effectiveToolCall, gatewayChainReceipts } from "../../tools/surface.js";
import { flushRawStdout, writeRawStdout } from "../output-guard.js";
import { setupSteerChannel } from "../steer-channel.js";
import {
	type DispatchedRunsSettlement,
	describeRuns,
	projectDispatchedRunOutcome,
	settleDispatchedRuns,
} from "./headless-dispatched-runs.js";
import { createHeadlessJsonProjector } from "./json-stream.js";
import { writeFrame } from "./jsonl.js";
import type { RunJsonMainFrame, RunJsonMainSessionFrame } from "./run-json-schema.js";
import { RUN_JSON_SCHEMA_VERSION } from "./run-json-schema.js";

export interface HeadlessSamplingOverrides {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
	repeatPenalty?: number;
}

/**
 * The shutdown seam a headless turn needs: somewhere to register the drain
 * hook that seals an interrupted run's receipt, and the exit code that
 * shutdown will report. Defaults to the process termination coordinator.
 */
export interface HeadlessShutdownHooks {
	onDrain(hook: () => void | Promise<void>): void;
	getExitCode(): number;
	/** True once a signal or quit started the coordinated shutdown. */
	isShuttingDown(): boolean;
}

export interface HeadlessMainAgentOptions {
	prompt: string;
	constraints?: TurnConstraints;
	images?: ReadonlyArray<ImageContent>;
	workingContextPaths?: ReadonlyArray<string>;
	sampling?: HeadlessSamplingOverrides;
	pendingSkillRequests?: ReadonlyArray<PendingSkillRequest>;
	mode?: "text" | "json";
	jsonEvents?: "full" | "terminal";
	steerChannel?: string;
	getSessionHeader?: () => RunJsonMainSessionFrame | null;
	shutdown?: HeadlessShutdownHooks;
	/**
	 * Also fail when all attempted tools failed without a block. Blocked runs
	 * without recovery or a successful write, and explicit limitations, fail unconditionally.
	 */
	failOnNoop?: boolean;
	/**
	 * `clio-coder run --timeout`. When it expired, the shutdown it started seals
	 * outcome `timed_out` instead of `canceled`, so a driver can tell its own
	 * wall-clock limit from an external signal.
	 */
	deadline?: HeadlessRunDeadline;
	/**
	 * The dispatch ledger. When present, the run waits for the workers it
	 * dispatched before sealing and fails when one did not deliver (D3, D6b).
	 */
	dispatch?: Pick<DispatchContract, "listRuns">;
	/**
	 * Subscribes to dispatch scope notices on the bus. Text mode writes each to
	 * stderr and `--json` carries it as a `dispatch_scope_notice` event, so a
	 * run with no operator still says what a dispatch's scope entry did.
	 */
	scopeNotices?: (listener: (payload: unknown) => void) => () => void;
}

interface HeadlessMainAgentResult {
	/** Latest assistant stop, superseded by subsequent continuation messages. */
	outputExhausted: boolean;
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
	 * What that terminating tool returned ("wrote plan artifact (572B) to
	 * PLAN.md"). The turn ends there by design, so this text is the whole
	 * answer: without it a text-mode run wrote the artifact, said nothing, and
	 * exited 0, and a run that had chattered before calling the tool printed
	 * that mid-workflow line as if it were the reply.
	 */
	terminatingToolText: string;
	/**
	 * The interrupt reason from a cancelled turn (`notice` event keyed
	 * "turn.interrupted"). An interrupted turn always reports a nonzero exit
	 * with this reason, never a fabricated answer.
	 */
	abortReason: string | null;
	/** Most recent transcript notice; failure detail when the turn never answered. */
	lastNotice: string | null;
	/**
	 * The chat loop refused the turn before any request (an admission notice):
	 * no target, no model, a context window it cannot fit, an image the route
	 * cannot read. Its notice is the failure, and text mode has already printed it.
	 */
	admissionRefused: boolean;
}

interface HeadlessMainAgentReceiptStats {
	toolStats: Map<string, ToolCallStat>;
	pendingCapabilities: Map<string, string>;
	pendingVerifyCalls: Map<string, string | null>;
	verifyCalls: VerifyCallOutcome[];
	skillActivations: SkillActivation[];
	usage: RunUsageSummary | null;
	costAmounts: CostAmount[];
	/** The decision axis, counted the way a worker receipt counts it. */
	decisions: RunReceiptSafetySummary["decisions"];
	/** Every call whose outcome was blocked, in the worker receipt's shape, up to `BLOCKED_ATTEMPTS_LIMIT`. */
	blockedAttempts: SafetyBlockedAttempt[];
	/** Blocked attempts past `BLOCKED_ATTEMPTS_LIMIT`, counted but not listed. */
	blockedAttemptsTruncated: number;
	/** Successful calls the registry classified as `MUTATING_ACTION_CLASS`. */
	mutatingSucceeded: number;
	/** Dispatched runs whose task worktree merged into this workspace. */
	mergedTaskWorktrees: number;
	/** Blocked action classes not followed by successful substantive work of that class. */
	unresolvedBlocks: Set<string>;
}

/**
 * The registry action class a successful call must carry to count as a
 * mutation for the no-op rule. It is the class autonomy `default` runs
 * without asking (`mapAutonomy` in domains/safety/autonomy.ts): write, edit,
 * and an outward web_fetch. The class comes from the registry's own admission
 * of each call, so an extension tool that declares a write base class counts
 * too. `execute` is left out on purpose: a shell command's class says that it
 * ran, not that it wrote, and counting it would let one successful
 * `git status` after a denied write hide the no-op this rule exists to catch.
 * A terminating result is left out too (see `recordToolEnd`).
 */
const MUTATING_ACTION_CLASS: ActionClass = "write";

/**
 * Bounds on `safety.blockedAttempts`. A model retrying a denied call appends
 * an entry per attempt, each carrying the full rejection text, so the list is
 * capped and each reason clipped. Attempts past the cap are counted in
 * `safety.blockedAttemptsTruncated`; the per-tool blocked counts in
 * `toolStats` stay exact either way.
 */
export const BLOCKED_ATTEMPTS_LIMIT = 50;
export const BLOCKED_ATTEMPT_REASON_MAX_CHARS = 500;

/** Append one blocked attempt within the receipt bounds above. */
export function recordBlockedAttempt(
	stats: { blockedAttempts: SafetyBlockedAttempt[]; blockedAttemptsTruncated: number },
	attempt: SafetyBlockedAttempt,
): void {
	if (stats.blockedAttempts.length >= BLOCKED_ATTEMPTS_LIMIT) {
		stats.blockedAttemptsTruncated += 1;
		return;
	}
	const reason = attempt.reason;
	stats.blockedAttempts.push(
		reason !== undefined && reason.length > BLOCKED_ATTEMPT_REASON_MAX_CHARS
			? { ...attempt, reason: `${reason.slice(0, BLOCKED_ATTEMPT_REASON_MAX_CHARS)}…` }
			: attempt,
	);
}

function assistantText(message: AgentMessage | undefined): string {
	if (!message || typeof message !== "object" || message.role !== "assistant") return "";
	const content = Array.isArray(message.content) ? message.content : [];
	return content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("");
}

/** The text blocks of a tool result, which is what the tool told the model. */
function toolResultText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: "text"; text: string } => {
			return (
				typeof item === "object" &&
				item !== null &&
				(item as { type?: unknown }).type === "text" &&
				typeof (item as { text?: unknown }).text === "string"
			);
		})
		.map((item) => item.text)
		.join("")
		.trim();
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
		const result = event.result as { terminate?: boolean; content?: unknown } | undefined;
		const terminate = result?.terminate === true && !event.isError;
		return {
			...current,
			sawTerminatingToolResult: terminate,
			terminatingToolText: terminate ? toolResultText(result?.content) : "",
		};
	}
	if (event.type === "notice") {
		if (event.surface !== "transcript") return current;
		// Every admission notice ends the turn before the provider is called. Only
		// the image case used to count as a failure, so an empty home's "not
		// configured" notice was chased by "provider stream ended without an
		// assistant response", which blamed a provider nobody had reached.
		if (event.admission !== undefined) {
			return { ...current, lastNotice: event.text, error: event.text, admissionRefused: true };
		}
		if (event.key === "turn.interrupted") {
			return { ...current, lastNotice: event.text, abortReason: event.text };
		}
		return { ...current, lastNotice: event.text };
	}
	if (event.type !== "message_end") return current;
	const message = event.message;
	if (message?.role !== "assistant") return current;
	current = {
		...current,
		outputExhausted: message.stopReason === "length",
		sawTerminatingToolResult: false,
		admissionRefused: false,
	};
	const error = assistantError(message);
	if (error) return { ...current, text: "", error };
	const text = assistantText(message).trimEnd();
	// A successful retry may contain only tool calls. It supersedes the prior
	// provider error even without prose; the terminal tool/answer checks still
	// decide whether the task completed. Tool-result messages cannot clear it.
	if (text.length === 0) return { ...current, error: null };
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
	if (event.type === "tool_execution_start") {
		const call = effectiveToolCall(event.toolName, event.args);
		stats.pendingCapabilities.set(event.toolCallId, call.toolName);
		if (call.toolName === ToolNames.Verify)
			stats.pendingVerifyCalls.set(event.toolCallId, verifyCheckIdentity(call.args));
		return;
	}
	if (event.type !== "tool_execution_end") return;
	const tool = stats.pendingCapabilities.get(event.toolCallId) ?? event.toolName ?? "tool";
	stats.pendingCapabilities.delete(event.toolCallId);
	// Fold completed child operations into accounting only. The provider and
	// session history retain the real aggregate call/result pair.
	for (const child of gatewayChainReceipts(event.toolName, event.result)) {
		const toolCallId = `${event.toolCallId}:${child.id}`;
		if (child.capability === ToolNames.Verify) stats.pendingVerifyCalls.set(toolCallId, verifyCheckIdentity(child.args));
		recordToolEnd(stats, {
			type: "tool_execution_end",
			toolCallId,
			toolName: child.capability,
			isError: child.admission.outcome !== "ok",
			result: { ...child.result, terminate: child.admission.terminate === true },
			...child.admission,
		} as ChatLoopEvent);
	}
	const stat = stats.toolStats.get(tool) ?? blankToolStat(tool);
	stat.count += 1;
	const durationMs = durationMsFromEvent(event);
	if (durationMs !== undefined) stat.totalDurationMs += durationMs;
	// Registry settlement is authoritative; legacy producers only expose isError.
	const outcome = (event as { outcome?: unknown }).outcome;
	if (tool === ToolNames.Verify) {
		stats.verifyCalls.push({
			check: stats.pendingVerifyCalls.get(event.toolCallId) ?? null,
			outcome:
				outcome === "ok" || outcome === "error" || outcome === "blocked"
					? outcome
					: outcome === undefined
						? event.isError
							? "error"
							: "ok"
						: null,
		});
		stats.pendingVerifyCalls.delete(event.toolCallId);
	}
	if (outcome === "blocked") stat.blocked += 1;
	else if (outcome === "error") stat.errors += 1;
	else if (outcome === "ok") stat.ok += 1;
	else if (outcome === undefined) {
		if (event.isError) stat.errors += 1;
		else stat.ok += 1;
	}
	stats.toolStats.set(tool, stat);
	// Safety bookkeeping mirrors the worker receipt's fold of its own tool
	// finish events (domains/dispatch/extension.ts), so the two receipts carry
	// the same facts under the same names.
	const detail = event as {
		ruleId?: unknown;
		reasonCode?: unknown;
		policySource?: unknown;
		blockReason?: unknown;
		deniedPark?: unknown;
	};
	const decision = (event as { decision?: unknown }).decision;
	// A call that parked for approval and was denied because a headless run has
	// no operator arrives as a registry block: parkAnsweredBlockedVerdict
	// rewrites the ask. The summary's contract counts that call as a permission
	// request, which is where a worker's non-interactive denial lands, so the
	// registry's `deniedPark` flag routes it there. The flag, not the reason
	// text, is the signal: the loop guard replaces the reason of a repeated
	// denied call with its own guidance. `decisions.blocked` keeps meaning a
	// hard block by a rule or a guard.
	const deniedAsk = decision === "blocked" && detail.deniedPark === true;
	if (decision === "allowed") stats.decisions.allowed += 1;
	else if (decision === "permission_requested" || deniedAsk) stats.decisions.permissionRequested += 1;
	else if (decision === "blocked") stats.decisions.blocked += 1;
	const actionClass = (event as { actionClass?: unknown }).actionClass;
	if (outcome === "blocked" || decision === "blocked") {
		const attempt: SafetyBlockedAttempt = { tool };
		if (typeof actionClass === "string") attempt.actionClass = actionClass;
		if (typeof detail.ruleId === "string") attempt.ruleId = detail.ruleId;
		if (typeof detail.reasonCode === "string") attempt.reasonCode = detail.reasonCode;
		if (typeof detail.policySource === "string") attempt.policySource = detail.policySource;
		if (typeof detail.blockReason === "string") attempt.reason = detail.blockReason;
		recordBlockedAttempt(stats, attempt);
	}
	// A terminating result (the artifact tool's plan, review, or report) is the
	// turn's answer written to a file, not the workspace change the task asked
	// for. Counting it let a run whose every edit was blocked seal as a success
	// by writing a report about the failure. `terminate` is the registry's own
	// marker for that kind of result and survives the gateway hop, where the
	// call's tool name is `gateway` rather than `artifact`.
	const terminating = (event.result as { terminate?: unknown } | undefined)?.terminate === true;
	const action = typeof actionClass === "string" ? actionClass : "unknown";
	if (outcome === "blocked" || decision === "blocked") {
		stats.unresolvedBlocks.add(action);
	} else if (outcome === "ok" || (outcome === undefined && !event.isError)) {
		const capability =
			tool === ToolNames.Gateway
				? (event.result as { details?: { capability?: unknown } } | undefined)?.details?.capability
				: tool;
		const plane =
			typeof capability === "string" && Object.hasOwn(TOOL_PLANES, capability)
				? TOOL_PLANES[capability as BuiltinToolName].plane
				: undefined;
		// A later alternate read/command can recover its blocked action class.
		// Bookkeeping, discovery, limitation, and terminal reports cannot.
		if (
			!terminating &&
			capability !== ToolNames.Context &&
			capability !== ToolNames.CredentialPresent &&
			(plane === "observe" || plane === "retrieve" || plane === "execute" || plane === "mutate")
		) {
			stats.unresolvedBlocks.delete(action);
			// A read may be useful progress after a denied command, but cannot
			// attest that command's requirement (for example a test) was met.
			// An independent task verifier can accept an alternate workflow;
			// this event fold has no authority to infer semantic substitution.
		}
	}
	if (outcome === "ok" && actionClass === MUTATING_ACTION_CLASS && !terminating) stats.mutatingSucceeded += 1;
	if (outcome === "ok" && tool === ToolNames.Dispatch)
		stats.mergedTaskWorktrees += mergedTaskWorktreeCount(event.result);
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
	const responseModelIdObservationCounts = emptyResponseModelIdObservationCounts();
	addResponseModelIdObservationCounts(responseModelIdObservationCounts, left.responseModelIdObservationCounts);
	addResponseModelIdObservationCounts(responseModelIdObservationCounts, right.responseModelIdObservationCounts);
	const last = right.hadUsage ? right : left;
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
		hadUsage: left.hadUsage || right.hadUsage,
		...(left.estimated || right.estimated ? { estimated: true } : {}),
		responseModelIdObservationCounts,
		lastResponseModelIdObservation: last.lastResponseModelIdObservation,
		lastDifferingResponseModelId: last.lastDifferingResponseModelId,
	};
}

/**
 * Ticket #378: a run whose every write was denied, and whose model then wrote
 * an apology, used to seal as a success. The receipt now says so in one bit.
 * A run is a no-op when a block remains unresolved and no mutating call succeeded, or
 * when it ran tools and none of them succeeded. A run that called no tool and
 * answered in prose is not a no-op; answering a question is a legitimate run.
 */
function headlessNoop(stats: HeadlessMainAgentReceiptStats): boolean {
	const totals = toolTotals(stats.toolStats);
	if (stats.unresolvedBlocks.size > 0 && !changedWorkspace(stats)) return true;
	return totals.calls > 0 && totals.succeeded === 0;
}

/**
 * A dispatch whose task worktree merged changed this workspace as surely as
 * an edit did. Counting only the main agent's own write calls failed a
 * delegated change that landed on the branch as a no-op, whenever an earlier
 * exploratory command had been denied.
 */
function mergedTaskWorktreeCount(result: unknown): number {
	const runs = (result as { details?: { runs?: unknown } } | undefined)?.details?.runs;
	if (!Array.isArray(runs)) return 0;
	return runs.filter((run) => {
		const placement = (run as { placement?: { mode?: unknown; apply?: unknown; applied?: unknown } } | null)?.placement;
		return placement?.mode === "worktree" && placement.apply === "merge" && placement.applied === true;
	}).length;
}

function changedWorkspace(stats: HeadlessMainAgentReceiptStats): boolean {
	return stats.mutatingSucceeded > 0 || stats.mergedTaskWorktrees > 0;
}

function toolTotals(stats: Map<string, ToolCallStat>): { calls: number; succeeded: number; blocked: number } {
	const totals = { calls: 0, succeeded: 0, blocked: 0 };
	for (const stat of stats.values()) {
		totals.calls += stat.count;
		totals.succeeded += stat.ok;
		totals.blocked += stat.blocked;
	}
	return totals;
}

function noopFailureMessage(stats: HeadlessMainAgentReceiptStats, failOnNoop: boolean): string {
	const totals = toolTotals(stats.toolStats);
	const cause =
		stats.unresolvedBlocks.size > 0 && !changedWorkspace(stats)
			? `${totals.blocked} tool call${totals.blocked === 1 ? " was" : "s were"} blocked without recovery and no write succeeded`
			: `${totals.calls} tool call${totals.calls === 1 ? "" : "s"} ran and none succeeded`;
	return `clio-coder run: no-op${failOnNoop ? " under --fail-on-noop" : ""}: ${cause}`;
}

function sortedToolStats(stats: Map<string, ToolCallStat>): ToolCallStat[] {
	return [...stats.values()].sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

function countToolStats(stats: Map<string, ToolCallStat>): number {
	let count = 0;
	for (const stat of stats.values()) count += stat.count;
	return count;
}

function prefixHeadlessFailure(chat: ChatLoop, message: string): string {
	const snapshot = chat.lastRunSnapshot?.();
	if (!snapshot) return message;
	const url = snapshot.targetUrl ?? "endpoint unavailable";
	return `target '${snapshot.targetId}' (${snapshot.runtimeId} ${url}): ${headlessRouteFailureText(message) ?? message}`;
}

/**
 * The events `--json-events terminal` lets through, alongside the `turn_start`
 * and `turn_end` frames this mode synthesizes itself.
 *
 * The mode carries terminal accounting and the final answer on synthesized
 * `turn_end.text`. It omits prompts, thinking, and per-step progress, which
 * `--json-events full` carries. It never admits whole `message_end` frames:
 * those include injected reminders and intermediate content.
 *
 * `turn_end` is deliberately absent even though the mode emits one. The
 * synthesized frame carries `startedAt`, `endedAt`, `exitCode`, and `text`; the streamed
 * event of the same name carries the turn's assistant message instead. Letting
 * both through would put two different shapes behind one `type` on one stream.
 */
const TERMINAL_JSON_EVENT_TYPES = new Set(["agent_end", "notice"]);

function isMainAgentRunKind(value: string): value is RunKind {
	return value === "http" || value === "sdk" || value === "subprocess";
}

/**
 * Terminal accounting for one headless turn. `outcome`/`status` are resolved
 * from how the turn ended, not from the exit code alone: a turn the operator
 * interrupted is `canceled`/`interrupted`, never `failed`.
 */
interface HeadlessTerminalOutcome {
	exitCode: number;
	outcome: RunOutcome;
	status: RunStatus;
	failureMessage: string | null;
	/** Machine-readable receipt detail; absent means the failure message is the detail. */
	outcomeDetail?: string;
}

async function recordHeadlessMainAgentReceipt(input: {
	runId: string;
	chat: ChatLoop;
	task: string;
	startedAt: string;
	endedAt: string;
	terminal: HeadlessTerminalOutcome;
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
	const cost = aggregateCostAmounts(input.stats.costAmounts);
	const costProvenance =
		cost.calls === 0 || cost.hasUnknown
			? "unknown"
			: cost.hasEstimated
				? "estimated"
				: cost.allKnownFree
					? "known_free"
					: "known";
	const { exitCode, outcome, status } = input.terminal;
	const outcomeDetail = input.terminal.outcomeDetail ?? input.terminal.failureMessage;
	const outcomeCode = outcome === "failed" ? snapshot.outcomeCode : undefined;
	const ledger = openLedger();
	const envelope = ledger.create({
		id: input.runId,
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
		...(outcomeCode === undefined ? {} : { outcomeCode }),
		lineage,
		exitCode,
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
	const typedValidations = typedValidationFactsFromVerifyCalls(toolStats, input.stats.verifyCalls);
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
		...(outcomeCode === undefined ? {} : { outcomeCode }),
		lineage,
		// Host checks belong to this run, independently of any worker it dispatched.
		verification: deriveReceiptVerification({ toolStats, typedValidations }),
		routingIntent: {
			posture: "manual",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: createRunReceiptQuality({ runtimeEnforceable: false, enforcementPassed: null, typedValidations }),
		costProvenance,
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		exitCode,
		...(input.terminal.failureMessage !== null ? { failureMessage: input.terminal.failureMessage } : {}),
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
		clioCoderVersion: readClioVersion(),
		piMonoVersion: readPiMonoVersion(),
		platform: process.platform,
		nodeVersion: process.version,
		toolCalls: countToolStats(input.stats.toolStats),
		toolStats,
		skillActivations: input.stats.skillActivations,
		autonomy: snapshot.autonomy,
		// Sealed on every main-agent receipt, flag or no flag, so a driver can
		// apply its own no-op rule to a run that exited 0.
		safety: {
			decisions: { ...input.stats.decisions },
			blockedAttempts: [...input.stats.blockedAttempts],
			...(input.stats.blockedAttemptsTruncated > 0
				? { blockedAttemptsTruncated: input.stats.blockedAttemptsTruncated }
				: {}),
		},
		noop: headlessNoop(input.stats),
		...(snapshot.runtimeResolution ? { runtimeResolution: snapshot.runtimeResolution } : {}),
		sessionId: snapshot.sessionId ?? input.chat.getSessionId(),
	};
	ledger.recordReceipt(envelope.id, receipt);
	await ledger.persist();
}

function defaultShutdownHooks(): HeadlessShutdownHooks {
	const coordinator = getTerminationCoordinator();
	return {
		onDrain: (hook) => coordinator.onDrain(hook),
		getExitCode: () => coordinator.getExitCode(),
		isShuttingDown: () => coordinator.getPhase() !== "idle",
	};
}

export async function runHeadlessMainAgent(chat: ChatLoop, options: HeadlessMainAgentOptions): Promise<number> {
	// Children need the authoritative parent before submit can invoke dispatch.
	// The terminal writer reuses this identity whichever settlement path wins.
	const runId = newRunId();
	const mode = options.mode ?? "text";
	const jsonEvents = options.jsonEvents ?? "full";
	const startedAt = new Date().toISOString();
	let result: HeadlessMainAgentResult = {
		outputExhausted: false,
		text: "",
		error: null,
		sawTerminatingToolResult: false,
		terminatingToolText: "",
		abortReason: null,
		lastNotice: null,
		admissionRefused: false,
	};
	const receiptStats: HeadlessMainAgentReceiptStats = {
		toolStats: new Map<string, ToolCallStat>(),
		pendingCapabilities: new Map(),
		pendingVerifyCalls: new Map(),
		verifyCalls: [],
		skillActivations: [],
		usage: null,
		costAmounts: [],
		decisions: { allowed: 0, blocked: 0, permissionRequested: 0 },
		blockedAttempts: [],
		blockedAttemptsTruncated: 0,
		mutatingSucceeded: 0,
		mergedTaskWorktrees: 0,
		unresolvedBlocks: new Set<string>(),
	};
	// The receipt is this run's accounting, so it has to exist on the costly
	// failure paths too. Two callers can reach it: the turn's own completion
	// path, and the coordinated shutdown a SIGINT/SIGTERM starts. The signal
	// handler exits the process from inside shutdown, strictly before the
	// awaited submit resumes, so an interrupted run seals here in the drain
	// phase instead of losing the whole run's usage. Whichever caller arrives
	// first seals; the other awaits that same seal.
	let sealed: Promise<void> | null = null;
	const sealReceipt = (terminal: HeadlessTerminalOutcome): Promise<void> => {
		if (sealed !== null) return sealed;
		const endedAt = new Date().toISOString();
		sealed = recordHeadlessMainAgentReceipt({
			runId,
			chat,
			task: options.prompt,
			startedAt,
			endedAt,
			terminal,
			stats: receiptStats,
		}).catch((error: unknown) => {
			process.stderr.write(
				`clio-coder run: receipt write failed: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		});
		return sealed;
	};
	const termination = options.shutdown ?? defaultShutdownHooks();
	// A shutdown that aborts the turn also resolves the awaited submit, so the
	// completion path and this hook race. Interruption is a fact both read from
	// the coordinator rather than a winner of that race: whichever seals first
	// seals the same canceled outcome.
	const interruptedTerminal = (): HeadlessTerminalOutcome =>
		options.deadline?.expired() === true
			? {
					exitCode: termination.getExitCode(),
					outcome: "timed_out",
					// The status a dispatched worker's timed_out receipt seals with.
					// Orphan recovery re-derives the status from the outcome with
					// this same mapping when it re-verifies a receipt.
					status: runStatusForOutcome("timed_out"),
					failureMessage: `clio-coder run: timed out after ${options.deadline.seconds}s (--timeout)`,
				}
			: {
					exitCode: termination.getExitCode(),
					outcome: "canceled",
					status: "interrupted",
					failureMessage: result.abortReason ?? "clio-coder run: interrupted before the turn completed",
				};
	// Registered after the composition root's chat drain hook, which disposes
	// the loop and awaits settlement, so the stats folded below are final by
	// the time this runs.
	termination.onDrain(async () => {
		await sealReceipt(interruptedTerminal());
	});

	// Fresh sessions acquire their identity during submit, after admission notices
	// and terminal turn_start can arrive. Keep those frames behind their header.
	const pendingJsonFrames: RunJsonMainFrame[] = [];
	let jsonHeaderWritten = false;
	const writeMainFrame = (frame: RunJsonMainFrame): void => {
		if (!jsonHeaderWritten) pendingJsonFrames.push(frame);
		else writeFrame(frame);
	};
	const writeJsonHeader = (allowFallback: boolean, allowPending = false): void => {
		if (jsonHeaderWritten) return;
		const header = options.getSessionHeader?.();
		if (header !== undefined && header !== null) {
			writeFrame(header);
		} else {
			if (!allowFallback) return;
			const sessionId = chat.getSessionId();
			if (sessionId === null) {
				if (!allowPending || pendingJsonFrames.length === 0) return;
				writeFrame({
					type: "session",
					schemaVersion: RUN_JSON_SCHEMA_VERSION,
					mode: "main",
					id: null,
					pending: true,
					timestamp: startedAt,
					cwd: process.cwd(),
				});
			} else {
				writeFrame({
					type: "session",
					schemaVersion: RUN_JSON_SCHEMA_VERSION,
					mode: "main",
					id: sessionId,
					timestamp: startedAt,
					cwd: process.cwd(),
				});
			}
		}
		jsonHeaderWritten = true;
		for (const frame of pendingJsonFrames) writeFrame(frame);
		pendingJsonFrames.length = 0;
	};
	let terminalTurnStartWritten = false;
	const writeTerminalTurnStart = (): void => {
		if (terminalTurnStartWritten) return;
		terminalTurnStartWritten = true;
		writeJsonHeader(true);
		writeMainFrame({ type: "turn_start", startedAt });
	};
	// A text-mode run has no `session` event, so the id a later `--session`
	// would name is written to stderr the moment it exists. Stdout stays the
	// assistant's answer alone.
	let textSessionIdWritten = false;
	const writeTextSessionId = (): void => {
		if (textSessionIdWritten || mode !== "text") return;
		const sessionId = chat.getSessionId();
		if (sessionId === null) return;
		textSessionIdWritten = true;
		process.stderr.write(`clio-coder run: session ${sessionId}\n`);
	};
	const jsonProjector = createHeadlessJsonProjector();
	const unsubscribe = chat.onEvent((event) => {
		writeTextSessionId();
		if (mode === "json") {
			const frames = jsonProjector.project(event);
			if (jsonEvents === "terminal") {
				writeTerminalTurnStart();
				writeJsonHeader(true);
				if (TERMINAL_JSON_EVENT_TYPES.has(event.type)) {
					for (const frame of frames) writeMainFrame(frame);
				}
			} else {
				writeJsonHeader(true);
				for (const frame of frames) writeMainFrame(frame);
			}
		}
		if (mode === "text" && event.type === "notice" && event.surface === "transcript") {
			process.stderr.write(`clio-coder run: ${event.text}\n`);
		}
		recordToolEnd(receiptStats, event);
		if (event.type === "message_end") {
			// Usage is accrued per completed assistant message, the one place a
			// token count appears exactly once. Accruing at `agent_end` instead
			// loses everything the process was told when a run is interrupted
			// mid-segment, and a headless turn spans several agent segments
			// (middleware nudges and finish-contract reprompts start new agent
			// runs), so nothing here may key on the last segment alone.
			const usageSummary = sumRunUsage([event.message]);
			if (usageSummary.hadUsage) {
				receiptStats.costAmounts.push({
					usd: usageSummary.costUsd,
					provenance: chat.lastRunSnapshot?.()?.costProvenance ?? "unknown",
				});
				receiptStats.usage = receiptStats.usage === null ? usageSummary : addRunUsage(receiptStats.usage, usageSummary);
			}
		}
		result = resultFromEvent(event, result);
	});

	const unsubscribeScopeNotices = options.scopeNotices?.((payload) => {
		const notice = readDispatchScopeNotice(payload);
		if (notice === null) return;
		if (mode === "json") {
			// The terminal stream carries only the events a driver reads at the end.
			if (jsonEvents === "terminal") return;
			writeJsonHeader(true);
			writeMainFrame({ type: "dispatch_scope_notice", ...notice });
			return;
		}
		process.stderr.write(`clio-coder run: ${notice.message}\n`);
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
			...(options.constraints ? { constraints: options.constraints } : {}),
			hostRun: { runId, lineage: { parentRunId: null, rootRunId: runId, depth: 0, attempt: 0 } },
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
		if (mode === "json") writeJsonHeader(true, true);
		if (cleanupSteer) {
			cleanupSteer();
		}
		unsubscribeScopeNotices?.();
		unsubscribe();
	}
	// Detached workers outlive the turn but not the process, so wait for them
	// while a deadline can still fire.
	const settlement: DispatchedRunsSettlement = options.dispatch
		? await settleDispatchedRuns(options.dispatch, runId, () => termination.isShuttingDown())
		: { live: [], undelivered: [] };
	if (mode === "json" && (settlement.live.length > 0 || settlement.undelivered.length > 0)) {
		writeJsonHeader(true);
		writeMainFrame({
			type: "dispatch_settlement",
			live: settlement.live.map(projectDispatchedRunOutcome),
			undelivered: settlement.undelivered.map(projectDispatchedRunOutcome),
		});
	}
	// The turn has settled. Nothing between here and the seal yields to a
	// timer, so a deadline that has not fired by now never will, and one that
	// did has already put the coordinator into shutdown, which the first branch
	// below reads.
	options.deadline?.settle();

	const endedAt = new Date().toISOString();
	let terminal: HeadlessTerminalOutcome = {
		exitCode: 0,
		outcome: "succeeded",
		status: "completed",
		failureMessage: null,
	};
	let stderrMessage: string | null = null;
	let stdoutMessage: string | null = null;
	if (termination.isShuttingDown()) {
		// The turn did not fail; a signal ended it. Both this path and the drain
		// hook read interruption from the coordinator, so whichever seals first
		// seals the same canceled outcome with the status the process exits with.
		terminal = interruptedTerminal();
		// The deadline timer reports expiry even if shutdown precedes chat boot.
		// Keep the receipt detail, but emit that diagnostic only at the timer.
		stderrMessage =
			settlement.live.length > 0
				? `clio-coder run: canceling ${settlement.live.length} dispatched run(s) still in flight: ${describeRuns(settlement.live)}`
				: null;
		if (options.deadline?.expired() !== true) {
			stderrMessage = [terminal.failureMessage, stderrMessage].filter(Boolean).join("\n") || null;
		}
	} else if (result.abortReason !== null) {
		// An interrupted turn never answered, no matter what partial text or
		// internal error the abort left behind: nonzero exit, abort reason. It
		// was canceled, not failed, and its receipt says so.
		terminal = { exitCode: 1, outcome: "canceled", status: "interrupted", failureMessage: result.abortReason };
		stderrMessage = result.abortReason;
	} else if (result.error) {
		const budgetCeiling = result.error.startsWith(`${SESSION_COST_CEILING_REASON}:`);
		terminal = {
			exitCode: budgetCeiling ? SESSION_COST_CEILING_EXIT_CODE : 1,
			outcome: "failed",
			status: "failed",
			failureMessage: result.error,
			...(budgetCeiling ? { outcomeDetail: SESSION_COST_CEILING_REASON } : {}),
		};
		// Text mode printed the refusal's notice as it arrived; saying it twice
		// reads as two failures.
		stderrMessage = mode === "text" && result.admissionRefused ? null : prefixHeadlessFailure(chat, result.error);
	} else if (result.outputExhausted && !result.sawTerminatingToolResult) {
		// The provider returned normally, but generation exhausted its budget.
		// Earlier chatter and partial prose cannot turn that terminal cause into
		// success. A later assistant message or terminating tool supersedes it.
		const failureMessage =
			"clio-coder run: output token limit reached (stopReason=length); generation incomplete. Consider resuming with a narrower task, lower reasoning effort, or a larger output budget.";
		terminal = { exitCode: 1, outcome: "failed", status: "failed", failureMessage };
		stderrMessage = failureMessage;
		if (mode === "text" && result.text.length > 0) stdoutMessage = result.text;
	} else if (result.text.length === 0 && !result.sawTerminatingToolResult) {
		const failureMessage = "clio-coder run: provider stream ended without an assistant response or terminal tool result";
		terminal = { exitCode: 1, outcome: "failed", status: "failed", failureMessage };
		stderrMessage = failureMessage;
	} else {
		// A normal provider stop does not erase an explicit limitation or a
		// block with no applied change. Judge settled tool outcomes, not prose
		// or the presence of a validation contract. Recovered failures may succeed.
		const limited = (receiptStats.toolStats.get(ToolNames.Limitation)?.ok ?? 0) > 0;
		const blockedWithoutChange = receiptStats.unresolvedBlocks.size > 0 && !changedWorkspace(receiptStats);
		if (limited || blockedWithoutChange || (options.failOnNoop === true && headlessNoop(receiptStats))) {
			const failureMessage = limited
				? "clio-coder run: the agent recorded an explicit limitation; the task is incomplete"
				: noopFailureMessage(receiptStats, options.failOnNoop === true);
			terminal = {
				exitCode: 1,
				outcome: "failed",
				status: "failed",
				failureMessage,
				outcomeDetail: limited ? "limitation" : "noop",
			};
			stderrMessage = failureMessage;
		}
		if (terminal.exitCode === 0 && settlement.undelivered.length > 0) {
			const failureMessage = `clio-coder run: ${settlement.undelivered.length} dispatched worker(s) did not deliver: ${describeRuns(settlement.undelivered)}`;
			terminal = {
				exitCode: 1,
				outcome: "failed",
				status: "failed",
				failureMessage,
				outcomeDetail: "dispatched_worker_failed",
			};
			stderrMessage = failureMessage;
		}
		if (mode === "text") {
			// A terminating tool ends the turn in place of an assistant message, so its
			// result is the answer and any assistant text before it is mid-workflow
			// chatter the model never offered as a reply. Printing that chatter instead
			// hands the operator a dangling "let me try..." for a turn that succeeded.
			stdoutMessage =
				result.sawTerminatingToolResult && result.terminatingToolText.length > 0
					? result.terminatingToolText
					: result.text.length > 0
						? result.text
						: null;
		}
	}
	const exitCode = terminal.exitCode;

	if (mode === "json" && jsonEvents === "terminal") {
		writeJsonHeader(true);
		writeMainFrame({
			type: "turn_end",
			startedAt,
			endedAt,
			exitCode,
			text: result.sawTerminatingToolResult ? result.terminatingToolText : result.text,
			...(terminal.failureMessage !== null ? { error: terminal.failureMessage } : {}),
		});
	}

	await sealReceipt(terminal);

	if (stderrMessage !== null) {
		process.stderr.write(`${stderrMessage}\n`);
	}
	if (stdoutMessage !== null) {
		writeRawStdout(`${stdoutMessage}\n`);
	}
	if (mode === "json") writeJsonHeader(true, true);
	await flushRawStdout();
	return exitCode;
}
