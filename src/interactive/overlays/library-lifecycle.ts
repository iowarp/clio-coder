/**
 * The browser's binding to the package lifecycle.
 *
 * The overlay never calls a writer directly. It builds a plan, renders it, and
 * either applies or releases it, which is what keeps "cancel wrote nothing" a
 * property of the code rather than a promise in a docstring.
 *
 * Types and functions come from `src/domains/resources` unchanged. The UI adds
 * no lifecycle semantics of its own: no second planner, no fallback writer, and
 * no shape it maintains in parallel with the domain.
 */

import type {
	LibraryApplyResult,
	LibraryLifecyclePlan,
	LibraryLifecycleRequest,
	LibraryRefreshHost,
	LibraryRefreshResult,
} from "../../domains/resources/index.js";
import {
	applyLibraryLifecycle,
	planLibraryLifecycle,
	releaseLibraryLifecycle,
	retryLibraryRefresh,
} from "../../domains/resources/index.js";

export type {
	LibraryApplyResult,
	LibraryLifecyclePlan,
	LibraryLifecycleRequest,
	LibraryOperation,
	LibraryPackageIdentity,
	LibraryPlanStep,
	LibraryRefreshHost,
	LibraryRefreshResult,
	LibraryStepOutcome,
} from "../../domains/resources/index.js";

/** What the browser needs from the lifecycle domain, and nothing more. */
export interface LibraryLifecyclePort {
	plan(request: LibraryLifecycleRequest): LibraryLifecyclePlan;
	apply(plan: LibraryLifecyclePlan): LibraryApplyResult;
	/** Cancel: release staged sources, write nothing. */
	release(plan: LibraryLifecyclePlan): void;
	/** Refresh only. Never repeats a committed install or removal. */
	retryRefresh(cwd: string): LibraryRefreshResult;
}

/**
 * Bind the port for an interactive session.
 *
 * `refresh` is the active host's resource reload. It runs once after the last
 * committed step and its result is reported separately, so a failed refresh
 * never restates a successful write as a failure, and retrying it never
 * re-applies the plan.
 */
export function createLibraryLifecycle(refresh: LibraryRefreshHost): LibraryLifecyclePort {
	return {
		plan: (request) => planLibraryLifecycle(request),
		apply: (plan) => applyLibraryLifecycle(plan, { refresh }),
		release: (plan) => releaseLibraryLifecycle(plan),
		retryRefresh: (cwd) => retryLibraryRefresh(cwd, refresh),
	};
}

/**
 * The active session's resource refresh, as a lifecycle refresh host.
 *
 * A session without a reload seam says so rather than reporting a refresh that
 * never happened, and a reload that throws is a failed refresh beside committed
 * writes that still stand.
 */
export function libraryRefreshHost(reload?: () => { generation: number }): LibraryRefreshHost {
	if (!reload)
		return () => ({
			status: "not-applicable",
			reason: "this session has no resource reload; restart to pick up installed changes",
		});
	let previous = 0;
	return () => {
		try {
			const next = reload().generation;
			const changed = previous === 0 || next !== previous;
			previous = next;
			return { status: "refreshed", generation: next, changed };
		} catch (error) {
			return { status: "failed", error: error instanceof Error ? error.message : String(error) };
		}
	};
}
