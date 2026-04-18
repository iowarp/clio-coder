/**
 * Thin wrapper over @mariozechner/pi-ai. Domains consume this module, not
 * pi-ai directly. The model-lookup side-registry that used to live here is
 * gone; runtime descriptors under `src/domains/providers/runtimes/` own
 * model synthesis via `RuntimeDescriptor.synthesizeModel()`.
 *
 * pi-ai's provider registry is process-global. Calling
 * `registerBuiltInApiProviders()` multiple times is safe; we still gate on a
 * module-local flag to keep startup hot paths predictable.
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
	stream as piStream,
	registerBuiltInApiProviders,
	registerFauxProvider,
} from "@mariozechner/pi-ai";

export { fauxAssistantMessage, fauxToolCall, registerFauxProvider };

export const stream = piStream;

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
 * When `CLIO_WORKER_FAUX=1`, register the pi-ai faux provider and queue a
 * single deterministic assistant response. Used by the worker-entry diag so
 * the worker subprocess can run end-to-end without provider credentials.
 *
 * Env vars (all optional except the gate):
 *   CLIO_WORKER_FAUX               must equal "1" to arm registration
 *   CLIO_WORKER_FAUX_MODEL         model id registered under the faux provider (default "faux-model")
 *   CLIO_WORKER_FAUX_TEXT          assistant response text (default "ok")
 *   CLIO_WORKER_FAUX_STOP_REASON   assistant stopReason (default "stop")
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
