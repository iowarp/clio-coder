import type { Api, Model } from "@mariozechner/pi-ai";

import { createEngineAi } from "../../../../engine/ai.js";
import { mergeCapabilities } from "../../capabilities.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, RuntimeDescriptor } from "../../types/runtime-descriptor.js";

const engineAi = createEngineAi();

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: true,
	thinkingFormat: "openai-codex",
	vision: true,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 272000,
	maxTokens: 16384,
};

function fallbackModel(endpoint: EndpointDescriptor, wireModelId: string, caps: CapabilityFlags): Model<Api> {
	return {
		id: wireModelId,
		name: `${wireModelId} (${endpoint.id})`,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: endpoint.url ?? "https://chatgpt.com/backend-api",
		reasoning: caps.reasoning,
		input: caps.vision ? ["text", "image"] : ["text"],
		cost: {
			input: endpoint.pricing?.input ?? 0,
			output: endpoint.pricing?.output ?? 0,
			cacheRead: endpoint.pricing?.cacheRead ?? 0,
			cacheWrite: endpoint.pricing?.cacheWrite ?? 0,
		},
		contextWindow: caps.contextWindow,
		maxTokens: caps.maxTokens,
	} as Model<Api>;
}

const openaiCodexRuntime: RuntimeDescriptor = {
	id: "openai-codex",
	displayName: "OpenAI Codex",
	kind: "http",
	tier: "cloud",
	apiFamily: "openai-codex-responses",
	auth: "oauth",
	defaultCapabilities,
	async probeModels(_endpoint: EndpointDescriptor, _ctx: ProbeContext): Promise<string[]> {
		return engineAi.listModels("openai-codex").map((model) => model.id);
	},
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		const caps = mergeCapabilities(
			defaultCapabilities,
			kb?.entry.capabilities ?? null,
			null,
			endpoint.capabilities ?? null,
		);
		const builtin = engineAi.getModel("openai-codex", wireModelId) as Model<"openai-codex-responses"> | undefined;
		if (!builtin) {
			const model = fallbackModel(endpoint, wireModelId, caps);
			if (endpoint.auth?.headers) model.headers = endpoint.auth.headers;
			return model;
		}
		const pricing = endpoint.pricing;
		const headers =
			endpoint.auth?.headers !== undefined ? { ...(builtin.headers ?? {}), ...endpoint.auth.headers } : builtin.headers;
		const model: Model<"openai-codex-responses"> = {
			...builtin,
			id: wireModelId,
			name: `${wireModelId} (${endpoint.id})`,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: endpoint.url ?? builtin.baseUrl ?? "https://chatgpt.com/backend-api",
			reasoning: caps.reasoning,
			input: caps.vision ? (builtin.input.includes("image") ? builtin.input : ["text", "image"]) : ["text"],
			cost: {
				input: pricing?.input ?? builtin.cost.input ?? 0,
				output: pricing?.output ?? builtin.cost.output ?? 0,
				cacheRead: pricing?.cacheRead ?? builtin.cost.cacheRead ?? 0,
				cacheWrite: pricing?.cacheWrite ?? builtin.cost.cacheWrite ?? 0,
			},
			contextWindow: caps.contextWindow,
			maxTokens: caps.maxTokens,
		};
		if (headers) model.headers = headers;
		return model as Model<Api>;
	},
};

export default openaiCodexRuntime;
