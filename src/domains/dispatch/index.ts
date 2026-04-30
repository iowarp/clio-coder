import type { DomainModule } from "../../core/domain-loader.js";
import { createDispatchBundle } from "./extension.js";
import { DispatchManifest } from "./manifest.js";

export const DispatchDomainModule: DomainModule = {
	manifest: DispatchManifest,
	createExtension: createDispatchBundle,
};

export type { DispatchContract, DispatchRequest } from "./contract.js";
export { DispatchManifest } from "./manifest.js";
export { verifyReceiptIntegrity } from "./receipt-integrity.js";
export type { RunEnvelope, RunKind, RunReceipt, RunStatus, ToolCallStat } from "./types.js";
export type { JobSpec } from "./validation.js";
