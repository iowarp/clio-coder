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
 */

import { existsSync } from "node:fs";
import { isGitRepository } from "../../tools/compete-worktrees.js";
import type { ExecutionPlan } from "./execution-plan.js";
import type { ExecutionWriteBoundaryOutcome } from "./execution-scheduler.js";
import {
	assertWriteBoundaryInsideRoot,
	captureWorkspaceSnapshot,
	enforceWriteBoundary,
	type WorkspaceSnapshot,
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
}

export function createWriteBoundaryEnforcer(input: WriteBoundaryEnforcerInput): WriteBoundaryEnforcer {
	const open = new Map<string, { snapshot: WorkspaceSnapshot; allow: string[] }>();
	const allowFor = (stepIds: ReadonlyArray<string>): string[] => {
		const allow = new Set<string>();
		for (const stepId of stepIds) for (const entry of input.boundaryFor(stepId) ?? []) allow.add(entry);
		return [...allow].sort();
	};
	return {
		begin(window, stepIds) {
			const allow = allowFor(stepIds);
			assertWriteBoundaryInsideRoot(input.root, allow);
			open.set(window, { snapshot: captureWorkspaceSnapshot(input.root), allow });
		},
		async verify(window, stepIds) {
			const pending = open.get(window);
			if (pending === undefined) {
				throw new Error(`write boundary: window '${window}' was verified without a snapshot`);
			}
			open.delete(window);
			const verdict = enforceWriteBoundary({
				snapshot: pending.snapshot,
				window,
				stepIds,
				allow: pending.allow,
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
