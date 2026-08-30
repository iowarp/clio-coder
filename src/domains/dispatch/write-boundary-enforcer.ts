/**
 * Binds declared write boundaries to the scheduler's execution windows.
 *
 * The scheduler stays free of the filesystem: it says "this window is opening"
 * and "this window closed, what happened", and this is the half that answers by
 * looking at the checkout. Attribution is per window rather than per step
 * because fleet steps share the operator's checkout: when a wave ran two steps,
 * a path that changed cannot be pinned on one of them, and the plan compiler
 * has already refused the case where more than one of them was allowed to
 * write. Every step in a violating window fails, and the verdict says why.
 *
 * The window also carries what its runs recorded writing, which is what keeps
 * the checkout diff from being read as authorship. A change nobody in the
 * window recorded belongs to whoever else has the checkout open, and the
 * verdict reports it without touching it.
 */

import { existsSync } from "node:fs";
import { isGitRepository } from "../../tools/compete-worktrees.js";
import type { ExecutionPlan } from "./execution-plan.js";
import type { ExecutionWriteBoundaryOutcome } from "./execution-scheduler.js";
import {
	assertWriteBoundaryInsideRoot,
	assertWriteBoundaryVisibleToGit,
	captureWorkspaceSnapshot,
	enforceWriteBoundary,
	type WorkspaceSnapshot,
	type WriteBoundaryAttribution,
	type WriteBoundaryAttributionDowngrade,
	type WriteBoundaryVerdict,
	writeWriteBoundaryVerdict,
} from "./write-boundary.js";

export interface WriteBoundaryEnforcerInput {
	/** Absolute workspace root every declared path is relative to. */
	root: string;
	/** Run root id; verdicts are recorded under it beside the run ledger. */
	rootId: string;
	/** Declared allowlist for a step, or undefined when it declares no boundary. */
	boundaryFor(stepId: string): ReadonlyArray<string> | undefined;
	/**
	 * What the step's own run recorded writing, or null when the step has no
	 * closed write record: a code step running a registered command, a runtime
	 * that publishes no tool telemetry, a run whose telemetry had holes, or a run
	 * that shelled out or spawned a worker and could have written a path no
	 * argument names. Absent entirely means the caller offers no record at all,
	 * and every change outside the declaration is blamed on the window.
	 */
	recordedWritesFor?(stepId: string): ReadonlyArray<string> | WriteBoundaryAttribution | null;
	/** Called once per closed window with the sealed verdict and where it landed. */
	onVerdict?(verdict: WriteBoundaryVerdict, path: string): void;
}

export interface WriteBoundaryEnforcer {
	begin(window: string, stepIds: ReadonlyArray<string>): void;
	verify(window: string, stepIds: ReadonlyArray<string>): Promise<ExecutionWriteBoundaryOutcome>;
}

/**
 * Whole-plan preflight. A boundary that cannot be verified is refused before
 * anything runs: enforcement is not a best effort that quietly turns itself off
 * when the workspace is not a git repository or a declared path leaves it
 * through a symlink.
 */
export function preflightWriteBoundaries(plan: ExecutionPlan, root: string): void {
	const declared = plan.steps.filter((step) => step.writes !== undefined);
	if (declared.length === 0) return;
	if (!existsSync(root) || !isGitRepository(root)) {
		throw new Error(
			`write boundaries are declared but ${root} is not a git repository; boundary enforcement compares the checkout before and after each step and fails closed without one`,
		);
	}
	for (const step of declared) assertWriteBoundaryInsideRoot(root, step.writes ?? []);
	// One question over the whole plan: an entry is refused for being invisible
	// to git whichever step declared it, and the diagnostic names the path.
	assertWriteBoundaryVisibleToGit(root, [...new Set(declared.flatMap((step) => [...(step.writes ?? [])]))]);
}

export function createWriteBoundaryEnforcer(input: WriteBoundaryEnforcerInput): WriteBoundaryEnforcer {
	const open = new Map<string, { snapshot: WorkspaceSnapshot; allow: string[] }>();
	const allowFor = (stepIds: ReadonlyArray<string>): string[] => {
		const allow = new Set<string>();
		for (const stepId of stepIds) for (const entry of input.boundaryFor(stepId) ?? []) allow.add(entry);
		return [...allow].sort();
	};
	/**
	 * The window's write witness. One step without a record makes the whole
	 * window's record incomplete: the steps share a checkout, so a change no
	 * other step wrote could still be the unobserved one's.
	 */
	const attributionFor = (stepIds: ReadonlyArray<string>): WriteBoundaryAttribution | undefined => {
		const recordedWritesFor = input.recordedWritesFor;
		if (recordedWritesFor === undefined) return undefined;
		const recorded = new Set<string>();
		const downgrades: WriteBoundaryAttributionDowngrade[] = [];
		let complete = true;
		for (const stepId of stepIds) {
			const observed = recordedWritesFor(stepId);
			if (observed === null) {
				complete = false;
				downgrades.push({
					reason: "write_record_unavailable",
					tool: null,
					toolCallId: null,
					runId: null,
					stepId,
				});
				continue;
			}
			if (!("recorded" in observed)) {
				for (const target of observed) recorded.add(target);
				continue;
			}
			for (const target of observed.recorded) recorded.add(target);
			if (!observed.complete) complete = false;
			for (const downgrade of observed.downgrades ?? []) {
				downgrades.push({ ...downgrade, stepId: downgrade.stepId ?? stepId });
			}
		}
		return { recorded: [...recorded].sort(), complete, downgrades };
	};
	return {
		begin(window, stepIds) {
			const allow = allowFor(stepIds);
			assertWriteBoundaryInsideRoot(input.root, allow);
			// Also checked whole-plan at preflight. Repeated here because a
			// delegation plan splices steps into a running fleet, and their
			// declarations reach this function without ever passing preflight.
			assertWriteBoundaryVisibleToGit(input.root, allow);
			open.set(window, { snapshot: captureWorkspaceSnapshot(input.root), allow });
		},
		async verify(window, stepIds) {
			const pending = open.get(window);
			if (pending === undefined) {
				throw new Error(`write boundary: window '${window}' was verified without a snapshot`);
			}
			open.delete(window);
			const attribution = attributionFor(stepIds);
			const verdict = enforceWriteBoundary({
				snapshot: pending.snapshot,
				window,
				stepIds,
				allow: pending.allow,
				...(attribution === undefined ? {} : { attribution }),
			});
			const path = writeWriteBoundaryVerdict(input.rootId, verdict);
			input.onVerdict?.(verdict, path);
			return {
				window,
				violated: verdict.reason !== null,
				// Every step in the window is named. With one step that is exact;
				// with several it is the honest answer, because one checkout cannot
				// tell the scheduler which of them wrote the path.
				failedStepIds: verdict.reason === null ? [] : [...stepIds],
				detail: verdict.detail,
			};
		},
	};
}
