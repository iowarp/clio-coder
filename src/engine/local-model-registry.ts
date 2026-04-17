/**
 * Side-registry of pi-ai Models registered for local inference engines
 * (llamacpp, lmstudio, ollama, openai-compat). Keyed by
 * `${providerId}\u0000${modelId}@${endpointName}`. Callers use
 * `getModel(providerId, "${modelId}@${endpointName}")` once the endpoint
 * has been registered via `registerLocalProviders` (boot) or had its model
 * list discovered via `registerDiscoveredLocalModels` (post live probe).
 *
 * Extracted from engine/ai.ts so the registration surface and the pi-ai
 * catalog wrapper can evolve independently.
 */

import type { Model } from "@mariozechner/pi-ai";
import type { EndpointSpec, LocalProvidersSettings, ThinkingFormat } from "../core/defaults.js";

const LOCAL_MODEL_REGISTRY = new Map<string, Model<never>>();

function localKey(providerId: string, modelId: string): string {
	return `${providerId}\u0000${modelId}`;
}

type EngineId = keyof LocalProvidersSettings;

interface EnginePreset {
	reasoning: boolean;
	thinkingFormat?: ThinkingFormat;
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
}

/**
 * Match table keyed by engine id. A preset is only applied when the model id
 * matches a known pattern; unknown model ids fall through to the engine's
 * safe baseline so we never silently claim reasoning support the model does
 * not have. Order matters: the first pattern whose test returns true wins.
 */
const ENGINE_PRESETS: Record<
	EngineId,
	{ patterns: Array<{ test: (id: string) => boolean; preset: EnginePreset }>; baseline: EnginePreset }
> = {
	llamacpp: {
		patterns: [
			{
				test: (id) => /qwen3?.*vl/i.test(id) || /qwen3?.*vision/i.test(id),
				preset: {
					reasoning: true,
					thinkingFormat: "qwen-chat-template",
					contextWindow: 262144,
					maxTokens: 16384,
					input: ["text", "image"],
				},
			},
			{
				test: (id) => /qwen3?/i.test(id),
				preset: {
					reasoning: true,
					thinkingFormat: "qwen-chat-template",
					contextWindow: 262144,
					maxTokens: 16384,
					input: ["text"],
				},
			},
		],
		baseline: { reasoning: false, contextWindow: 8192, maxTokens: 4096, input: ["text"] },
	},
	lmstudio: {
		patterns: [
			{
				test: (id) => /qwen3?.*vl/i.test(id) || /qwen3?.*vision/i.test(id),
				preset: {
					reasoning: true,
					thinkingFormat: "qwen-chat-template",
					contextWindow: 262144,
					maxTokens: 16384,
					input: ["text", "image"],
				},
			},
			{
				test: (id) => /qwen3?/i.test(id),
				preset: {
					reasoning: true,
					thinkingFormat: "qwen-chat-template",
					contextWindow: 262144,
					maxTokens: 16384,
					input: ["text"],
				},
			},
		],
		baseline: { reasoning: false, contextWindow: 8192, maxTokens: 4096, input: ["text"] },
	},
	ollama: {
		patterns: [
			{
				test: (id) => /vl|vision/i.test(id),
				preset: { reasoning: false, contextWindow: 32768, maxTokens: 8192, input: ["text", "image"] },
			},
		],
		baseline: { reasoning: false, contextWindow: 32768, maxTokens: 8192, input: ["text"] },
	},
	"openai-compat": {
		patterns: [],
		baseline: { reasoning: false, contextWindow: 8192, maxTokens: 4096, input: ["text"] },
	},
};

function isEngineId(id: string): id is EngineId {
	return id in ENGINE_PRESETS;
}

function resolvePreset(engine: EngineId, modelId: string): EnginePreset {
	const table = ENGINE_PRESETS[engine];
	for (const entry of table.patterns) {
		if (entry.test(modelId)) return entry.preset;
	}
	return table.baseline;
}

function endpointToModel(providerId: string, modelId: string, endpointName: string, spec: EndpointSpec): Model<never> {
	const base = spec.url.endsWith("/") ? spec.url.slice(0, -1) : spec.url;
	const preset = resolvePreset(providerId as EngineId, modelId);

	const reasoning = spec.reasoning ?? preset.reasoning;
	const contextWindow = spec.context_window ?? preset.contextWindow;
	const maxTokens = spec.max_tokens ?? preset.maxTokens;
	const thinkingFormat = spec.thinking_format ?? (reasoning ? preset.thinkingFormat : undefined);
	const input: ("text" | "image")[] =
		spec.supports_images === true ? ["text", "image"] : spec.supports_images === false ? ["text"] : [...preset.input];

	const compat: Record<string, unknown> = {};
	if (thinkingFormat) compat.thinkingFormat = thinkingFormat;
	if (spec.compat) {
		for (const [key, value] of Object.entries(spec.compat)) {
			compat[key] = value;
		}
	}

	const model: Record<string, unknown> = {
		id: `${modelId}@${endpointName}`,
		name: `${modelId} (${endpointName})`,
		api: "openai-completions" as const,
		provider: providerId,
		baseUrl: `${base}/v1`,
		reasoning,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		headers: spec.headers ?? {},
	};
	if (Object.keys(compat).length > 0) {
		model.compat = compat;
	}
	return model as unknown as Model<never>;
}

/**
 * Register pi-ai Model entries for each configured local-provider endpoint.
 *
 * For every llamacpp/lmstudio/ollama/openai-compat endpoint in settings,
 * compose a Model pointing at `${url}/v1` (OpenAI-compat path) and stash it
 * in the side-registry under key `${modelId}@${endpointName}` so multiple
 * endpoints under the same provider id don't collide.
 *
 * `modelId` defaults to the endpoint's `default_model` entry. Endpoints
 * without a default are still registered under a wildcard `@${endpointName}`
 * key so callers can resolve them by endpoint name alone before a live
 * probe has discovered the model list.
 *
 * Safe to call multiple times; later calls replace earlier entries.
 */
export function registerLocalProviders(providers: Partial<LocalProvidersSettings>): void {
	LOCAL_MODEL_REGISTRY.clear();
	const engines: Array<keyof LocalProvidersSettings> = ["llamacpp", "lmstudio", "ollama", "openai-compat"];
	for (const engine of engines) {
		const cfg = providers[engine];
		if (!cfg) continue;
		for (const [endpointName, spec] of Object.entries(cfg.endpoints)) {
			const modelId = spec.default_model ?? "__default__";
			const model = endpointToModel(engine, modelId, endpointName, spec);
			LOCAL_MODEL_REGISTRY.set(localKey(engine, `${modelId}@${endpointName}`), model);
			LOCAL_MODEL_REGISTRY.set(localKey(engine, `@${endpointName}`), model);
		}
	}
}

/**
 * Register a pi-ai Model for every id discovered on a live local endpoint.
 *
 * Called after `RuntimeAdapter.probeEndpoints` returns a healthy
 * `EndpointProbeResult` whose `models` array lists the ids the endpoint is
 * currently serving. Each id is composed into a Model via `endpointToModel`
 * (reusing the engine preset heuristic from boot-time registration) and
 * stashed under key `${modelId}@${endpointName}`. The wildcard
 * `@${endpointName}` key left behind by `registerLocalProviders` is not
 * disturbed; callers that have not yet picked a model can still resolve by
 * endpoint alone.
 *
 * Providers outside the local-engine table are ignored, since only those
 * engines participate in this side-registry.
 */
export function registerDiscoveredLocalModels(
	providerId: string,
	endpointName: string,
	spec: EndpointSpec,
	modelIds: readonly string[],
): void {
	if (!isEngineId(providerId)) return;
	for (const modelId of modelIds) {
		if (typeof modelId !== "string" || modelId.length === 0) continue;
		const model = endpointToModel(providerId, modelId, endpointName, spec);
		LOCAL_MODEL_REGISTRY.set(localKey(providerId, `${modelId}@${endpointName}`), model);
	}
}

export function getLocalRegisteredModel(providerId: string, modelId: string): Model<never> | undefined {
	return LOCAL_MODEL_REGISTRY.get(localKey(providerId, modelId));
}
