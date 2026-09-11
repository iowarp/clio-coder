/**
 * One bounded-output warm through the eventual caller's engine request path.
 * Copies portable context, applies public Pi transforms and payload hooks,
 * and consumes the response without running tools or appending conversation.
 * Admission and lifecycle remain with the caller. A matching serialized
 * prefix is only a reuse candidate; the backend decides actual cache reuse.
 */

import type { Agent } from "@earendil-works/pi-agent-core";
import type { BackendCompletionTimings } from "../core/cache-telemetry.js";
import { streamSimple } from "./ai.js";
import { estimateInputTokensFromContext } from "./apis/output-budget.js";
import type { AgentMessage, AgentTool, EngineModel, Usage } from "./types.js";

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
	/** Admission bound on the engine's input estimate, after context selection. */
	maxInputTokens?: number;
	/** Public Pi preparation hooks of the eventual caller. No tools or agent loop are executed. */
	agent?: Pick<
		Agent,
		| "transformContext"
		| "convertToLlm"
		| "streamFunction"
		| "onPayload"
		| "onResponse"
		| "sessionId"
		| "thinkingBudgets"
		| "transport"
		| "maxRetryDelayMs"
	>;
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
	if (usage === null || typeof usage !== "object") return null;
	const record = usage as Usage;
	// Pi initializes missing usage to zero, including on aborted/error calls.
	// A warm with no observed tokens cannot be called a measured free request.
	return [record.input, record.output, record.cacheRead, record.cacheWrite, record.cost?.total].some(
		(value) => typeof value === "number" && Number.isFinite(value) && value > 0,
	)
		? record
		: null;
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
	// pi-agent-core maps `thinkingLevel: "off"` onto an absent `reasoning`; the
	// pre-warm has to make the same mapping or the thinking composition resolves
	// against a different level and the rendered template moves.
	const options: Record<string, unknown> = { maxTokens: PREWARM_MAX_TOKENS };
	// Narrow residency authority without changing prompt rendering. A warm may
	// not inherit the foreground turn's implicit load/unload authorization.
	const metadata = (input.model as EngineModel & { clioCoder?: Record<string, unknown> }).clioCoder;
	const model = metadata ? { ...input.model, clioCoder: { ...metadata, lifecycle: "user-managed" } } : input.model;
	if (metadata?.runtimeId === "llamacpp") {
		// A worker that disappeared after admission must not be JIT-loaded by
		// the pinned llama router. This query is independent of prompt bytes.
		options.fetch = (request: string | URL | Request, init?: RequestInit) => {
			const url = new URL(request instanceof Request ? request.url : request);
			url.searchParams.set("autoload", "false");
			return fetch(request instanceof Request ? new Request(url, request) : url, init);
		};
	}
	if (input.state.thinkingLevel !== "off") options.reasoning = input.state.thinkingLevel;
	if (input.apiKey !== undefined) options.apiKey = input.apiKey;
	if (input.signal !== undefined) options.signal = input.signal;
	if (input.agent) {
		for (const key of [
			"onPayload",
			"onResponse",
			"sessionId",
			"thinkingBudgets",
			"transport",
			"maxRetryDelayMs",
		] as const) {
			if (input.agent[key] !== undefined) options[key] = input.agent[key];
		}
	}

	const send = input.streamFn ?? input.agent?.streamFunction ?? streamSimple;
	const startedAt = performance.now();
	let firstDeltaAt: number | null = null;
	const elapsed = (): number => Math.round(Math.max(0, performance.now() - startedAt));
	const ttft = (): number | null => (firstDeltaAt === null ? null : Math.round(Math.max(0, firstDeltaAt - startedAt)));

	try {
		input.signal?.throwIfAborted();
		let messages: AgentMessage[] = [
			...structuredClone([...input.state.messages]),
			{ role: "user", content: [{ type: "text", text: PREWARM_USER_TEXT }], timestamp: Date.now() },
		];
		if (input.agent?.transformContext) messages = await input.agent.transformContext(messages, input.signal);
		const converted = input.agent
			? await input.agent.convertToLlm(messages)
			: messages.filter((message) => LLM_MESSAGE_ROLES.has(message.role));
		input.signal?.throwIfAborted();
		const context = {
			systemPrompt: input.state.systemPrompt,
			messages: converted,
			tools: [...input.state.tools],
		} as Parameters<typeof streamSimple>[1];
		if (input.maxInputTokens !== undefined && estimateInputTokensFromContext(context) > input.maxInputTokens) {
			throw new Error("pre-warm input estimate exceeds its token budget");
		}
		const events = await send(
			model,
			context as unknown as Parameters<typeof streamSimple>[1],
			options as unknown as Parameters<typeof streamSimple>[2],
		);
		for await (const event of events) {
			const hasDelta =
				event.type === "toolcall_start" ||
				((event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") &&
					event.delta.length > 0);
			if (firstDeltaAt === null && hasDelta) firstDeltaAt = performance.now();
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
