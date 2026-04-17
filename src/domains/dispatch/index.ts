import type { DomainModule } from "../../core/domain-loader.js";
import { createDispatchBundle } from "./extension.js";
import { DispatchManifest } from "./manifest.js";

export const DispatchDomainModule: DomainModule = {
	manifest: DispatchManifest,
	createExtension: createDispatchBundle,
};

export { DispatchManifest } from "./manifest.js";
export type { DispatchContract, DispatchRequest } from "./contract.js";
export type { RunEnvelope, RunReceipt, RunStatus } from "./types.js";
export type { JobSpec } from "./validation.js";
