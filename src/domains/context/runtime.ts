import type { DomainModule } from "../../core/domain-loader.js";
import { type ContextBundleOptions, createContextBundle } from "./extension.js";
import { ContextManifest } from "./manifest.js";

export const ContextDomainModule: DomainModule = {
	manifest: ContextManifest,
	createExtension: createContextBundle,
};

export function createContextDomainModule(options: ContextBundleOptions = {}): DomainModule {
	return {
		manifest: ContextManifest,
		createExtension: (context) => createContextBundle(context, options),
	};
}

export type { ContextBundleOptions } from "./extension.js";
