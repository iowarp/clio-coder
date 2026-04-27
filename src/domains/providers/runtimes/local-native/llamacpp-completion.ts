import type { Api, Model } from "@mariozechner/pi-ai";

import { probeHttp } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { CompleteOptions, CompletionChunk, InfillOptions } from "../../types/inference.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { stripTrailingSlash, synthLocalModel, withV1 } from "../common/local-synth.js";
import { detectModelMismatch, probeLlamaCppProps, probeOpenAIModels } from "../common/probe-helpers.js";

const defaultCapabilities: CapabilityFlags = {
	chat: false,
	tools: false,
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: true,
	structuredOutputs: "gbnf",
	contextWindow: 8192,
	maxTokens: 4096,
};

function endpointUrl(endpoint: EndpointDescriptor): string | null {
	return endpoint.url ? stripTrailingSlash(endpoint.url) : null;
}

interface RawCompletionChunk {
	content?: unknown;
	stop?: unknown;
	stop_type?: unknown;
	tokens_predicted?: unknown;
	tokens_evaluated?: unknown;
}

function parseChunk(raw: RawCompletionChunk): CompletionChunk {
	const chunk: CompletionChunk = {
		content: typeof raw.content === "string" ? raw.content : "",
		stop: raw.stop === true,
	};
	if (raw.stop_type === "eos" || raw.stop_type === "limit" || raw.stop_type === "word" || raw.stop_type === "none") {
		chunk.stop_type = raw.stop_type;
	}
	if (typeof raw.tokens_predicted === "number") chunk.tokens_predicted = raw.tokens_predicted;
	if (typeof raw.tokens_evaluated === "number") chunk.tokens_evaluated = raw.tokens_evaluated;
	return chunk;
}

async function* streamSse(body: ReadableStream<Uint8Array>): AsyncGenerator<CompletionChunk> {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffered = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			// SSE events are separated by blank lines; individual `data:` lines may arrive
			// alone on streamed JSON emitted by llama.cpp.
			let nl = buffered.indexOf("\n");
			while (nl !== -1) {
				const line = buffered.slice(0, nl).trimEnd();
				buffered = buffered.slice(nl + 1);
				nl = buffered.indexOf("\n");
				if (line.length === 0) continue;
				const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
				if (payload.length === 0) continue;
				try {
					const parsed = JSON.parse(payload) as RawCompletionChunk;
					const chunk = parseChunk(parsed);
					yield chunk;
					if (chunk.stop) return;
				} catch {}
			}
		}
		const tail = buffered.trim();
		if (tail.length > 0) {
			const payload = tail.startsWith("data:") ? tail.slice(5).trim() : tail;
			try {
				const parsed = JSON.parse(payload) as RawCompletionChunk;
				yield parseChunk(parsed);
			} catch {}
		}
	} finally {
		reader.releaseLock();
	}
}

async function postStream(
	url: string,
	body: unknown,
	signal: AbortSignal | undefined,
): Promise<ReadableStream<Uint8Array>> {
	const init: RequestInit = {
		method: "POST",
		headers: { "content-type": "application/json", accept: "text/event-stream" },
		body: JSON.stringify(body),
	};
	if (signal) init.signal = signal;
	const response = await fetch(url, init);
	if (!response.ok || !response.body) {
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	return response.body;
}

function buildCompleteBody(opts: CompleteOptions): Record<string, unknown> {
	const body: Record<string, unknown> = { prompt: opts.prompt, stream: true };
	if (opts.n_predict !== undefined) body.n_predict = opts.n_predict;
	if (opts.stop && opts.stop.length > 0) body.stop = opts.stop;
	if (opts.grammar) body.grammar = opts.grammar;
	if (opts.json_schema) body.json_schema = opts.json_schema;
	if (opts.cache_prompt !== undefined) body.cache_prompt = opts.cache_prompt;
	return body;
}

function buildInfillBody(opts: InfillOptions): Record<string, unknown> {
	const body = buildCompleteBody(opts);
	body.input_prefix = opts.input_prefix;
	body.input_suffix = opts.input_suffix;
	if (opts.input_extra) body.input_extra = opts.input_extra;
	return body;
}

const llamacppCompletionRuntime: RuntimeDescriptor = {
	id: "llamacpp-completion",
	displayName: "llama.cpp (completion / infill)",
	kind: "http",
	tier: "local-native",
	apiFamily: "openai-completions",
	auth: "api-key",
	defaultCapabilities,
	async probe(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const base = endpointUrl(endpoint);
		if (!base) return { ok: false, error: "endpoint has no url" };
		const healthOpts = { url: `${base}/health`, timeoutMs: ctx.httpTimeoutMs } as const;
		const health = await (ctx.signal ? probeHttp({ ...healthOpts, signal: ctx.signal }) : probeHttp(healthOpts));
		if (!health.ok) return health;
		const props = await probeLlamaCppProps(base, ctx);
		const enriched: ProbeResult = { ...health };
		if (props.discoveredCapabilities) enriched.discoveredCapabilities = props.discoveredCapabilities;
		if (props.serverVersion) enriched.serverVersion = props.serverVersion;
		const note = await detectModelMismatch(base, endpoint, ctx);
		if (note) enriched.notes = [note];
		return enriched;
	},
	async probeModels(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<string[]> {
		const base = endpointUrl(endpoint);
		if (!base) return [];
		return probeOpenAIModels(base, ctx);
	},
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthLocalModel({
			endpoint,
			wireModelId,
			kb,
			defaultCapabilities,
			apiFamily: "openai-completions",
			provider: "llamacpp",
			baseUrlForEndpoint: withV1,
		});
	},
	async *complete(endpoint: EndpointDescriptor, opts: CompleteOptions): AsyncIterable<CompletionChunk> {
		const base = endpointUrl(endpoint);
		if (!base) throw new Error("endpoint has no url");
		const body = await postStream(`${base}/completion`, buildCompleteBody(opts), opts.signal);
		for await (const chunk of streamSse(body)) yield chunk;
	},
	async *infill(endpoint: EndpointDescriptor, opts: InfillOptions): AsyncIterable<CompletionChunk> {
		const base = endpointUrl(endpoint);
		if (!base) throw new Error("endpoint has no url");
		const body = await postStream(`${base}/infill`, buildInfillBody(opts), opts.signal);
		for await (const chunk of streamSse(body)) yield chunk;
	},
};

export default llamacppCompletionRuntime;
