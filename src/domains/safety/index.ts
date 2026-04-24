import type { DomainModule } from "../../core/domain-loader.js";
import { createSafetyBundle } from "./extension.js";
import { SafetyManifest } from "./manifest.js";

export const SafetyDomainModule: DomainModule = {
	manifest: SafetyManifest,
	createExtension: createSafetyBundle,
};

export type { SafetyContract, SafetyDecision } from "./contract.js";
export { SafetyManifest } from "./manifest.js";
