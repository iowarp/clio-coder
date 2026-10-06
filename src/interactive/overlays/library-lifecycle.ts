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
	LibraryExtensionRefresh,
	LibraryLifecyclePlan,
	LibraryLifecycleRequest,
	LibraryRefreshHost,
	LibraryRefreshResult,
	LibraryRefreshTouch,
} from "../../domains/resources/index.js";
import {
	applyLibraryLifecycle,
	libraryRefreshTouch,
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
	/**
	 * Refresh only. Never repeats a committed install or removal. `touched` names
	 * what a change outside `apply` reached, such as an import; later retries
	 * follow it until the next apply.
	 */
	retryRefresh(cwd: string, touched?: LibraryRefreshTouch): LibraryRefreshResult;
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
	// A retry follows the apply it belongs to, so it reloads extensions exactly
	// when that apply committed one.
	let touched: LibraryRefreshTouch = { extensions: false };
	return {
		plan: (request) => planLibraryLifecycle(request),
		apply: (plan) => {
			const result = applyLibraryLifecycle(plan, { refresh });
			touched = libraryRefreshTouch(result.outcomes);
			return result;
		},
		release: (plan) => releaseLibraryLifecycle(plan),
		retryRefresh: (cwd, reached) => {
			if (reached) touched = reached;
			return retryLibraryRefresh(cwd, refresh, touched);
		},
	};
}

/** The running session's reload seams. Either may be absent on a host that has none wired. */
export interface LibrarySessionReload {
	/** Reloads plugin resources: skills, prompts, agents and playbooks. */
	resources?: () => { generation: number };
	/**
	 * Restarts extension runtimes and republishes their hooks. It runs now when
	 * the session is idle and otherwise queues, and says which it did.
	 */
	extensions?: () => Exclude<LibraryExtensionRefresh, "unavailable">;
}

/**
 * The active session's refresh, as a lifecycle refresh host.
 *
 * A session without a reload seam says so rather than reporting a refresh that
 * never happened, and a reload that throws is a failed refresh beside committed
 * writes that still stand. Extensions reload only when a committed step changed
 * one, and the result says whether that reload started or is waiting for idle.
 */
export function libraryRefreshHost(reload?: LibrarySessionReload): LibraryRefreshHost {
	const resources = reload?.resources;
	if (!resources)
		return () => ({
			status: "not-applicable",
			reason: "this session has no resource reload; restart to pick up installed changes",
		});
	let previous = 0;
	return (_cwd, touched) => {
		try {
			const next = resources().generation;
			const changed = previous === 0 || next !== previous;
			previous = next;
			if (!touched?.extensions) return { status: "refreshed", generation: next, changed };
			const extensions = reload?.extensions;
			return {
				status: "refreshed",
				generation: next,
				changed,
				extensions: extensions ? extensions() : "unavailable",
			};
		} catch (error) {
			return { status: "failed", error: error instanceof Error ? error.message : String(error) };
		}
	};
}
