import { CLIO_MIN_CONTEXT_WINDOW, CLIO_MIN_MAX_OUTPUT_TOKENS } from "../../../../core/context-floor.js";
import type { Api, Model } from "../../../../engine/types.js";
import type { CapabilityFlags, ThinkingLevel } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeModelStatus, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import {
	foldLmStudioModels,
	greetLmStudio,
	type LmStudioCatalog,
	type LmStudioLoadedInstance,
	type LmStudioModelInfo,
	listLmStudioModels,
	lmStudioReasoningLevels,
	loadedContextLength,
	parseLmStudioV1Models,
	resolveLmStudioInstance,
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
	const parallel = instance?.config.parallel;
	if (typeof parallel === "number" && Number.isInteger(parallel) && parallel > 0) out.parallelSlots = parallel;
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

function probeFromCatalog(catalog: LmStudioCatalog, target: TargetDescriptor): ProbeResult {
	if (!catalog.ok) {
		return {
			ok: false,
			...(catalog.latencyMs !== undefined ? { latencyMs: catalog.latencyMs } : {}),
			error: catalog.error ?? "LM Studio model listing failed",
		};
	}
	const models = foldLmStudioModels(catalog.models);
	rememberReasoningOptions(target, models);
	const ids: string[] = [];
	const modelCapabilities: Record<string, Partial<CapabilityFlags>> = {};
	const modelStates: Record<string, ProbeModelStatus> = {};
	for (const model of models) {
		const levels = lmStudioReasoningLevels(model.reasoningOptions);
		const keyInstance = model.loadedInstances[0];
		modelCapabilities[model.key] = capabilities(model, keyInstance);
		modelStates[model.key] = statusFor(model, keyInstance, levels);
		for (const instance of model.loadedInstances) {
			if (!ids.includes(instance.id)) ids.push(instance.id);
			modelCapabilities[instance.id] = capabilities(model, instance);
			const instanceStatus = statusFor(model, instance, levels);
			modelStates[instance.id] = instanceStatus;
			const resolution = resolveLmStudioInstance(target, models, instance.id, configuredModel(target));
			instanceStatus.detail =
				resolution.peerTargets.length > 0
					? `loaded on ${target.id}; also loaded on ${resolution.peerTargets.join(", ")}`
					: `loaded on ${target.id}`;
		}
		if (model.loadedInstances.length === 0) {
			ids.push(model.key);
			const keyStatus = modelStates[model.key];
			if (keyStatus) keyStatus.detail = "not loaded (LM Studio will load it on first use)";
		}
	}
	const selected = resolveModel(models, configuredModel(target));
	const result: ProbeResult = {
		ok: true,
		discoveredCapabilities: { parallelSlots: 1 },
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
		result.discoveredCapabilities = { parallelSlots: 1, ...capabilities(selected.model, selected.instance) };
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
		`Surfaces: ${Object.values(result.surfaces ?? {}).join(", ")}`,
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
				clio?: {
					chatTemplateKwargsUnsupported?: boolean;
					lmstudioReasoningOptions?: ReadonlyArray<string>;
					lmstudioDefaultModel?: string;
				};
			}
		).clio;
		if (metadata) {
			metadata.chatTemplateKwargsUnsupported = true;
			if (target.defaultModel) metadata.lmstudioDefaultModel = target.defaultModel;
			const options = reasoningOptionsByTargetModel.get(reasoningOptionsKey(canonicalTarget, wireModelId));
			if (options) metadata.lmstudioReasoningOptions = options;
		}
		return model;
	},
};

export default lmstudioRuntime;
