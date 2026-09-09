import type { DomainModule } from "../../core/domain-loader.js";
import type { InteropContract } from "./contract.js";
import { createInteropBundle } from "./extension.js";
import { InteropManifest } from "./manifest.js";

export const InteropDomainModule: DomainModule<InteropContract> = {
	manifest: InteropManifest,
	createExtension: createInteropBundle,
};

export type { AdoptionKind, InteropAdoptionPlan } from "./adopt.js";
export { applyInteropAdoption, planInteropAdoption, renderInteropAdoptionPlan } from "./adopt.js";
export {
	acceptInteropAgents,
	declineInteropAgents,
	delegationEntryForKind,
	INHERITED_PROJECT_CONTEXT,
	interopBootHint,
	interopProposals,
	renderProposalEntry,
} from "./consent.js";
export type { InteropContract } from "./contract.js";
export { detectInteropAgents, resolveOnPath } from "./detect.js";
export { discoverInteropInventory } from "./inventory.js";
export { InteropManifest } from "./manifest.js";
export { foreignAgentDirs, INTEROP_AGENT_KINDS, interopAgentKind, interopSourceRank } from "./registry.js";
export { readInteropReport, writeInteropReport } from "./state.js";
export type {
	InteropAgentId,
	InteropAgentKind,
	InteropAgentRecord,
	InteropDecisionResult,
	InteropDetectInput,
	InteropPresence,
	InteropProposal,
	InteropReport,
} from "./types.js";
