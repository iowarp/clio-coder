import { CLIO_MIN_CONTEXT_WINDOW, CLIO_MIN_MAX_OUTPUT_TOKENS } from "../../../../core/context-floor.js";
import type { Api, Model } from "../../../../engine/types.js";
import type { CapabilityFlags, ThinkingLevel } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeModelStatus, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import {
	greetLmStudio,
	type LmStudioCatalog,
	type LmStudioLoadedInstance,
	type LmStudioModelInfo,
	listLmStudioModels,
	lmStudioReasoningLevels,
	loadedContextLength,
	parseLmStudioV1Models,
} from "../common/lmstudio-http.js";
import { synthLocalModel, withV1 } from "../common/local-synth.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	structuredOutputs: "json-schema",
	reasoning: true,
	vision: true,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: CLIO_MIN_CONTEXT_WINDOW,
	maxTokens: CLIO_MIN_MAX_OUTPUT_TOKENS,
};

const reasoningOptionsByTargetModel = new Map<string, ReadonlyArray<string>>();

function reasoningOptionsKey(target: TargetDescriptor, modelId: string): string {
	const url = (target.url ?? "").replace(/^ws:/u, "http:").replace(/^wss:/u, "https:").replace(/\/$/u, "");
	return `${target.id}|${url}|${modelId}`;
}

function rememberReasoningOptions(target: TargetDescriptor, models: ReadonlyArray<LmStudioModelInfo>): void {
	const prefix = reasoningOptionsKey(target, "");
	for (const key of reasoningOptionsByTargetModel.keys()) {
		if (key.startsWith(prefix)) reasoningOptionsByTargetModel.delete(key);
	}
	for (const model of models) {
		if (!model.reasoningOptions) continue;
		reasoningOptionsByTargetModel.set(reasoningOptionsKey(target, model.key), model.reasoningOptions);
		for (const instance of model.loadedInstances) {
			reasoningOptionsByTargetModel.set(reasoningOptionsKey(target, instance.id), model.reasoningOptions);
		}
	}
}

function configuredModel(target: TargetDescriptor): string | undefined {
	const id = target.defaultModel?.trim();
	return id && id.length > 0 ? id : undefined;
}

function resolveModel(
	models: ReadonlyArray<LmStudioModelInfo>,
	id: string | undefined,
): { model: LmStudioModelInfo; instance?: LmStudioLoadedInstance } | null {
	if (id) {
		for (const model of models) {
			if (model.key === id) return { model, ...(model.loadedInstances[0] ? { instance: model.loadedInstances[0] } : {}) };
			const instance = model.loadedInstances.find((entry) => entry.id === id);
			if (instance) return { model, instance };
		}
		return null;
	}
	const model = models.find((entry) => entry.loadedInstances.length > 0) ?? models[0];
	return model ? { model, ...(model.loadedInstances[0] ? { instance: model.loadedInstances[0] } : {}) } : null;
}

function capabilities(model: LmStudioModelInfo, instance?: LmStudioLoadedInstance): Partial<CapabilityFlags> {
	const out: Partial<CapabilityFlags> = {};
	if (model.vision !== undefined) out.vision = model.vision;
	if (model.tools !== undefined) out.tools = model.tools;
	if (model.reasoning !== undefined) out.reasoning = model.reasoning;
	else if (model.reasoningOptions !== undefined)
		out.reasoning = model.reasoningOptions.some((option) => option !== "off");
	const contextWindow = loadedContextLength(instance) ?? model.maxContextLength;
	if (contextWindow !== undefined) out.contextWindow = contextWindow;
	return out;
}

function statusFor(
	model: LmStudioModelInfo,
	instance: LmStudioLoadedInstance | undefined,
	reasoningLevels: ReadonlyArray<ThinkingLevel>,
): ProbeModelStatus {
	const status: ProbeModelStatus = {
		state: instance ? "loaded" : "unloaded",
		key: model.key,
		reasoningLevels,
	};
	if (instance) {
		status.instanceId = instance.id;
		status.loadConfig = instance.config;
		const contextLength = loadedContextLength(instance);
		if (contextLength !== undefined) status.contextLength = contextLength;
	}
	return status;
}

function foldModels(models: ReadonlyArray<LmStudioModelInfo>): LmStudioModelInfo[] {
	const byKey = new Map<string, LmStudioModelInfo>();
	for (const model of models) {
		const previous = byKey.get(model.key);
		if (!previous) {
			byKey.set(model.key, { ...model, loadedInstances: [...model.loadedInstances] });
			continue;
		}
		const knownIds = new Set(previous.loadedInstances.map((instance) => instance.id));
		for (const instance of model.loadedInstances) {
			if (!knownIds.has(instance.id)) previous.loadedInstances.push(instance);
		}
		if (previous.maxContextLength === undefined && model.maxContextLength !== undefined) {
			previous.maxContextLength = model.maxContextLength;
		}
		if (previous.vision === undefined && model.vision !== undefined) previous.vision = model.vision;
		if (previous.tools === undefined && model.tools !== undefined) previous.tools = model.tools;
		if (previous.reasoningOptions === undefined && model.reasoningOptions !== undefined) {
			previous.reasoningOptions = model.reasoningOptions;
		}
		if (previous.reasoning === undefined && model.reasoning !== undefined) previous.reasoning = model.reasoning;
	}
	return [...byKey.values()];
}

function probeFromCatalog(catalog: LmStudioCatalog, target: TargetDescriptor): ProbeResult {
	if (!catalog.ok) {
		return {
			ok: false,
			...(catalog.latencyMs !== undefined ? { latencyMs: catalog.latencyMs } : {}),
			error: catalog.error ?? "LM Studio model listing failed",
		};
	}
	const models = foldModels(catalog.models);
	rememberReasoningOptions(target, models);
	const ids: string[] = [];
	const modelCapabilities: Record<string, Partial<CapabilityFlags>> = {};
	const modelStates: Record<string, ProbeModelStatus> = {};
	for (const model of models) {
		const levels = lmStudioReasoningLevels(model.reasoningOptions);
		ids.push(model.key);
		const keyInstance = model.loadedInstances[0];
		modelCapabilities[model.key] = capabilities(model, keyInstance);
		modelStates[model.key] = statusFor(model, keyInstance, levels);
		for (const instance of model.loadedInstances) {
			if (!ids.includes(instance.id)) ids.push(instance.id);
			modelCapabilities[instance.id] = capabilities(model, instance);
			modelStates[instance.id] = statusFor(model, instance, levels);
		}
	}
	const selected = resolveModel(models, configuredModel(target));
	const result: ProbeResult = {
		ok: true,
		models: ids,
		modelCapabilities,
		modelStates,
		serverVersion:
			catalog.tier === "0.4+"
				? "LM Studio API 0.4+"
				: catalog.tier === "0.3.x"
					? "LM Studio API 0.3.x"
					: "LM Studio OpenAI-compatible API",
		surfaces: {
			openaiChat: "/v1/chat/completions",
			...(catalog.tier === "0.4+" ? { nativeV1: "/api/v1/models" } : {}),
			...(catalog.tier === "0.3.x" ? { nativeV0: "/api/v0/models" } : {}),
		},
	};
	if (catalog.latencyMs !== undefined) result.latencyMs = catalog.latencyMs;
	if (selected) {
		result.discoveredCapabilities = capabilities(selected.model, selected.instance);
		result.capabilityModelId = configuredModel(target) ?? selected.model.key;
	}
	const loaded = models.flatMap((model) =>
		model.loadedInstances.map((instance) => {
			const context = loadedContextLength(instance);
			return `${model.key} as ${instance.id}${context ? ` at ${context} tokens` : ""}`;
		}),
	);
	result.notes = [
		`LM Studio surface tier ${catalog.tier ?? "unknown"}`,
		...(loaded.length > 0 ? [`Loaded instances: ${loaded.join(", ")}`] : []),
	];
	return result;
}

export function probeResultFromV1Models(data: unknown, target: TargetDescriptor, latencyMs?: number): ProbeResult {
	const models = parseLmStudioV1Models(data);
	if (!models) return { ok: false, error: "LM Studio /api/v1/models response has no models array" };
	return probeFromCatalog({ ok: true, models, tier: "0.4+", ...(latencyMs !== undefined ? { latencyMs } : {}) }, target);
}

const lmstudioRuntime: RuntimeDescriptor = {
	id: "lmstudio",
	aliases: ["lmstudio-native"],
	displayName: "LM Studio",
	kind: "http",
	tier: "local-native",
	apiFamily: "openai-completions",
	auth: "api-key",
	defaultCapabilities,
	async probe(target, ctx): Promise<ProbeResult> {
		const [greeting, catalog] = await Promise.all([greetLmStudio(target, ctx), listLmStudioModels(target, ctx)]);
		if (!greeting.ok && catalog.tier !== "0.3.x") {
			return {
				ok: false,
				...(greeting.latencyMs !== undefined ? { latencyMs: greeting.latencyMs } : {}),
				error: `URL did not identify itself as LM Studio: ${greeting.error ?? "greeting missing"}`,
			};
		}
		return probeFromCatalog(catalog, target);
	},
	async probeModels(target: TargetDescriptor, ctx: ProbeContext): Promise<string[]> {
		const catalog = await listLmStudioModels(target, ctx);
		return probeFromCatalog(catalog, target).models ?? [];
	},
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		const canonicalTarget = target.runtime === "lmstudio" ? target : { ...target, runtime: "lmstudio" };
		const model = synthLocalModel({
			target: canonicalTarget,
			wireModelId,
			kb,
			defaultCapabilities,
			apiFamily: "openai-completions",
			provider: "lmstudio",
			baseUrlForTarget: (url) => withV1(url.replace(/^ws:/u, "http:").replace(/^wss:/u, "https:")),
		});
		const metadata = (
			model as Model<Api> & {
				clio?: { chatTemplateKwargsUnsupported?: boolean; lmstudioReasoningOptions?: ReadonlyArray<string> };
			}
		).clio;
		if (metadata) {
			metadata.chatTemplateKwargsUnsupported = true;
			const options = reasoningOptionsByTargetModel.get(reasoningOptionsKey(canonicalTarget, wireModelId));
			if (options) metadata.lmstudioReasoningOptions = options;
		}
		return model;
	},
};

export default lmstudioRuntime;
