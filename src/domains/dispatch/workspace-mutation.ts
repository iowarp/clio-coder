import type { MiddlewareHookInput } from "../middleware/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasChangedPaths(value: unknown): boolean {
	return Array.isArray(value) && value.some((path) => typeof path === "string" && path.length > 0);
}

/** The applied-merge detail `applyTaskWorktree` writes when a commit actually landed; "nothing merged" never matches. */
const LANDED_MERGE = /^merged [0-9a-f]{7,} onto [^;]+/u;

/** The landing clause of a merged worktree's detail, or undefined when nothing landed. */
export function landedMergeText(applied: unknown, detail: unknown): string | undefined {
	if (applied !== true || typeof detail !== "string") return undefined;
	return LANDED_MERGE.exec(detail)?.[0];
}

/**
 * The transcript notice for a worker whose task worktree merged a commit onto the checkout, naming the worker and its
 * run: `coder run-1 merged abc1234 onto main`. Preserved, conflicted, refused and empty merges give none.
 */
export function workerMergedNotice(
	agentId: string,
	runId: string,
	worktree: { apply: string; applied: boolean; detail?: string } | undefined,
): { code: "worker_merged"; level: "info"; agentId: string; runId: string; message: string } | null {
	if (worktree?.apply !== "merge") return null;
	const landed = landedMergeText(worktree.applied, worktree.detail);
	if (landed === undefined) return null;
	return { code: "worker_merged", level: "info", agentId, runId, message: `${agentId} ${runId} ${landed}` };
}

/** A sealed dispatch result can move the parent's files even when the worker failed. */
export function dispatchMutatedParentWorkspace(details: MiddlewareHookInput["toolResultDetails"]): boolean {
	if (!Array.isArray(details?.runs)) return false;
	return details.runs.some((value: unknown) => {
		if (!isRecord(value) || value.readOnly === true) return false;
		const mutatingSucceeded = isRecord(value.toolActivity) && value.toolActivity.mutatingSucceeded === true;
		const placement = value.placement;
		if (placement === undefined) return mutatingSucceeded;
		if (!isRecord(placement)) return false;
		if (placement.mode === "worktree") return placement.applied === true && hasChangedPaths(placement.changedPaths);
		if (placement.mode === "current") {
			// A checkout delta is stronger evidence than a mutating-capable call.
			// When observed, an empty delta means the parent files did not change.
			return Array.isArray(placement.changedPaths) ? hasChangedPaths(placement.changedPaths) : mutatingSucceeded;
		}
		return false;
	});
}
