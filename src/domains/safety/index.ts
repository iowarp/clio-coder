import type { DomainModule } from "../../core/domain-loader.js";
import { createSafetyBundle } from "./extension.js";
import { SafetyManifest } from "./manifest.js";

export const SafetyDomainModule: DomainModule = {
	manifest: SafetyManifest,
	createExtension: createSafetyBundle,
};

export { SafetyManifest } from "./manifest.js";
export type { SafetyContract, SafetyDecision } from "./contract.js";
