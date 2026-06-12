/**
 * Pure helpers over agent messages, tool policies, and session payload
 * shaping for the chat loop. Everything here is stateless: functions take
 * pi-ai `AgentMessage` values (or tool/usage records) and return derived
 * data. The stateful loop itself lives in chat-loop.ts.
 */

import { randomUUID } from "node:crypto";
import { settingsPath } from "../core/config.js";
import type { PendingSkillRequest, PendingSkillToolPolicy, SkillDeclaredToolPolicy } from "../core/skill-activation.js";
import { ToolNames } from "../core/tool-names.js";
import { canonicalJson, sha256 } from "../domains/prompts/hash.js";
import { toContextOverflowError } from "../domains/providers/errors.js";
import type { ResolvedRuntimeTarget } from "../domains/providers/index.js";
import { extractReasoningTokens } from "../domains/session/context-accounting.js";
import type { AgentMessage } from "../engine/types.js";
import { resolveAgentTools } from "../engine/worker-tools.js";
import type { AskUserToolPolicy, ToolInvokeOptions, ToolRegistry } from "../tools/registry.js";

/** Minimal structural view of the engine agent used by state-inspection helpers. */
export interface AgentStateView {
	state: { messages: AgentMessage[]; errorMessage?: unknown };
}

/** Minimal structural view of the chat-loop runtime used by tool-surface helpers. */
export interface RuntimeResolutionView {
	runtimeResolution: ResolvedRuntimeTarget;
}

export function notConfiguredNotice(): string {
	return `[Clio Coder] orchestrator not configured. Edit ${settingsPath()} (orchestrator.target + orchestrator.model) to enable chat.`;
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

export function noticeMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
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
		`First call read_skill for: ${allowed.join(", ")}. Only these pending skill names are allowed this turn. After read_skill succeeds, follow the loaded workflow.`,
	].join("\n");
}

/**
 * Hash of the serialized tool schemas the provider sees this turn. Stamped on
 * every persisted context snapshot so a cold backend cache can be traced to a
 * tool-surface change.
 */
export function toolSignatureFromState(tools: ReadonlyArray<unknown>): string {
	const schemas: Array<{ name: string; description: string; parameters: unknown }> = [];
	for (const tool of tools) {
		if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
		const record = tool as Record<string, unknown>;
		schemas.push({
			name: typeof record.name === "string" ? record.name : "",
			description: typeof record.description === "string" ? record.description : "",
			parameters: record.parameters ?? null,
		});
	}
	schemas.sort((a, b) => a.name.localeCompare(b.name));
	return sha256(canonicalJson(schemas));
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
		const usage = message.usage;
		if (!usage || typeof usage !== "object") continue;
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

export type BackendCacheVerdict = "hot" | "partial" | "cold" | "small";

/**
 * Classify one API call's provider-reported usage the same way
 * scripts/turn-report.mjs does, so the persisted ledger and the forensics
 * report can never disagree:
 *   hot      cacheRead > 0  and input < 2000   (prefix reused, prefill ≈ user text)
 *   partial  cacheRead > 0  and input >= 2000  (prefix reused up to a divergence point)
 *   cold     cacheRead == 0 and input >= 2000  (full re-prefill)
 *   small    cacheRead == 0 and input < 2000   (too small to judge)
 */
export function backendCacheVerdict(input: number, cacheRead: number): BackendCacheVerdict {
	if (cacheRead > 0) return input >= 2000 ? "partial" : "hot";
	return input >= 2000 ? "cold" : "small";
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
	for (const key of ["usage", "api", "provider", "model", "responseModel", "responseId", "diagnostics"]) {
		if (raw[key] !== undefined) payload[key] = raw[key];
	}
	if (failure) {
		payload.stopReason = failure.stopReason;
		payload.errorMessage = failure.errorMessage;
	} else {
		const stopReason = raw.stopReason;
		if (stopReason !== undefined) payload.stopReason = stopReason;
		if (stopReason === "length") payload.contextExhaustion = lengthStopMetadata(message);
	}
	return payload;
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
			if (!item || item.type !== "text" || typeof item.text !== "string") return "";
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
	const truncation = recordValue(details?.truncation);
	return {
		bytes,
		truncated: size?.truncated === true || truncation?.truncated === true || text.includes("[tool result truncated]"),
		...(typeof size?.policy === "string" ? { policy: size.policy } : {}),
		...(typeof size?.followUpHint === "string" ? { followUpHint: size.followUpHint } : {}),
	};
}

export function runtimeSupportsTools(agentRuntime: RuntimeResolutionView): boolean {
	return agentRuntime.runtimeResolution.capabilityDecisions.tools === true;
}

/**
 * The session tool surface: the full registry when the provider supports
 * tools, nothing otherwise. Deterministic and identical on every submit so
 * the serialized tool schemas stay byte-stable for provider prefix caching.
 * Per-tool gating (pending-skill policy, safety) happens at invoke time.
 */
export function resolveSessionTools(
	agentRuntime: RuntimeResolutionView,
	toolRegistry: ToolRegistry | undefined,
	invokeOptions?: () => Partial<ToolInvokeOptions>,
): ReturnType<typeof resolveAgentTools> {
	if (!toolRegistry || !runtimeSupportsTools(agentRuntime)) return [];
	const input = { registry: toolRegistry };
	return resolveAgentTools(invokeOptions ? { ...input, invokeOptions } : input);
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
