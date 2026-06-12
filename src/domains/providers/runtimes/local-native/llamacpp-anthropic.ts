import type { Api, Model } from "@earendil-works/pi-ai";

import { probeHttp, probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import { stripTrailingSlash, synthLocalModel, withAsIs } from "../common/local-synth.js";
import { detectModelMismatch, probeLlamaCppProps } from "../common/probe-helpers.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "anthropic",
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: true,
	contextWindow: 8192,
	maxTokens: 4096,
};

interface OpenAIModelsResponse {
	data?: Array<{ id?: unknown }>;
}

function url(target: TargetDescriptor): string | null {
	return target.url ? stripTrailingSlash(target.url) : null;
}

const llamacppAnthropicRuntime: RuntimeDescriptor = {
	id: "llamacpp-anthropic",
	displayName: "llama.cpp (Anthropic-compat)",
	kind: "http",
	tier: "local-native",
	apiFamily: "anthropic-messages",
	auth: "api-key",
	defaultCapabilities,
	hidden: true,
	async probe(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const base = url(target);
		if (!base) return { ok: false, error: "target has no url" };
		const healthOpts = { url: `${base}/health`, timeoutMs: ctx.httpTimeoutMs } as const;
		const health = await (ctx.signal ? probeHttp({ ...healthOpts, signal: ctx.signal }) : probeHttp(healthOpts));
		if (!health.ok) return health;
		const headOpts = {
			url: `${base}/v1/messages`,
			method: "HEAD" as const,
			timeoutMs: ctx.httpTimeoutMs,
		};
		const head = await (ctx.signal ? probeHttp({ ...headOpts, signal: ctx.signal }) : probeHttp(headOpts));
		if (!head.ok) return head;
		const props = await probeLlamaCppProps(base, ctx);
		const enriched: ProbeResult = { ...head };
		if (props.discoveredCapabilities) enriched.discoveredCapabilities = props.discoveredCapabilities;
		if (props.serverVersion) enriched.serverVersion = props.serverVersion;
		const note = await detectModelMismatch(base, target, ctx);
		if (note) enriched.notes = [note];
		return enriched;
	},
	async probeModels(target: TargetDescriptor, ctx: ProbeContext): Promise<string[]> {
		const base = url(target);
		if (!base) return [];
		const opts = { url: `${base}/v1/models`, timeoutMs: ctx.httpTimeoutMs } as const;
		const result = await (ctx.signal
			? probeJson<OpenAIModelsResponse>({ ...opts, signal: ctx.signal })
			: probeJson<OpenAIModelsResponse>(opts));
		if (!result.ok || !result.data?.data) return [];
		return result.data.data
			.map((row) => (typeof row?.id === "string" ? row.id : null))
			.filter((id): id is string => id !== null);
	},
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthLocalModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities,
			apiFamily: "anthropic-messages",
			provider: "llamacpp",
			baseUrlForTarget: withAsIs,
		});
	},
};

export default llamacppAnthropicRuntime;
