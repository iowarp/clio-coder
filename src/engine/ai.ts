/**
 * Thin wrapper over @mariozechner/pi-ai 0.67.4. Domains consume this module, not pi-ai.
 *
 * pi-ai's provider registry is process-global. Calling registerBuiltInApiProviders()
 * multiple times is safe. Clio ensures it runs exactly once before any lookup.
 */

import {
	type AssistantMessage,
	type KnownProvider,
	type Model,
	fauxAssistantMessage,
	fauxToolCall,
	getModels,
	getProviders,
	getModel as piGetModel,
	registerBuiltInApiProviders,
	registerFauxProvider,
} from "@mariozechner/pi-ai";
import type { EndpointSpec, LocalProvidersSettings } from "../core/defaults.js";

// Re-exports for diag scripts that need to drive the faux provider with custom
// tool-call responses (e.g. scripts/diag-worker-tools.ts). Kept narrow on purpose:
// production code paths use registerFauxFromEnv below.
export { fauxAssistantMessage, fauxToolCall, registerFauxProvider };

export interface EngineAi {
	listProviders(): KnownProvider[];
	listModels<TProvider extends KnownProvider>(provider: TProvider): Model<never>[];
	getModel<TProvider extends KnownProvider>(provider: TProvider, modelId: string): Model<never> | undefined;
}

let registered = false;

export function ensurePiAiRegistered(): void {
	if (registered) return;
	registerBuiltInApiProviders();
	registered = true;
}

export function createEngineAi(): EngineAi {
	ensurePiAiRegistered();
	return {
		listProviders: () => getProviders(),
		listModels: (provider) => getModels(provider) as unknown as Model<never>[],
		getModel: (provider, modelId) => {
			try {
				return piGetModel(provider, modelId as never) as unknown as Model<never>;
			} catch {
				return undefined;
			}
		},
	};
}

/**
 * Side-registry of pi-ai Models registered for local inference engines
 * (llamacpp, lmstudio, ollama, openai-compat). Keyed by
 * `${providerId}\u0000${modelId}@${endpointName}`. Callers use
 * `getModel(providerId, "${modelId}@${endpointName}")` once the endpoint
 * has been registered via `registerLocalProviders`.
 */
const LOCAL_MODEL_REGISTRY = new Map<string, Model<never>>();

function localKey(providerId: string, modelId: string): string {
	return `${providerId}\u0000${modelId}`;
}

function endpointToModel(providerId: string, modelId: string, endpointName: string, spec: EndpointSpec): Model<never> {
	const base = spec.url.endsWith("/") ? spec.url.slice(0, -1) : spec.url;
	const model = {
		id: `${modelId}@${endpointName}`,
		name: `${modelId} (${endpointName})`,
		api: "openai-completions" as const,
		provider: providerId,
		baseUrl: `${base}/v1`,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 4096,
		headers: spec.headers ?? {},
	};
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
 * key so callers can resolve them by endpoint name alone once they discover
 * the model list at runtime.
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

export function getLocalRegisteredModel(providerId: string, modelId: string): Model<never> | undefined {
	return LOCAL_MODEL_REGISTRY.get(localKey(providerId, modelId));
}

/**
 * Resolve a model by provider id + model id for consumers that accept unvalidated
 * strings (e.g. the worker subprocess, which is handed strings from the dispatch
 * domain after the domain has already validated them). Throws if the provider or
 * model is unknown.
 *
 * Lookup order: local endpoint registry first (for llamacpp/lmstudio/ollama/
 * openai-compat) then pi-ai's built-in catalog.
 */
export function getModel(providerId: string, modelId: string): Model<never> {
	ensurePiAiRegistered();
	const local = getLocalRegisteredModel(providerId, modelId);
	if (local) return local;
	try {
		return piGetModel(providerId as KnownProvider, modelId as never) as unknown as Model<never>;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`getModel failed for ${providerId}/${modelId}: ${msg}`);
	}
}

/**
 * When `CLIO_WORKER_FAUX=1`, register the pi-ai faux provider and queue a single
 * deterministic assistant response. Used by the worker-entry diag so the worker
 * subprocess can run end-to-end without provider credentials or network access.
 *
 * Env vars (all optional except the gate):
 *   CLIO_WORKER_FAUX       must equal "1" to arm registration
 *   CLIO_WORKER_FAUX_MODEL model id registered under the faux provider (default "faux-model")
 *   CLIO_WORKER_FAUX_TEXT  assistant response text (default "ok")
 *   CLIO_WORKER_FAUX_STOP_REASON assistant stopReason (default "stop")
 *   CLIO_WORKER_FAUX_ERROR_MESSAGE optional assistant errorMessage
 */
export function registerFauxFromEnv(): Model<never> | null {
	if (process.env.CLIO_WORKER_FAUX !== "1") return null;
	const modelId = process.env.CLIO_WORKER_FAUX_MODEL ?? "faux-model";
	const text = process.env.CLIO_WORKER_FAUX_TEXT ?? "ok";
	const stopReason = (process.env.CLIO_WORKER_FAUX_STOP_REASON ?? "stop") as AssistantMessage["stopReason"];
	const errorMessage = process.env.CLIO_WORKER_FAUX_ERROR_MESSAGE;
	const reg = registerFauxProvider({
		provider: "faux",
		models: [{ id: modelId }],
	});
	const response = { stopReason } as {
		stopReason: AssistantMessage["stopReason"];
		errorMessage?: string;
	};
	if (errorMessage && errorMessage.length > 0) {
		response.errorMessage = errorMessage;
	}
	reg.setResponses([fauxAssistantMessage(text, response)]);
	return reg.getModel(modelId) as unknown as Model<never>;
}
