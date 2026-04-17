import type { DomainModule } from "../../core/domain-loader.js";
import { createProvidersBundle } from "./extension.js";
import { ProvidersManifest } from "./manifest.js";

export const ProvidersDomainModule: DomainModule = {
	manifest: ProvidersManifest,
	createExtension: createProvidersBundle,
};

export { ProvidersManifest } from "./manifest.js";
export type { ProvidersContract, ProviderListEntry } from "./contract.js";
