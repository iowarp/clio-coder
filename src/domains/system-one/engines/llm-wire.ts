import { trackCallFetch } from "../../../core/call-failure.js";
import { telemetryCallInContext } from "../../../core/telemetry/producer.js";
/**
 * How an LLM engine talks to a model: direct chat-completions HTTP for the
 * OpenAI-compatible runtimes, or an injected one-shot port for the runtimes
 * that have no such wire (subscription and CLI-backed ones).
 *
 * It is direct HTTP on purpose: a domain reaching the engine seam would add a
 * second Stage 0 reacher, so the request is built and read here through `probeJson`.
 */

import {
	isResponseSchemaRejection,
	responseFormatFor,
	responseSchemaDialectFor,
} from "../../../core/response-schema.js";
import type { LlmRequestUsage, OneShotPort } from "../../providers/one-shot.js";
import { LlmAdmissionRefused } from "../../providers/one-shot.js";
import { probeJson } from "../../providers/probe/http.js";
import type { RuntimeDescriptor } from "../../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../providers/types/target-descriptor.js";
import type { Prompt } from "./llm-batch.js";
import type { EngineHost } from "./shared.js";
import { errorText, resolveToken } from "./shared.js";

/** Ceiling for one HTTP request; the runner's deadline arrives as the abort signal and wins. */
const HTTP_CEILING_MS = 120_000;

/**
 * Runtimes read through `POST {base}/chat/completions`, with how each spells
 * its base. Everything else in this domain reaches a model through the one-shot
 * port or not at all.
 */
type BaseStyle = "v1" | { readonly fallback: string };

const CHAT_WIRES: Readonly<Record<string, BaseStyle>> = {
	llamacpp: "v1",
	litellm: "v1",
	vllm: "v1",
	sglang: "v1",
	lmstudio: "v1",
	lemonade: "v1",
	"openai-compat": "v1",
	openrouter: { fallback: "https://openrouter.ai/api/v1" },
	deepseek: { fallback: "https://api.deepseek.com" },
	groq: { fallback: "https://api.groq.com/openai/v1" },
};

/**
 * Turning thinking off, per runtime, because a reasoning model spends its
 * first tokens on reasoning and a one-token readout then reads nothing. The
 * spelling differs and a wrong one reads to the server as no preference: LM
 * Studio ignores `chat_template_kwargs` and reads `reasoning_effort` (measured
 * against dynamo on 2026-09-02, see `model-runtime-capabilities.ts`), and
 * llama.cpp, vLLM and SGLang read the template flag. A LiteLLM gateway may
 * front either, and a wrong spelling reads as no preference rather than an
 * error, so it sends both, and so does `openai-compat`, which can front any
 * server. Lemonade sends both for the same reason: it fronts llama.cpp and FLM,
 * and those read different spellings. Runtimes absent here get no extra field
 * rather than a guessed one.
 */
const THINKING_OFF: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
	lmstudio: { reasoning_effort: "none" },
	llamacpp: { chat_template_kwargs: { enable_thinking: false } },
	vllm: { chat_template_kwargs: { enable_thinking: false } },
	sglang: { chat_template_kwargs: { enable_thinking: false } },
	litellm: { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } },
	lemonade: { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } },
	"openai-compat": { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } },
	deepseek: { thinking: { type: "disabled" } },
};

const OPENROUTER_HEADERS = {
	"HTTP-Referer": "https://github.com/iowarp/clio-coder",
	"X-OpenRouter-Title": "Clio Coder",
	"X-OpenRouter-Categories": "cli-agent",
};

/** Whether the runtime answers chat completions directly. */
export function hasChatWire(runtimeId: string): boolean {
	return Object.hasOwn(CHAT_WIRES, runtimeId);
}

function stripSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** The chat base (the URL `/chat/completions` hangs off), or null when the target names no server. */
export function chatBaseUrl(runtimeId: string, target: TargetDescriptor): string | null {
	const style = CHAT_WIRES[runtimeId];
	if (style === undefined) return null;
	if (style !== "v1") return stripSlash(target.url ?? style.fallback);
	if (!target.url) return null;
	// A URL already naming the `/v1` mount point is the same server as its root.
	const root = stripSlash(target.url.replace(/^ws:/u, "http:").replace(/^wss:/u, "https:"));
	return `${root.endsWith("/v1") ? root.slice(0, -"/v1".length) : root}/v1`;
}

export interface ChannelUsage {
	readonly input: number;
	readonly output: number;
}

export interface Channel {
	readonly wire: "http" | "oneshot";
	/** One deterministic reply held to `schema`, with the identity the server reported for it. */
	batch(prompt: Prompt, schema: Record<string, unknown>, maxTokens: number): Promise<BatchReply>;
}

export interface AnsweredIdentity {
	/** The model name the server reported on this response. */
	readonly model: string;
	/** The server's fingerprint, where it sends one. */
	readonly fingerprint?: string;
}

export interface BatchReply {
	readonly text: string;
	readonly usage?: ChannelUsage;
	/** Null when the response names no model, so nothing can tie it to a measurement. */
	readonly answered: AnsweredIdentity | null;
}

export class ChatHttpError extends Error {
	constructor(
		message: string,
		readonly status: number | undefined,
		readonly body: string | undefined,
	) {
		super(message);
		this.name = "ChatHttpError";
	}
}

interface ChatCompletion {
	model?: unknown;
	system_fingerprint?: unknown;
	choices?: Array<{
		message?: { content?: unknown };
	}>;
	usage?: {
		prompt_tokens?: unknown;
		completion_tokens?: unknown;
		total_tokens?: unknown;
		prompt_tokens_details?: { cached_tokens?: unknown };
		completion_tokens_details?: { reasoning_tokens?: unknown };
	};
}

function usageOf(data: ChatCompletion): LlmRequestUsage | undefined {
	const input = data.usage?.prompt_tokens;
	const output = data.usage?.completion_tokens;
	if (typeof input !== "number" || !Number.isFinite(input) || input < 0) return undefined;
	if (typeof output !== "number" || !Number.isFinite(output) || output < 0) return undefined;
	const cached = data.usage?.prompt_tokens_details?.cached_tokens;
	const cacheRead = typeof cached === "number" && Number.isFinite(cached) ? Math.max(0, Math.min(cached, input)) : 0;
	const reasoning = data.usage?.completion_tokens_details?.reasoning_tokens;
	const total = data.usage?.total_tokens;
	return {
		providerReported: true,
		input: input - cacheRead,
		output,
		...(typeof cached === "number" && Number.isFinite(cached) ? { cacheRead } : {}),
		...(typeof reasoning === "number" && Number.isFinite(reasoning) ? { reasoning: Math.max(0, reasoning) } : {}),
		totalTokens: typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : input + output,
	};
}

function channelUsageOf(data: ChatCompletion): ChannelUsage | undefined {
	const usage = usageOf(data);
	return usage === undefined ? undefined : { input: usage.input + (usage.cacheRead ?? 0), output: usage.output };
}

function identityOf(data: ChatCompletion): AnsweredIdentity | null {
	const model = data.model;
	if (typeof model !== "string" || model.length === 0) return null;
	const fingerprint = data.system_fingerprint;
	return typeof fingerprint === "string" && fingerprint.length > 0 ? { model, fingerprint } : { model };
}

function contentOf(data: ChatCompletion): string {
	const content = data.choices?.[0]?.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.join("");
}

// A server that rejected `response_format` once will reject it again, so the
// verdict outlives the call and the engine instance.
const schemaRejections = new Set<string>();
// The same for the thinking switch on `openai-compat`, where the fields are a
// guess at an unknown server and a strict one refuses what it does not know.
const thinkingRejections = new Set<string>();

export interface HttpChannelInput {
	/** The engine this channel answers for. */
	readonly engine: string;
	readonly target: TargetDescriptor;
	readonly runtime: RuntimeDescriptor;
	readonly model: string;
	readonly baseUrl: string;
	readonly host: EngineHost;
	readonly signal: AbortSignal;
	readonly onAdmissionRefused?: (error: LlmAdmissionRefused) => void;
}

export function createHttpChannel(input: HttpChannelInput): Channel {
	const { target, runtime, model, baseUrl, host, signal } = input;
	const dialect = responseSchemaDialectFor(runtime.id);
	const rejectionKey = `${runtime.id}|${baseUrl}|${model}`;
	// One credential lookup per call, however many requests the call makes.
	let token: Promise<string | undefined> | null = null;

	async function post(body: Record<string, unknown>): Promise<ChatCompletion> {
		let recordUsage: Awaited<ReturnType<NonNullable<EngineHost["admitLlmRequest"]>>> | undefined;
		try {
			recordUsage = await host.admitLlmRequest?.({ engine: input.engine, targetId: target.id, model, signal });
		} catch (error) {
			if (error instanceof LlmAdmissionRefused) input.onAdmissionRefused?.(error);
			throw error;
		}
		const tracking = trackCallFetch();
		const request = async () => {
			// This wire bypasses the engine seam, so it marks its own auth and send for the call it runs in (#429).
			const call = telemetryCallInContext();
			call?.stage("auth", "start");
			token ??= resolveToken(host, target, runtime, signal);
			const bearer = await token;
			call?.stage("auth", "end");
			signal.throwIfAborted();
			const headers: Record<string, string> = {
				...(runtime.id === "openrouter" ? OPENROUTER_HEADERS : {}),
				...(target.auth?.headers ?? {}),
				"content-type": "application/json",
				...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
			};
			call?.stage("send", "start");
			return probeJson<ChatCompletion>({
				fetch: tracking.fetch,
				url: `${baseUrl}/chat/completions`,
				method: "POST",
				timeoutMs: HTTP_CEILING_MS,
				headers,
				body: JSON.stringify(body),
				signal,
				readErrorBody: true,
			});
		};
		const response = await (recordUsage?.withContext ? recordUsage.withContext(request) : request()).catch(
			(error: unknown) => {
				recordUsage?.(null, {
					callOutcome: signal.aborted ? "aborted" : "error",
					failure: tracking.failure(error, signal.aborted),
				});
				throw error;
			},
		);
		recordUsage?.(
			response.data ? (usageOf(response.data) ?? null) : null,
			response.ok
				? { callOutcome: "success" }
				: { callOutcome: signal.aborted ? "aborted" : "error", failure: tracking.failure(response.error, signal.aborted) },
		);
		if (!response.ok || !response.data) {
			const cause = response.errorBody === undefined ? "" : `: ${response.errorBody.replace(/\s+/gu, " ").slice(0, 300)}`;
			throw new ChatHttpError(
				`${runtime.id} chat failed: ${response.error ?? "unknown"}${cause}`,
				response.status,
				response.errorBody,
			);
		}
		return response.data;
	}

	async function postThinkingOff(body: Record<string, unknown>): Promise<ChatCompletion> {
		const extras = THINKING_OFF[runtime.id];
		if (extras === undefined || thinkingRejections.has(rejectionKey)) return post(body);
		try {
			return await post({ ...body, ...extras });
		} catch (error) {
			const refused = error instanceof ChatHttpError && (error.status === 400 || error.status === 422);
			if (runtime.id !== "openai-compat" || !refused) throw error;
			const data = await post(body);
			thinkingRejections.add(rejectionKey);
			return data;
		}
	}

	const messages = (prompt: Prompt) => [
		{ role: "system", content: prompt.system },
		{ role: "user", content: prompt.user },
	];

	async function postBound(base: Record<string, unknown>, schema: Record<string, unknown>): Promise<ChatCompletion> {
		const bound =
			dialect === null || schemaRejections.has(rejectionKey) ? null : responseFormatFor(dialect, schema, "answer");
		try {
			return await postThinkingOff(bound === null ? base : { ...base, response_format: bound });
		} catch (error) {
			// Native enforcement is an optimization, never a precondition: a server
			// that refuses the constrained request still answers the plain one.
			const rejected =
				bound !== null &&
				error instanceof ChatHttpError &&
				isResponseSchemaRejection(`HTTP ${error.status ?? ""} ${error.body ?? error.message}`);
			if (!rejected) throw error;
			schemaRejections.add(rejectionKey);
			return postThinkingOff(base);
		}
	}

	return {
		wire: "http",
		async batch(prompt, schema, maxTokens) {
			const data = await postBound({ model, messages: messages(prompt), max_tokens: maxTokens, temperature: 0 }, schema);
			const usage = channelUsageOf(data);
			return { text: contentOf(data), answered: identityOf(data), ...(usage ? { usage } : {}) };
		},
	};
}

export interface OneShotChannelInput {
	/** The engine this channel answers for. */
	readonly engine: string;
	readonly targetId: string;
	readonly model: string | null;
	readonly port: OneShotPort;
	readonly signal: AbortSignal;
	readonly onAdmissionRefused?: (error: LlmAdmissionRefused) => void;
}

export function createOneShotChannel(input: OneShotChannelInput): Channel {
	const { targetId, model, port, signal } = input;
	return {
		wire: "oneshot",
		async batch(prompt, schema, maxTokens) {
			try {
				const reply = await port({
					engine: input.engine,
					targetId,
					model,
					system: prompt.system,
					user: prompt.user,
					schema,
					maxTokens,
					signal,
				});
				return {
					text: reply.text,
					answered: reply.model === undefined ? null : { model: reply.model },
					...(reply.usage ? { usage: reply.usage } : {}),
				};
			} catch (error) {
				if (error instanceof LlmAdmissionRefused) {
					input.onAdmissionRefused?.(error);
					throw error;
				}
				throw new Error(`one-shot call failed: ${errorText(error)}`);
			}
		},
	};
}
