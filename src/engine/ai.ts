/**
 * Thin wrapper over @mariozechner/pi-ai 0.67.4. Domains consume this module, not pi-ai.
 *
 * pi-ai's provider registry is process-global. Calling registerBuiltInApiProviders()
 * multiple times is safe. Clio ensures it runs exactly once before any lookup.
 */

import {
	getModel,
	getModels,
	getProviders,
	registerBuiltInApiProviders,
	type KnownProvider,
	type Model,
} from "@mariozechner/pi-ai";

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
				return getModel(provider, modelId as never) as unknown as Model<never>;
			} catch {
				return undefined;
			}
		},
	};
}
