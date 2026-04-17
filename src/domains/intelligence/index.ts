import type { DomainModule } from "../../core/domain-loader.js";
import { createIntelligenceBundle } from "./extension.js";
import { IntelligenceManifest } from "./manifest.js";

export const IntelligenceDomainModule: DomainModule = {
	manifest: IntelligenceManifest,
	createExtension: createIntelligenceBundle,
};

export { IntelligenceManifest } from "./manifest.js";
export type { IntelligenceContract, IntentEvent, IntentKind, IntentObservation } from "./contracts.js";
