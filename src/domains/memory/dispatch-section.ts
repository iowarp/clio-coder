import type { ClioSettings } from "../../core/config.js";
import { canonicalMemoryRepositoryIdentity } from "./operations.js";
import { buildMemoryPromptSection } from "./prompt-section.js";
import { loadMemoryRecordsSync } from "./store.js";
import type { MemoryScope } from "./types.js";

export const DISPATCH_MEMORY_SCOPES: ReadonlyArray<MemoryScope> = ["global", "repo", "runtime", "agent"];

/** The request fields that decide which routes a dispatch may take. */
export interface DispatchMemoryRoute {
	agentId: string;
	target?: string;
	workerProfile?: string;
	workerRuntime?: string;
}

/**
 * The memory section is compiled before fleet routing settles. Admit a
 * runtime-scoped record only when every permitted initial and fallback route is
 * constrained to the same runtime: a pinned target, or a bound profile whose
 * target runtime the request also names.
 */
export function dispatchMemoryRuntimeId(
	settings: Pick<ClioSettings, "targets" | "fleet">,
	route: DispatchMemoryRoute,
): string | undefined {
	const boundProfileName = route.workerProfile ?? settings.fleet.agentProfiles[route.agentId];
	const boundProfile = boundProfileName ? settings.fleet.profiles[boundProfileName] : undefined;
	const configuredRuntime = (targetId: string | null | undefined): string | undefined =>
		settings.targets.find((target) => target.id === targetId)?.runtime;
	if (route.target !== undefined) return configuredRuntime(route.target);
	if (boundProfileName === undefined) return route.workerRuntime;
	const profileRuntimeId = configuredRuntime(boundProfile?.target);
	return route.workerRuntime === profileRuntimeId ? profileRuntimeId : undefined;
}

/**
 * The durable memory section a dispatched worker carries, shared by headless
 * `run` and attended sessions so both gate records the same way. Throws when
 * the store cannot be read; callers decide how to report that.
 */
export function buildDispatchMemorySection(input: {
	dataDir: string;
	cwd: string;
	settings: Pick<ClioSettings, "targets" | "fleet">;
	route: DispatchMemoryRoute;
}): string {
	const records = loadMemoryRecordsSync(input.dataDir);
	const runtimeId = dispatchMemoryRuntimeId(input.settings, input.route);
	return buildMemoryPromptSection(records, {
		scopes: DISPATCH_MEMORY_SCOPES,
		activeRepository: canonicalMemoryRepositoryIdentity(input.cwd),
		activeRuntime: runtimeId === undefined ? null : { kind: "runtime", key: runtimeId },
		activeAgent: { kind: "agent", key: input.route.agentId },
	}).section;
}
