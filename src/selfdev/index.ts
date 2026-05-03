export { applySelfDevToolGuards } from "./guards.js";
export { type HarnessDeps, type HarnessHandle, startHarness } from "./harness/index.js";
export {
	type HarnessHotFailedSummary,
	type HarnessHotSucceededSummary,
	type HarnessIntrospection,
	type HarnessSnapshot,
	HarnessState,
	type HarnessStateDeps,
} from "./harness/state.js";
export {
	appendDevMemory,
	type DevMemoryEntry,
	devMemoryPath,
	recallDevMemory,
	renderDevMemoryFragment,
} from "./memory.js";
export {
	DEV_FILE_NAME,
	devSupplementCandidates,
	type EnsureSelfDevBranchOptions,
	ensureSelfDevBranch,
	evaluateSelfDevBashCommand,
	evaluateSelfDevWritePath,
	resolveRepoRoot,
	resolveSelfDevMode,
	type SelfDevActivationSource,
	type SelfDevMode,
	type SelfDevPathDecision,
	selfDevActivationSource,
} from "./mode.js";
export { clioIntrospectTool } from "./tools/introspect.js";
export { clioRecallTool } from "./tools/recall.js";
export { clioRememberTool } from "./tools/remember.js";
export { openDevDiffOverlay, renderDevDiffOverlay } from "./ui/dev-diff.js";
export { createSelfDevFooterLine } from "./ui/dev-footer.js";
