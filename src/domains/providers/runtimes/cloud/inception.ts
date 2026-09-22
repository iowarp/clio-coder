/**
 * Inception Mercury — diffusion LLMs (dLLMs). Mercury denoises whole blocks of
 * tokens in parallel rather than emitting them left to right, which is why it
 * is fast enough to sit in a latency-sensitive slot a frontier model cannot.
 *
 * Two surfaces are wired here:
 *   - chat, at `/v1/chat/completions`, OpenAI-compatible with tools and
 *     structured outputs, driven through the ordinary pi-ai transport.
 *   - fill-in-the-middle, at `/v1/fim/completions`, exposed through the
 *     existing `infill()` verb so callers reach it exactly as they reach
 *     llama.cpp's.
 *
 * `/v1/edit/completions` (Mercury Edit 2's next-edit prediction) is deliberately
 * not implemented: it needs a contract verb of its own and its context-tag
 * request format is not covered by the published reference.
 */

import type { Api, Model } from "../../../../engine/types.js";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { CompletionChunk, InfillOptions } from "../../types/inference.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

const INCEPTION_BASE_URL = "https://api.inceptionlabs.ai/v1";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	// Mercury accepts reasoning_effort, but its reasoning is not observable over
	// this API: at any effort above `instant` the response carries
	// `content: null` with `reasoning_summary: null`, and the streaming path
	// leaks a raw `<|think_end|>` token into the text. Nothing can be shown to
	// the operator, so the capability is declared false and the effort is
	// pinned below.
	reasoning: false,
	structuredOutputs: "json-schema",
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: true,
	// mercury-2.5's window. mercury-2 and mercury-edit-2 are 128k; the live
	// probe corrects per model, this is only the pre-probe placeholder.
	contextWindow: 260000,
	maxTokens: 65536,
};

interface InceptionModelsResponse {
	data?: Array<{ id?: unknown; name?: unknown; context_length?: unknown; max_output_length?: unknown }>;
}

interface RawTextCompletionChunk {
	choices?: Array<{ text?: unknown; finish_reason?: unknown }>;
	usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

function trimTrailingSlash(value: string): string {
	return value.endsWith("/") && value.length > 1 ? value.slice(0, -1) : value;
}

function targetBaseUrl(target: TargetDescriptor): string {
	return trimTrailingSlash(target.url ?? INCEPTION_BASE_URL);
}

function resolveKey(target: TargetDescriptor, ctx: ProbeContext): string | undefined {
	const envName = target.auth?.apiKeyEnvVar ?? "INCEPTION_API_KEY";
	if (ctx.authToken) return ctx.authToken;
	return ctx.credentialsPresent.has(envName) ? process.env[envName]?.trim() : undefined;
}

function authHeaders(target: TargetDescriptor, ctx: ProbeContext): Record<string, string> {
	const headers: Record<string, string> = { ...(target.auth?.headers ?? {}) };
	const key = resolveKey(target, ctx);
	if (key) headers.authorization = `Bearer ${key}`;
	return headers;
}

async function fetchModels(target: TargetDescriptor, ctx: ProbeContext, path: string): Promise<ProbeResult> {
	const opts = {
		url: `${targetBaseUrl(target)}${path}`,
		timeoutMs: ctx.httpTimeoutMs,
		headers: authHeaders(target, ctx),
	} as const;
	const result = await (ctx.signal
		? probeJson<InceptionModelsResponse>({ ...opts, signal: ctx.signal })
		: probeJson<InceptionModelsResponse>(opts));
	if (!result.ok) return result;
	const rows = result.data?.data ?? [];
	const models = rows
		.map((row) => (typeof row?.id === "string" ? row.id : null))
		.filter((id): id is string => id !== null);
	const out: ProbeResult = { ok: true, models };
	if (result.latencyMs !== undefined) out.latencyMs = result.latencyMs;

	const modelLabels: Record<string, string> = {};
	const modelCapabilities: Record<string, Partial<CapabilityFlags>> = {};
	for (const row of rows) {
		if (typeof row?.id !== "string") continue;
		if (typeof row.name === "string") modelLabels[row.id] = row.name;
		const caps: Partial<CapabilityFlags> = {};
		if (typeof row.context_length === "number") caps.contextWindow = row.context_length;
		if (typeof row.max_output_length === "number") caps.maxTokens = row.max_output_length;
		if (Object.keys(caps).length > 0) modelCapabilities[row.id] = caps;
	}
	if (Object.keys(modelLabels).length > 0) out.modelLabels = modelLabels;
	if (Object.keys(modelCapabilities).length > 0) out.modelCapabilities = modelCapabilities;

	const configured = target.defaultModel?.trim();
	if (configured && models.length > 0 && !models.includes(configured)) {
		out.ok = false;
		out.error = `configured model '${configured}' was not returned by Inception`;
	}
	return out;
}

/** Parse OpenAI `text_completion` SSE frames into the shared chunk shape. */
async function* streamTextCompletion(body: ReadableStream<Uint8Array>): AsyncGenerator<CompletionChunk> {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffered = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			let nl = buffered.indexOf("\n");
			while (nl !== -1) {
				const line = buffered.slice(0, nl).trimEnd();
				buffered = buffered.slice(nl + 1);
				nl = buffered.indexOf("\n");
				if (line.length === 0 || !line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (payload.length === 0) continue;
				if (payload === "[DONE]") {
					yield { content: "", stop: true, stop_type: "eos" };
					return;
				}
				let parsed: RawTextCompletionChunk;
				try {
					parsed = JSON.parse(payload) as RawTextCompletionChunk;
				} catch {
					continue;
				}
				const choice = parsed.choices?.[0];
				const content = typeof choice?.text === "string" ? choice.text : "";
				const finish = choice?.finish_reason;
				const stop = typeof finish === "string" && finish.length > 0;
				const chunk: CompletionChunk = { content, stop };
				if (stop) chunk.stop_type = finish === "length" ? "limit" : finish === "stop" ? "eos" : "none";
				const predicted = parsed.usage?.completion_tokens;
				const evaluated = parsed.usage?.prompt_tokens;
				if (typeof predicted === "number") chunk.tokens_predicted = predicted;
				if (typeof evaluated === "number") chunk.tokens_evaluated = evaluated;
				yield chunk;
				if (stop) return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

const inceptionRuntime: RuntimeDescriptor = {
	id: "inception",
	displayName: "Inception (Mercury dLLM)",
	kind: "http",
	tier: "cloud",
	apiFamily: "openai-completions",
	auth: "api-key",
	credentialsEnvVar: "INCEPTION_API_KEY",
	knownModels: ["mercury-2.5", "mercury-2", "mercury-edit-2"],
	defaultCapabilities,
	probe(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		return fetchModels(target, ctx, "/models");
	},
	async probeModels(target: TargetDescriptor, ctx: ProbeContext): Promise<string[]> {
		const result = await fetchModels(target, ctx, "/models");
		return result.ok && result.models ? [...result.models] : [];
	},
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeCatalogBackedModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities,
			runtimeId: "inception",
			api: "openai-completions",
			provider: "inception",
			defaultBaseUrl: INCEPTION_BASE_URL,
			compat: {
				// Inception accepts only assistant|function|system|tool|user, so a
				// system prompt sent as `developer` is rejected outright.
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
			},
			// Omitting reasoning_effort is not neutral: Mercury then reasons by
			// default and spends the whole token budget on hidden reasoning,
			// returning an empty completion with finish_reason "length". Pinning
			// `instant` is what makes a plain request answer at all.
			samplingParams: { reasoning_effort: "instant" },
		});
	},
	async *infill(target: TargetDescriptor, opts: InfillOptions, ctx: ProbeContext): AsyncIterable<CompletionChunk> {
		// FIM is served by the edit-tuned model, which is not the chat default.
		const model = target.defaultModel ?? "mercury-edit-2";
		const body: Record<string, unknown> = {
			model,
			prompt: opts.input_prefix,
			suffix: opts.input_suffix,
			stream: true,
		};
		if (opts.n_predict !== undefined) body.max_tokens = opts.n_predict;
		if (opts.stop && opts.stop.length > 0) body.stop = opts.stop;

		const init: RequestInit = {
			method: "POST",
			headers: { ...authHeaders(target, ctx), "content-type": "application/json", accept: "text/event-stream" },
			body: JSON.stringify(body),
		};
		const signal = opts.signal ?? ctx.signal;
		if (signal) init.signal = signal;
		const response = await fetch(`${targetBaseUrl(target)}/fim/completions`, init);
		if (!response.ok || !response.body) {
			throw new Error(`Inception FIM failed: HTTP ${response.status} ${response.statusText}`);
		}
		for await (const chunk of streamTextCompletion(response.body)) yield chunk;
	},
};

export default inceptionRuntime;
