import type { Api, Model } from "@mariozechner/pi-ai";

import { probeHttp } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { stripTrailingSlash, synthLocalModel, withV1 } from "../common/local-synth.js";
import {
	detectModelMismatch,
	probeLlamaCppModelStatus,
	probeLlamaCppProps,
	probeOpenAIModels,
} from "../common/probe-helpers.js";

/**
 * Default capabilities for the unified llamacpp runtime. The descriptor
 * targets llama-server's `/v1/chat/completions` surface, which every modern
 * llama-server build exposes when `--jinja` is set. Specialized surfaces
 * (anthropic-messages, embeddings, rerank, raw completion + infill) live
 * behind hidden surface-specific descriptors that ship alongside this one;
 * users select them explicitly via `clio configure --list --all`.
 */
const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 8192,
	maxTokens: 4096,
};

function endpointUrl(endpoint: EndpointDescriptor): string | null {
	return endpoint.url ? stripTrailingSlash(endpoint.url) : null;
}

const llamacppRuntime: RuntimeDescriptor = {
	id: "llamacpp",
	displayName: "llama.cpp",
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
		const status = await probeLlamaCppModelStatus(base, endpoint, ctx);
		const result: ProbeResult = { ok: true };
		if (typeof health.latencyMs === "number") result.latencyMs = health.latencyMs;
		const discoveredCapabilities = {
			...(props.discoveredCapabilities ?? {}),
			...(status.discoveredCapabilities ?? {}),
		};
		if (Object.keys(discoveredCapabilities).length > 0) {
			result.discoveredCapabilities = discoveredCapabilities;
			if (status.modelId) result.capabilityModelId = status.modelId;
		}
		if (props.serverVersion) result.serverVersion = props.serverVersion;
		const note = await detectModelMismatch(base, endpoint, ctx);
		const notes = [...(status.notes ?? []), ...(note ? [note] : [])];
		if (notes.length > 0) result.notes = notes;
		return result;
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
};

export default llamacppRuntime;
