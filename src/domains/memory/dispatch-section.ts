import { resolve } from "node:path";
import { type ClioSettings, readSettings } from "../../core/config.js";
import { clioDataDir } from "../../core/xdg.js";
import type { DispatchContract, DispatchRequest } from "../dispatch/contract.js";
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
 *
 * Repository records follow the worker, not the host: a request whose `cwd`
 * names another checkout carries that checkout's lessons and none of the
 * host's, the same way the worker resolves its own `cwd` against the host's.
 */
export function buildDispatchMemorySection(input: {
	dataDir: string;
	cwd: string;
	/** The request's own `cwd`, when it names one. */
	workerCwd?: string;
	settings: Pick<ClioSettings, "targets" | "fleet" | "context">;
	route: DispatchMemoryRoute;
}): string {
	if (!input.settings.context.memory.enabled) return "";
	const records = loadMemoryRecordsSync(input.dataDir);
	const runtimeId = dispatchMemoryRuntimeId(input.settings, input.route);
	return buildMemoryPromptSection(records, {
		scopes: DISPATCH_MEMORY_SCOPES,
		activeRepository: canonicalMemoryRepositoryIdentity(
			input.workerCwd === undefined ? input.cwd : resolve(input.cwd, input.workerCwd),
		),
		activeRuntime: runtimeId === undefined ? null : { kind: "runtime", key: runtimeId },
		activeAgent: { kind: "agent", key: input.route.agentId },
	}).section;
}

/**
 * Every attended dispatch path (the dispatch tool, slash commands, turn control)
 * receives this one contract, so the durable memory section headless `run`
 * builds is sealed here once rather than at each request builder. A request
 * that already carries a section keeps it; an unreadable store sends none.
 */
export function withDispatchMemory(
	contract: DispatchContract | undefined,
	getSettings: () => Readonly<ClioSettings> | undefined,
): DispatchContract | undefined {
	if (contract === undefined) return undefined;
	const withMemory = (request: DispatchRequest): DispatchRequest => {
		if (request.memorySection !== undefined) return request;
		const settings = getSettings() ?? readSettings();
		let section = "";
		try {
			section = buildDispatchMemorySection({
				dataDir: clioDataDir(),
				cwd: process.cwd(),
				...(request.cwd !== undefined ? { workerCwd: request.cwd } : {}),
				settings,
				route: {
					agentId: request.agentId,
					...(request.target !== undefined ? { target: request.target } : {}),
					...(request.workerProfile !== undefined ? { workerProfile: request.workerProfile } : {}),
					...(request.workerRuntime !== undefined ? { workerRuntime: request.workerRuntime } : {}),
				},
			});
		} catch {
			// Memory is advisory; a store that cannot be read must not block the dispatch.
		}
		return section.length > 0 ? { ...request, memorySection: section } : request;
	};
	return {
		...contract,
		dispatch: (request, observer, preparation) => contract.dispatch(withMemory(request), observer, preparation),
		dispatchBatch: (requests, preparation) => contract.dispatchBatch(requests.map(withMemory), preparation),
	};
}
