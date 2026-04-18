/**
 * Thin wrapper over @mariozechner/pi-ai 0.67.4. Domains consume this module, not pi-ai.
 *
 * pi-ai's provider registry is process-global. Calling registerBuiltInApiProviders()
 * multiple times is safe. Clio ensures it runs exactly once before any lookup.
 */

import {
	type Api,
	type AssistantMessage,
	type KnownProvider,
	type Model,
	fauxAssistantMessage,
	fauxToolCall,
	getModels,
	getProviders,
	getModel as piGetModel,
	stream as piStream,
	supportsXhigh as piSupportsXhigh,
	registerBuiltInApiProviders,
	registerFauxProvider,
} from "@mariozechner/pi-ai";
import { getLocalRegisteredModel } from "./local-model-registry.js";

// Re-exports for diag scripts that need to drive the faux provider with custom
// tool-call responses (e.g. scripts/diag-worker-tools.ts). Kept narrow on purpose:
// production code paths use registerFauxFromEnv below.
export { fauxAssistantMessage, fauxToolCall, registerFauxProvider };

export const stream = piStream;

// Local side-registry surface lives in ./local-model-registry.js; re-exported
// here so existing callers that import from engine/ai.ts keep working.
export {
	getLocalRegisteredModel,
	registerDiscoveredLocalModels,
	registerLocalProviders,
	resolveLocalModelId,
} from "./local-model-registry.js";

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

/**
 * Engine-side wrapper for pi-ai's `supportsXhigh` so domain code can gate
 * xhigh thinking without importing pi-ai directly. Accepts the engine-facing
 * `Model<never>` shape; rewraps to pi-ai's internal `Model<Api>` on the call.
 */
export function supportsXhighModel(model: Model<never> | undefined): boolean {
	if (!model) return false;
	return piSupportsXhigh(model as unknown as Model<Api>);
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
