import type { DomainModule } from "../../core/domain-loader.js";
import type { InteropContract } from "./contract.js";
import { createInteropBundle } from "./extension.js";
import { InteropManifest } from "./manifest.js";

export const InteropDomainModule: DomainModule<InteropContract> = {
	manifest: InteropManifest,
	createExtension: createInteropBundle,
};

export type { InteropContract } from "./contract.js";
export { detectInteropAgents } from "./detect.js";
export { InteropManifest } from "./manifest.js";
export { foreignAgentDirs, INTEROP_AGENT_KINDS, interopAgentKind, interopSourceRank } from "./registry.js";
export { readInteropReport, writeInteropReport } from "./state.js";
export type {
	InteropAgentId,
	InteropAgentKind,
	InteropAgentRecord,
	InteropDetectInput,
	InteropPresence,
	InteropReport,
} from "./types.js";
