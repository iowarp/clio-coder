/**
 * The session pre-warm round: the request the next turn would send, minus the
 * operator's text, issued as soon as the prefix is known.
 *
 * On a local server prefill is the cost. A fresh session's first turn prefills
 * the whole compiled prompt plus the tool schemas before the model emits a
 * token, and a resumed session's first turn prefills the entire replayed
 * history. Both are paid after the operator presses Enter, and both are fully
 * determined before they type anything. llama.cpp picks the slot with the
 * longest common prefix and re-evaluates only the suffix, so sending the prefix
 * early leaves the processed KV in the slot for the real turn to land on.
 *
 * The payload is not hand-assembled. It goes through `streamSimple`, the same
 * dispatcher `createEngineAgent` hands pi-agent-core as its `streamFn`, with the
 * same system prompt, the same tool schemas, the same replayed messages, and the
 * same thinking level, so `withSamplingOverrides`, the thinking composition, and
 * `cache_prompt` resolve exactly as they do for a turn. Any byte that differs
 * ahead of the user turn would defeat the purpose.
 */

import type { BackendCompletionTimings } from "../core/cache-telemetry.js";
import { streamSimple } from "../engine/ai.js";
import type { AgentMessage, AgentTool, EngineModel, Usage } from "../engine/types.js";

/**
 * The one user message appended so the chat template renders the prefix up to
 * the user turn. One character: it has to exist for the template to close the
 * prefix, and everything after the last shared byte is re-evaluated by the real
 * turn anyway.
 */
export const PREWARM_USER_TEXT = ".";

/** Output budget for the round. The tokens the model produces are not the point. */
export const PREWARM_MAX_TOKENS = 1;

/** Which trigger asked for the pre-warm. Recorded on the ledger entry. */
export type PrewarmTrigger = "session-start" | "resume" | "compaction";

export interface PrewarmContext {
	systemPrompt: string;
	messages: ReadonlyArray<AgentMessage>;
	tools: ReadonlyArray<AgentTool>;
}

/**
 * The roles pi-agent-core's default `convertToLlm` keeps when it turns the
 * agent's message list into provider messages. The pre-warm applies the same
 * filter so its message array is the one a turn would send, not the agent's
 * internal list.
 */
const LLM_MESSAGE_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "toolResult"]);

/**
 * The prefix of the next turn's request: system prompt, tool schemas, and the
 * replayed conversation, with no user turn yet.
 */
function prewarmPrefix(state: {
	systemPrompt: string;
	messages: ReadonlyArray<AgentMessage>;
	tools: ReadonlyArray<AgentTool>;
}): PrewarmContext {
	return {
		systemPrompt: state.systemPrompt,
		messages: state.messages.filter((message) => LLM_MESSAGE_ROLES.has((message as { role?: string }).role ?? "")),
		tools: [...state.tools],
	};
}

export interface PrewarmRoundInput {
	model: EngineModel;
	/** Live agent state the next turn would send. Read-only; the round copies it. */
	state: {
		systemPrompt: string;
		messages: ReadonlyArray<AgentMessage>;
		tools: ReadonlyArray<AgentTool>;
		thinkingLevel: string;
	};
	apiKey?: string;
	signal?: AbortSignal;
	/** Test seam. Production uses the engine dispatcher a turn runs on. */
	streamFn?: typeof streamSimple;
}

export interface PrewarmRoundResult {
	/** True when the operator submitted (or the session moved) before the round settled. */
	aborted: boolean;
	/** Provider usage for the round; null when the backend reported none. */
	usage: Usage | null;
	/** Backend prefill and prediction timings when the server reported them. */
	backend: BackendCompletionTimings | null;
	/** Wall clock the round spent, in the shape a turn's assistant entry uses. */
	timing: { ttftMs: number | null; apiMs: number };
	/** Provider error text when the round failed outright. */
	errorMessage: string | null;
}

function usageOf(message: unknown): Usage | null {
	if (message === null || typeof message !== "object") return null;
	const usage = (message as { usage?: unknown }).usage;
	return usage !== null && typeof usage === "object" ? (usage as Usage) : null;
}

function backendOf(message: unknown): BackendCompletionTimings | null {
	if (message === null || typeof message !== "object") return null;
	const backend = (message as { backendTimings?: unknown }).backendTimings;
	return backend !== null && typeof backend === "object" ? (backend as BackendCompletionTimings) : null;
}

/**
 * Prompt tokens the backend actually processed for one pre-warm. The server's
 * own prompt count is authoritative when it reported one; otherwise the
 * provider usage prompt side, cached tokens folded in, is the honest figure.
 * Null when neither exists, which is different from a measured zero.
 */
export function prewarmPromptTokens(result: Pick<PrewarmRoundResult, "usage" | "backend">): number | null {
	if (result.backend) return result.backend.promptTokens;
	const usage = result.usage;
	if (!usage) return null;
	const total = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
	return total > 0 ? total : null;
}

/**
 * Send the prefix and wait for the backend to acknowledge it. Resolves rather
 * than rejects on a provider failure: a pre-warm is an optimization, and a
 * backend that refuses it must not be able to break the session it was warming.
 */
export async function runPrewarmRound(input: PrewarmRoundInput): Promise<PrewarmRoundResult> {
	const prefix = prewarmPrefix(input.state);
	const context = {
		systemPrompt: prefix.systemPrompt,
		messages: [
			...prefix.messages,
			{ role: "user", content: [{ type: "text", text: PREWARM_USER_TEXT }], timestamp: Date.now() },
		],
		tools: prefix.tools,
	};
	// pi-agent-core maps `thinkingLevel: "off"` onto an absent `reasoning`; the
	// pre-warm has to make the same mapping or the thinking composition resolves
	// against a different level and the rendered template moves.
	const options: Record<string, unknown> = { maxTokens: PREWARM_MAX_TOKENS };
	if (input.state.thinkingLevel !== "off") options.reasoning = input.state.thinkingLevel;
	if (input.apiKey !== undefined) options.apiKey = input.apiKey;
	if (input.signal !== undefined) options.signal = input.signal;

	const send = input.streamFn ?? streamSimple;
	const startedAt = performance.now();
	let firstDeltaAt: number | null = null;
	const elapsed = (): number => Math.round(Math.max(0, performance.now() - startedAt));
	const ttft = (): number | null => (firstDeltaAt === null ? null : Math.round(Math.max(0, firstDeltaAt - startedAt)));

	try {
		const events = send(
			input.model,
			context as unknown as Parameters<typeof streamSimple>[1],
			options as unknown as Parameters<typeof streamSimple>[2],
		);
		for await (const event of events) {
			if (firstDeltaAt === null && event.type !== "start") firstDeltaAt = performance.now();
			if (event.type === "done") {
				return {
					aborted: false,
					usage: usageOf(event.message),
					backend: backendOf(event.message),
					timing: { ttftMs: ttft(), apiMs: elapsed() },
					errorMessage: null,
				};
			}
			if (event.type === "error") {
				const failed = event.error as { stopReason?: unknown; errorMessage?: unknown };
				const aborted = event.reason === "aborted" || failed.stopReason === "aborted" || input.signal?.aborted === true;
				return {
					aborted,
					usage: usageOf(event.error),
					backend: backendOf(event.error),
					timing: { ttftMs: ttft(), apiMs: elapsed() },
					errorMessage: aborted ? null : typeof failed.errorMessage === "string" ? failed.errorMessage : "pre-warm failed",
				};
			}
		}
	} catch (error) {
		return {
			aborted: input.signal?.aborted === true,
			usage: null,
			backend: null,
			timing: { ttftMs: ttft(), apiMs: elapsed() },
			errorMessage: input.signal?.aborted === true ? null : error instanceof Error ? error.message : String(error),
		};
	}
	return {
		aborted: input.signal?.aborted === true,
		usage: null,
		backend: null,
		timing: { ttftMs: ttft(), apiMs: elapsed() },
		errorMessage: null,
	};
}
