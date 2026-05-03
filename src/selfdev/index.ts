import { ALL_MODES, type ModeName } from "../domains/modes/index.js";
import type { ToolRegistry, ToolSourceInfo, ToolSpec } from "../tools/registry.js";
import type { HarnessIntrospection } from "./harness/state.js";
import type { SelfDevMode } from "./mode.js";
import { clioIntrospectTool } from "./tools/introspect.js";
import { clioRecallTool } from "./tools/recall.js";
import { clioRememberTool } from "./tools/remember.js";

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

export interface SelfDevToolRegistrationDeps {
	mode: SelfDevMode;
	getHarnessIntrospection?: () => HarnessIntrospection;
}

function withSourceInfo<T extends ToolSpec>(spec: T, sourceInfo: ToolSourceInfo): T {
	return { ...spec, sourceInfo };
}

export function registerSelfDevTools(registry: ToolRegistry, deps: SelfDevToolRegistrationDeps): void {
	const everyMode: ReadonlyArray<ModeName> = [...ALL_MODES];
	const defaultAndSuper: ReadonlyArray<ModeName> = ["default", "super"];
	registry.register({
		...withSourceInfo(
			clioIntrospectTool({
				mode: deps.mode,
				registry,
				...(deps.getHarnessIntrospection ? { getHarnessIntrospection: deps.getHarnessIntrospection } : {}),
			}),
			{ path: "src/selfdev/tools/introspect.ts", scope: "selfdev" },
		),
		allowedModes: everyMode,
		bypassModeMatrix: true,
	});
	registry.register({
		...withSourceInfo(clioRecallTool({ repoRoot: deps.mode.repoRoot }), {
			path: "src/selfdev/tools/recall.ts",
			scope: "selfdev",
		}),
		allowedModes: everyMode,
		bypassModeMatrix: true,
	});
	registry.register({
		...withSourceInfo(clioRememberTool({ repoRoot: deps.mode.repoRoot }), {
			path: "src/selfdev/tools/remember.ts",
			scope: "selfdev",
		}),
		allowedModes: defaultAndSuper,
		bypassModeMatrix: true,
	});
}
