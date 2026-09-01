/**
 * Pure helpers over agent messages, tool policies, and session payload
 * shaping for the chat loop. Everything here is stateless: functions take
 * pi-ai `AgentMessage` values (or tool/usage records) and return derived
 * data. The stateful loop itself lives in chat-loop.ts.
 */

import { randomUUID } from "node:crypto";
import {
	type BackendCacheVerdict,
	type BackendCompletionTimings,
	uncachedPrefillTokens,
} from "../core/cache-telemetry.js";
import { settingsPath } from "../core/config.js";
import {
	addResponseModelIdObservationCount,
	emptyResponseModelIdObservationCounts,
	type ResponseModelIdObservation,
	type ResponseModelIdObservationCounts,
	responseModelIdObservationFromRecord,
} from "../core/response-model-id.js";
import type { PendingSkillRequest, PendingSkillToolPolicy, SkillDeclaredToolPolicy } from "../core/skill-activation.js";
import { ToolNames } from "../core/tool-names.js";
import { sha256 } from "../domains/prompts/hash.js";
import { toContextOverflowError } from "../domains/providers/errors.js";
import type { ResolvedRuntimeTarget } from "../domains/providers/index.js";
import { ceilChars, extractReasoningTokens } from "../domains/session/context-accounting.js";
import type { AgentMessage } from "../engine/types.js";
import type { AskUserToolPolicy } from "../tools/registry.js";
import { attachedToolSchemaBytes, attachedToolSchemasFromState } from "./prompt-cache-identity.js";

/** Minimal structural view of the engine agent used by state-inspection helpers. */
export interface AgentStateView {
	state: { messages: AgentMessage[]; errorMessage?: unknown };
}

/** Minimal structural view of the chat-loop runtime used by tool-surface helpers. */
export interface RuntimeResolutionView {
	runtimeResolution: ResolvedRuntimeTarget;
}

export function notConfiguredNotice(): string {
	return [
		"[Clio Coder] orchestrator not configured. Set one up with:",
		"  clio-coder configure --id <id> --runtime <runtime> --url <url> --model <model> --set-orchestrator",
		"or, when targets already exist: clio-coder targets use <id> --model <model>",
		`(orchestrator.target + orchestrator.model live in ${settingsPath()})`,
	].join("\n");
}

export function extractText(message: AgentMessage | undefined): string {
	if (
		!message ||
		typeof message !== "object" ||
		message === null ||
		!("role" in message) ||
		message.role !== "assistant"
	) {
		return "";
	}
	const content = "content" in message && Array.isArray(message.content) ? message.content : [];
	return content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("");
}

export function extractUserText(message: AgentMessage | undefined): string {
	if (!message || typeof message !== "object" || message === null || !("role" in message) || message.role !== "user") {
		return "";
	}
	const content = "content" in message ? message.content : "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("");
}

export function extractThinking(message: AgentMessage | undefined): string {
	if (
		!message ||
		typeof message !== "object" ||
		message === null ||
		!("role" in message) ||
		message.role !== "assistant"
	) {
		return "";
	}
	const content = "content" in message && Array.isArray(message.content) ? message.content : [];
	return content
		.filter(
			(item): item is { type: "thinking"; thinking: string } =>
				item?.type === "thinking" && typeof item.thinking === "string",
		)
		.map((item) => item.thinking)
		.join("");
}

export interface TerminalAssistantFailure {
	stopReason: "error" | "aborted";
	errorMessage: string;
	message?: AgentMessage;
}

export function terminalFailureFromAssistantMessage(
	message: AgentMessage | undefined,
): TerminalAssistantFailure | null {
	if (
		!message ||
		typeof message !== "object" ||
		message === null ||
		!("role" in message) ||
		message.role !== "assistant"
	) {
		return null;
	}
	const stopReason = (message as { stopReason?: unknown }).stopReason;
	if (stopReason !== "error" && stopReason !== "aborted") return null;
	const rawError = (message as { errorMessage?: unknown }).errorMessage;
	const errorMessage =
		typeof rawError === "string" && rawError.length > 0
			? rawError
			: stopReason === "aborted"
				? "request aborted"
				: "model target returned an error";
	return { stopReason, errorMessage, message };
}

/**
 * An interrupted turn Clio wrote itself: aborted, carrying its own explanation
 * as text, with no provider error attached. `noticeMessage` produces exactly
 * this, and both the loop guard and an operator cancel persist it.
 *
 * Such a turn is aborted because that is what happened, and because the context
 * estimator skips usage on aborted turns. It is not a failure to render,
 * though. Both render paths synthesize a stand-in string when an aborted turn
 * carries no `errorMessage`, which put a red "[aborted] request aborted" line
 * under the cancellation notice on every resume, reintroducing on replay the
 * noise the live path suppresses.
 *
 * A genuine mid-stream abort keeps its line. pi-agent-core attaches
 * `errorMessage: "Request was aborted."` to those, and an aborted turn with no
 * text of its own still gets the synthesized stand-in.
 */
export function isSelfExplainingAbort(view: { stopReason: unknown; errorMessage: unknown; text: string }): boolean {
	if (view.stopReason !== "aborted") return false;
	if (typeof view.errorMessage === "string" && view.errorMessage.length > 0) return false;
	return view.text.trim().length > 0;
}

export function isLengthStopAssistantMessage(message: AgentMessage | undefined): boolean {
	return (
		!!message &&
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		message.role === "assistant" &&
		(message as { stopReason?: unknown }).stopReason === "length"
	);
}

/**
 * An aborted assistant message with no rendered content: empty text and no
 * structured tool call. This is what `agent.abort()` leaves behind when the
 * model is interrupted between deltas. The chat loop suppresses it after a
 * loop-guard interrupt has already written a durable closing turn.
 */
export function isEmptyAbortedAssistantMessage(message: AgentMessage | undefined): boolean {
	if (
		!message ||
		typeof message !== "object" ||
		message === null ||
		!("role" in message) ||
		message.role !== "assistant"
	) {
		return false;
	}
	if ((message as { stopReason?: unknown }).stopReason !== "aborted") return false;
	if (extractText(message).trim().length > 0) return false;
	return !hasStructuredToolCall(message);
}

function lengthStopMetadata(message: AgentMessage): Record<string, unknown> {
	const usage = (message as { usage?: unknown }).usage;
	const metadata: Record<string, unknown> = {
		kind: "provider_length_stop",
		stopReason: "length",
		message:
			"Model target hit its generation/output limit before a complete assistant response. This is not a safety denial; compacting helps only when the prompt and tool observations are also near the context window.",
	};
	if (usage && typeof usage === "object") {
		const u = usage as Record<string, unknown>;
		for (const [from, to] of [
			["input", "inputTokens"],
			["output", "outputTokens"],
			["totalTokens", "totalTokens"],
		] as const) {
			const value = u[from];
			if (typeof value === "number" && Number.isFinite(value)) metadata[to] = value;
		}
	}
	return metadata;
}

export function finalAssistantStopMessage(messages: ReadonlyArray<AgentMessage>): AgentMessage | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (
			!message ||
			typeof message !== "object" ||
			message === null ||
			!("role" in message) ||
			message.role !== "assistant"
		) {
			continue;
		}
		const stopReason = (message as { stopReason?: unknown }).stopReason;
		if (stopReason !== undefined && stopReason !== "stop") continue;
		return message;
	}
	return null;
}

export function hasStructuredToolCall(message: AgentMessage | undefined): boolean {
	if (!message || typeof message !== "object" || !("content" in message) || !Array.isArray(message.content))
		return false;
	return message.content.some((block) => block?.type === "toolCall");
}

export function toolNamesFromAgentState(tools: ReadonlyArray<unknown>): string[] {
	const names: string[] = [];
	for (const tool of tools) {
		if (!tool || typeof tool !== "object") continue;
		const name = (tool as { name?: unknown }).name;
		if (typeof name === "string" && name.trim().length > 0) names.push(name);
	}
	return names;
}

/**
 * The durable closing turn for an interrupted run, operator cancel and loop
 * guard alike.
 *
 * `stopReason` is `aborted` because that is what happened, and because the
 * engine's context estimator depends on it. `getLastAssistantUsageInfo` skips
 * assistant messages marked `aborted` or `error` before it dereferences
 * `usage`, which encodes the contract that an assistant turn either carries
 * usage or is marked as one of those two. This message carries no usage, so
 * labelling it `stop` walked it straight past that guard and
 * `calculateContextTokens` threw on `usage.totalTokens`.
 *
 * The process that did the cancelling never noticed, because it does not
 * re-read the record it just wrote. Any later reconstruction from disk did:
 * every turn in the resumed session failed in tens of milliseconds, before a
 * single network call, and went on failing until the session was abandoned.
 */
export function noticeMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "aborted",
		timestamp: Date.now(),
	} as AgentMessage;
}

/**
 * Render the pending-skill instruction that precedes the user's text in the
 * same user message. Plain visible text, persisted in the ledger: skill
 * requests are turn data, not prompt machinery.
 */
export function pendingSkillRequestPreamble(requests: ReadonlyArray<PendingSkillRequest>): string {
	const named = requests.filter((request) => request.name.trim().length > 0);
	if (named.length === 0) return "";
	const allowed = [...new Set(named.map((request) => request.name.trim()))];
	const lines = named.map((request) => {
		const status = request.installed ? "installed" : "not-installed";
		const args = request.args.trim();
		return `- ${request.name} (${status}, source=${request.source})${args.length > 0 ? ` — task: ${args}` : ""}`;
	});
	return [
		"[Skill request]",
		...lines,
		`First call context with scope="skills" and name for: ${allowed.join(", ")}. Only these pending skill names are allowed this turn. After the skill loads, follow the loaded workflow.`,
	].join("\n");
}

/**
 * Hash of the serialized tool schemas the provider sees this turn. Stamped on
 * every persisted context snapshot so a cold backend cache can be traced to a
 * tool-surface change.
 */
export function toolSignatureFromState(tools: ReadonlyArray<unknown>): string {
	return sha256(attachedToolSchemaBytes(attachedToolSchemasFromState(tools)));
}

/**
 * Built-in identity text used when `deps.prompts` is not wired (tests, degraded
 * boot). Production always overrides this via the prompts compiler; the
 * fallback exists so a chat-loop without a compiler still identifies as Clio.
 *
 * Kept short on purpose: small instruction-tuned models will copy the most
 * emphatic verbatim phrasing out of the system prompt into their replies. A
 * compact persona description lets the model speak naturally; the canonical
 * identity block lives in src/domains/prompts/fragments/identity/clio.md.
 */
export function fallbackIdentityPrompt(): string {
	return [
		"You are Clio, the coding agent in IOWarp's CLIO ecosystem of agentic science (NSF-funded, iowarp.ai).",
		"CLIO stands for Context Layer for Input/Output. Named after the Greek muse of history, you focus on HPC and scientific-software engineering.",
		"Whichever weights run you, your name and persona are Clio. You are not Claude, GPT, Qwen, Gemini, Llama, Mistral, or any other vendor's assistant.",
	].join(" ");
}

export function createPendingSkillToolPolicy(
	requests: ReadonlyArray<PendingSkillRequest>,
): PendingSkillToolPolicy | undefined {
	const allowedSkillNames = [
		...new Set(requests.map((request) => request.name.trim()).filter((name) => name.length > 0)),
	];
	if (allowedSkillNames.length === 0) return undefined;
	return {
		allowedSkillNames,
		requests: [...requests],
		loadedSkillNames: new Set<string>(),
		loadedSkillPolicies: new Map<string, SkillDeclaredToolPolicy>(),
	};
}

export function createAskUserToolPolicy(activeTools: ReadonlyArray<{ name: string }>): AskUserToolPolicy | undefined {
	if (!activeTools.some((tool) => tool.name === ToolNames.AskUser)) return undefined;
	const now = new Date().toISOString();
	return {
		id: randomUUID(),
		status: "idle",
		startedAt: now,
		updatedAt: now,
		exposure: "local",
		rounds: [],
		decisions: [],
		inFlight: false,
		cancelled: false,
		answerCount: 0,
		callCount: 0,
		maxCalls: 6,
		askedQuestionKeys: new Set<string>(),
	};
}

export interface RunUsageSummary {
	tokens: number;
	costUsd: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	apiCalls: number;
	hadReasoning: boolean;
	hadUsage: boolean;
	responseModelIdObservationCounts: ResponseModelIdObservationCounts;
	lastResponseModelIdObservation: ResponseModelIdObservation;
	lastDifferingResponseModelId: string | null;
}

/**
 * Sum per-call usage across every assistant message in a single agent run.
 * pi-ai emits one `AssistantMessage` per API call, each carrying its own
 * `Usage` object; a multi-turn tool-calling loop produces several assistant
 * messages. Earlier versions of this function walked the list from the tail
 * and returned the first match, which silently dropped every intermediate
 * API call from the cost tally. Summing instead matches what the provider
 * actually billed and keeps the `/cost` overlay and footer counters
 * aligned across tool-heavy runs.
 */
export function sumRunUsage(messages: ReadonlyArray<AgentMessage>): RunUsageSummary {
	const summary: RunUsageSummary = {
		tokens: 0,
		costUsd: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		apiCalls: 0,
		hadReasoning: false,
		hadUsage: false,
		responseModelIdObservationCounts: emptyResponseModelIdObservationCounts(),
		lastResponseModelIdObservation: { state: "not-observed" },
		lastDifferingResponseModelId: null,
	};
	for (const raw of messages) {
		const message = raw as
			| AgentMessage
			| {
					role?: unknown;
					usage?: {
						input?: unknown;
						output?: unknown;
						cacheRead?: unknown;
						cacheWrite?: unknown;
						totalTokens?: unknown;
						cost?: { total?: unknown };
					};
			  };
		if (!message || typeof message !== "object") continue;
		if (message.role !== "assistant") continue;
		const record = message as unknown as Record<string, unknown>;
		const usage = message.usage;
		if (!usage || typeof usage !== "object") continue;
		summary.lastResponseModelIdObservation = responseModelIdObservationFromRecord(record, "not-observed");
		addResponseModelIdObservationCount(summary.responseModelIdObservationCounts, summary.lastResponseModelIdObservation);
		summary.lastDifferingResponseModelId =
			typeof record.responseModel === "string" && record.responseModel.trim().length > 0
				? record.responseModel.trim()
				: null;
		summary.hadUsage = true;
		summary.apiCalls += 1;
		const input = typeof usage.input === "number" ? usage.input : 0;
		const output = typeof usage.output === "number" ? usage.output : 0;
		const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
		const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
		summary.input += input;
		summary.output += output;
		summary.cacheRead += cacheRead;
		summary.cacheWrite += cacheWrite;
		const reasoning = extractReasoningTokens(usage);
		if (reasoning !== null) {
			summary.reasoning += reasoning;
			summary.hadReasoning = true;
		}
		if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
			summary.tokens += usage.totalTokens;
		} else {
			summary.tokens += input + output + cacheRead + cacheWrite;
		}
		const total = usage.cost?.total;
		if (typeof total === "number") summary.costUsd += total;
	}
	return summary;
}

export type { BackendCacheVerdict } from "../core/cache-telemetry.js";

function classifyCacheUsage(input: number, cacheRead: number): BackendCacheVerdict {
	if (cacheRead > 0) return input >= 2000 ? "partial" : "hot";
	return input >= 2000 ? "cold" : "small";
}

/**
 * Classify one API call's provider-reported usage. When normalized provider
 * usage reports no cache read but the serving backend supplies cache_n, use
 * that direct observation instead. This is the single definition of a cache
 * verdict; the ledger, the overlay, and any forensics reader all consume the
 * persisted value rather than reclassifying:
 *   hot      cacheRead > 0  and input < 2000   (prefix reused, prefill ≈ user text)
 *   partial  cacheRead > 0  and input >= 2000  (prefix reused up to a divergence point)
 *   cold     cacheRead == 0 and input >= 2000  (full re-prefill)
 *   small    cacheRead == 0 and input < 2000   (too small to judge)
 */
export function backendCacheVerdict(
	input: number,
	cacheRead: number,
	backend?: BackendCompletionTimings | null,
): BackendCacheVerdict {
	if (cacheRead === 0 && backend?.cachedTokens !== null && backend?.cachedTokens !== undefined) {
		const backendInput = uncachedPrefillTokens(backend);
		if (backendInput !== null) return classifyCacheUsage(backendInput, backend.cachedTokens);
	}
	return classifyCacheUsage(input, cacheRead);
}

/** Per-API-call latency captured from the agent event stream (T3.2). */
export interface AssistantCallTiming {
	/** message_start → first assistant delta; null when no delta arrived. */
	ttftMs: number | null;
	/** message_start → message_end for the same assistant API call. */
	apiMs: number;
}

export function assistantSessionPayload(
	message: AgentMessage,
	failure: TerminalAssistantFailure | null,
): Record<string, unknown> {
	const text = extractText(message).trim();
	const thinking = extractThinking(message).trim();
	const payload: Record<string, unknown> = { text };
	const raw = message as unknown as Record<string, unknown>;
	if (Array.isArray(raw.content)) payload.content = raw.content;
	if (thinking.length > 0) payload.thinking = thinking;
	payload.responseModelIdObservation = responseModelIdObservationFromRecord(raw, "not-observed");
	for (const key of ["usage", "api", "provider", "model", "responseModel", "responseId", "diagnostics"]) {
		if (raw[key] !== undefined) payload[key] = raw[key];
	}
	if (failure && !isSelfExplainingAbort({ stopReason: raw.stopReason, errorMessage: raw.errorMessage, text })) {
		payload.stopReason = failure.stopReason;
		payload.errorMessage = failure.errorMessage;
	} else {
		const stopReason = raw.stopReason;
		if (stopReason !== undefined) payload.stopReason = stopReason;
		if (stopReason === "length") payload.contextExhaustion = lengthStopMetadata(message);
	}
	return payload;
}

/**
 * Usage for an interrupted assistant turn whose provider never reported any.
 *
 * A cancel lands a partial assistant message carrying the usage object the
 * stream was initialized with and never updated: all zeros, persisted next to
 * thousands of characters of streamed text, on a call whose prompt was paid for
 * the moment it was sent. The prompt side is known from the turn's own context
 * accounting and the output side from the text that actually arrived, so both
 * are recorded as estimates rather than as zero.
 *
 * `estimated: true` is the provenance marker: no surface may report these as
 * provider-reported numbers. The usage fold and the context estimator both skip
 * aborted turns already, so this never reaches `/cost` or the window math; it is
 * the record's own honesty about what the cancelled call cost.
 *
 * Returns null when the provider did report usage (there is nothing to fill in)
 * or when nothing streamed (an empty abort spent only the prompt, which the
 * caller's snapshot already carries).
 */
export function estimatedUsageForInterruptedTurn(
	message: AgentMessage,
	promptSideTokens: number,
): Record<string, unknown> | null {
	if ((message as { stopReason?: unknown }).stopReason !== "aborted") return null;
	const reported = (message as { usage?: Record<string, unknown> }).usage;
	if (reported && typeof reported === "object") {
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
			const value = reported[key];
			if (typeof value === "number" && value > 0) return null;
		}
	}
	const streamedChars = extractText(message).length + extractThinking(message).length;
	if (streamedChars === 0 && promptSideTokens <= 0) return null;
	const input = Math.max(0, Math.round(promptSideTokens));
	const output = streamedChars > 0 ? Math.max(1, ceilChars(streamedChars)) : 0;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		estimated: true,
	};
}

export function hasPersistableAssistantContent(
	payload: Record<string, unknown>,
	failure: TerminalAssistantFailure | null,
): boolean {
	if (failure) return true;
	if (payload.stopReason === "length") return true;
	if (typeof payload.text === "string" && payload.text.trim().length > 0) return true;
	if (typeof payload.thinking === "string" && payload.thinking.trim().length > 0) return true;
	if (Array.isArray(payload.content) && payload.content.length > 0) return true;
	return false;
}

export function recordValue(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function textFromToolResultContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const item = recordValue(block);
			if (item?.type !== "text" || typeof item?.text !== "string") return "";
			return item.text;
		})
		.join("");
}

export function toolResultSummary(result: unknown): Record<string, unknown> {
	const obj = recordValue(result);
	const text = textFromToolResultContent(obj?.content) || (typeof result === "string" ? result : "");
	const bytes = Buffer.byteLength(text, "utf8");
	const details = recordValue(obj?.details);
	const size = recordValue(details?.resultSize);
	const disposition = recordValue(details?.resultDisposition);
	const truncation = recordValue(details?.truncation);
	const observation = recordValue(details?.observation);
	const offloadPath =
		typeof disposition?.offloadPath === "string"
			? disposition.offloadPath
			: typeof observation?.offloadPath === "string"
				? observation.offloadPath
				: typeof size?.offloadPath === "string"
					? size.offloadPath
					: null;
	const displayedBytes =
		typeof disposition?.displayedBytes === "number" && Number.isFinite(disposition.displayedBytes)
			? disposition.displayedBytes
			: bytes;
	return {
		bytes: displayedBytes,
		truncated:
			disposition?.presentationTruncated === true ||
			size?.truncated === true ||
			truncation?.truncated === true ||
			observation?.truncated === true ||
			text.includes("[tool result truncated]"),
		...(typeof disposition?.capturedBytes === "number" ? { capturedBytes: disposition.capturedBytes } : {}),
		...(typeof disposition?.displayedBytes === "number" ? { displayedBytes: disposition.displayedBytes } : {}),
		...(typeof disposition?.contextBytes === "number" ? { contextBytes: disposition.contextBytes } : {}),
		...(disposition?.contextTruncated === true ? { contextTruncated: true } : {}),
		...(typeof size?.policy === "string" ? { policy: size.policy } : {}),
		...(typeof size?.followUpHint === "string" ? { followUpHint: size.followUpHint } : {}),
		...(offloadPath !== null ? { offloadPath } : {}),
		// Observation envelope counts (OBSERVE plane): unit, shown/total counts
		// and bytes, format, exact continuation, offload path. Persisted with
		// the turn so the ledger line renders identically live and on replay.
		...(observation !== null ? { observation } : {}),
	};
}

export function runtimeSupportsTools(agentRuntime: RuntimeResolutionView): boolean {
	return agentRuntime.runtimeResolution.capabilityDecisions.tools === true;
}

export function detectTerminalFailureFromState(agent: AgentStateView): TerminalAssistantFailure | null {
	const msgs = agent.state.messages;
	const tail = Array.isArray(msgs) ? msgs[msgs.length - 1] : undefined;
	const failure = terminalFailureFromAssistantMessage(tail);
	if (failure) return failure;
	return null;
}

/** Drop a trailing error/aborted assistant message so it never replays to the provider. */
export function pruneFailedAssistantFromContext(agent: AgentStateView): void {
	const messages = agent.state.messages;
	const tail = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
	if (!terminalFailureFromAssistantMessage(tail)) return;
	agent.state.messages = messages.slice(0, -1);
}

/**
 * Inspect the agent's state after `agent.prompt` resolves. pi-agent-core's
 * `handleRunFailure` records the upstream error on the assistant message
 * (stopReason="error", errorMessage="<text>") and on `state.errorMessage`,
 * then resolves the prompt() Promise normally. Returns a ContextOverflowError
 * when either surface matches the heuristic in src/domains/providers/errors.ts.
 */
export function detectOverflowFromState(agent: AgentStateView): ReturnType<typeof toContextOverflowError> {
	const direct = agent.state.errorMessage;
	if (typeof direct === "string" && direct.length > 0) {
		const match = toContextOverflowError(direct);
		if (match) return match;
	}
	const msgs = agent.state.messages;
	const tail = Array.isArray(msgs) ? msgs[msgs.length - 1] : undefined;
	if (tail && typeof tail === "object" && (tail as { stopReason?: unknown }).stopReason === "error") {
		const em = (tail as { errorMessage?: unknown }).errorMessage;
		if (typeof em === "string") {
			const match = toContextOverflowError(em);
			if (match) return match;
		}
	}
	return null;
}
