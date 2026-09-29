/**
 * How an LLM engine talks to a model: direct chat-completions HTTP for the
 * OpenAI-compatible runtimes, or an injected one-shot port for the runtimes
 * that have no such wire (subscription and CLI-backed ones).
 *
 * It is direct HTTP on purpose. pi-ai drops logprobs from the stream it
 * parses, and a domain reaching the engine seam would add a second Stage 0
 * reacher, so the request is built and read here through `probeJson`.
 */

import { isResponseSchemaRejection, responseSchemaDialectFor } from "../../../core/response-schema.js";
import { probeJson } from "../../providers/probe/http.js";
import type { RuntimeDescriptor } from "../../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../providers/types/target-descriptor.js";
import type { OneShotPort } from "../factory.js";
import type { Prompt } from "./llm-prompt.js";
import { voteSchema } from "./llm-prompt.js";
import type { EngineHost } from "./shared.js";
import { errorText, resolveToken } from "./shared.js";

/** Ceiling for one HTTP request; the runner's deadline arrives as the abort signal and wins. */
const HTTP_CEILING_MS = 120_000;
/** A vote is one letter, but a target that reasons anyway needs room to reach it. */
export const VOTE_MAX_TOKENS = 128;
/** Sampling temperature for votes; the spread between votes is the whole signal. */
export const VOTE_TEMPERATURE = 0.7;
const TOP_LOGPROBS = 20;

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
 * error, so it sends both. Runtimes absent here get no extra field rather
 * than a guessed one.
 */
const THINKING_OFF: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
	lmstudio: { reasoning_effort: "none" },
	llamacpp: { chat_template_kwargs: { enable_thinking: false } },
	vllm: { chat_template_kwargs: { enable_thinking: false } },
	sglang: { chat_template_kwargs: { enable_thinking: false } },
	litellm: { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } },
	deepseek: { thinking: { type: "disabled" } },
};

const OPENROUTER_HEADERS = {
	"HTTP-Referer": "https://github.com/iowarp/clio-coder",
	"X-OpenRouter-Title": "Clio Coder",
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

export interface TokenLogprob {
	readonly token: string;
	readonly logprob: number;
}

export interface ChannelUsage {
	readonly input: number;
	readonly output: number;
}

export interface Channel {
	readonly wire: "http" | "oneshot";
	/** The first output token's alternatives, or null when the server sent no logprobs. */
	firstToken(prompt: Prompt): Promise<{ tokens: TokenLogprob[] | null; usage?: ChannelUsage }>;
	/** One sampled reply to the prompt, schema-bound where the runtime has a dialect. */
	vote(prompt: Prompt, labelCount: number): Promise<{ text: string; usage?: ChannelUsage }>;
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
	choices?: Array<{
		message?: { content?: unknown };
		logprobs?: {
			content?: Array<{ token?: unknown; logprob?: unknown; top_logprobs?: unknown }> | null;
		} | null;
	}>;
	usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

function usageOf(data: ChatCompletion): ChannelUsage | undefined {
	const input = data.usage?.prompt_tokens;
	const output = data.usage?.completion_tokens;
	return typeof input === "number" && typeof output === "number" ? { input, output } : undefined;
}

function tokenEntry(raw: unknown): TokenLogprob | null {
	if (typeof raw !== "object" || raw === null) return null;
	const row = raw as { token?: unknown; logprob?: unknown };
	return typeof row.token === "string" && typeof row.logprob === "number" && Number.isFinite(row.logprob)
		? { token: row.token, logprob: row.logprob }
		: null;
}

function firstTokenOf(data: ChatCompletion): TokenLogprob[] | null {
	const first = data.choices?.[0]?.logprobs?.content?.[0];
	if (first === undefined || first === null) return null;
	const out: TokenLogprob[] = [];
	if (Array.isArray(first.top_logprobs)) {
		for (const raw of first.top_logprobs) {
			const entry = tokenEntry(raw);
			if (entry !== null) out.push(entry);
		}
	}
	// The sampled token is normally repeated in the alternatives, and counting it
	// twice would inflate its mass. Servers asked for zero alternatives send it alone.
	const chosen = tokenEntry(first);
	if (chosen !== null && !out.some((entry) => entry.token === chosen.token)) out.push(chosen);
	return out.length > 0 ? out : null;
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

export interface HttpChannelInput {
	readonly target: TargetDescriptor;
	readonly runtime: RuntimeDescriptor;
	readonly model: string;
	readonly baseUrl: string;
	readonly host: EngineHost;
	readonly signal: AbortSignal;
}

export function createHttpChannel(input: HttpChannelInput): Channel {
	const { target, runtime, model, baseUrl, host, signal } = input;
	const extras = THINKING_OFF[runtime.id] ?? {};
	const dialect = responseSchemaDialectFor(runtime.id);
	const rejectionKey = `${runtime.id}|${baseUrl}|${model}`;
	// One credential lookup per call, however many requests the call makes.
	let token: Promise<string | undefined> | null = null;

	async function post(body: Record<string, unknown>): Promise<ChatCompletion> {
		token ??= resolveToken(host, target, runtime, signal);
		const bearer = await token;
		signal.throwIfAborted();
		const headers: Record<string, string> = {
			...(runtime.id === "openrouter" ? OPENROUTER_HEADERS : {}),
			...(target.auth?.headers ?? {}),
			"content-type": "application/json",
			...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
		};
		const response = await probeJson<ChatCompletion>({
			url: `${baseUrl}/chat/completions`,
			method: "POST",
			timeoutMs: HTTP_CEILING_MS,
			headers,
			body: JSON.stringify(body),
			signal,
			readErrorBody: true,
		});
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

	const messages = (prompt: Prompt) => [
		{ role: "system", content: prompt.system },
		{ role: "user", content: prompt.user },
	];

	return {
		wire: "http",
		async firstToken(prompt) {
			const data = await post({
				model,
				messages: messages(prompt),
				max_tokens: 1,
				temperature: 0,
				logprobs: true,
				top_logprobs: TOP_LOGPROBS,
				...extras,
			});
			const usage = usageOf(data);
			return { tokens: firstTokenOf(data), ...(usage ? { usage } : {}) };
		},
		async vote(prompt, labelCount) {
			const base = {
				model,
				messages: messages(prompt),
				max_tokens: VOTE_MAX_TOKENS,
				temperature: VOTE_TEMPERATURE,
				...extras,
			};
			const schema = voteSchema(labelCount);
			const bound =
				dialect === null || schemaRejections.has(rejectionKey)
					? null
					: dialect === "llamacpp-json-object"
						? { type: "json_object", schema }
						: { type: "json_schema", json_schema: { name: "answer", strict: true, schema } };
			let data: ChatCompletion;
			try {
				data = await post(bound === null ? base : { ...base, response_format: bound });
			} catch (error) {
				// Native enforcement is an optimization, never a precondition: a server
				// that refuses the constrained request still answers the plain one.
				const rejected =
					bound !== null &&
					error instanceof ChatHttpError &&
					isResponseSchemaRejection(`HTTP ${error.status ?? ""} ${error.body ?? error.message}`);
				if (!rejected) throw error;
				schemaRejections.add(rejectionKey);
				data = await post(base);
			}
			const usage = usageOf(data);
			return { text: contentOf(data), ...(usage ? { usage } : {}) };
		},
	};
}

export interface OneShotChannelInput {
	readonly targetId: string;
	readonly model: string | null;
	readonly port: OneShotPort;
	readonly signal: AbortSignal;
}

export function createOneShotChannel(input: OneShotChannelInput): Channel {
	const { targetId, model, port, signal } = input;
	return {
		wire: "oneshot",
		async firstToken() {
			// A port returns text, never token alternatives.
			return { tokens: null };
		},
		async vote(prompt, labelCount) {
			try {
				const reply = await port({
					targetId,
					model,
					system: prompt.system,
					user: prompt.user,
					schema: voteSchema(labelCount),
					maxTokens: VOTE_MAX_TOKENS,
					signal,
				});
				return { text: reply.text, ...(reply.usage ? { usage: reply.usage } : {}) };
			} catch (error) {
				throw new Error(`one-shot call failed: ${errorText(error)}`);
			}
		},
	};
}
