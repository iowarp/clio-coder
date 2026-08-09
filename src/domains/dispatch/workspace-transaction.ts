/**
 * Transactional attempt isolation for workspace-editing assignments.
 *
 * Retry and failover currently share the assignment's one mutable checkout, so
 * a failed attempt's partial edits are still on disk when its successor starts.
 * The successor then reads a workspace that no approval ever described, and the
 * evidence it produces describes that contaminated state rather than the route.
 *
 * A transaction owns one git worktree group per assignment. Every attempt gets
 * its own clean worktree branched from the same approved baseline commit, so
 * attempt N+1 cannot observe attempt N's mutations. At most one attempt's work
 * ever reaches the operator's branch, and only after its result contract and
 * quality gate pass.
 *
 * Ownership, durable claiming, process leasing, restart recovery, and cleanup
 * are the same problem the compete topology already solved. This module binds
 * those primitives to the attempt namespace rather than reimplementing them:
 * there is one cleanup implementation in the repository, not two.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
	ATTEMPT_NAMESPACE,
	type CandidateWorktree,
	type CompeteGroupOwnership,
	claimWorktreeGroup,
	cleanupWorktreeGroup,
	commitCandidateWork,
	createCandidateWorktree,
	isGitRepository,
	markCompeteGroupCleanupReady,
	markCompeteGroupWinnerPreserved,
	mergeWinnerBranch,
	protectedPathsChangedByBranch,
	removeCandidateWorktree,
} from "../../tools/compete-worktrees.js";

/** One assignment's owned workspace transaction. */
export interface WorkspaceTransaction {
	assignmentId: string;
	/** The approved commit every attempt branches from. Resolved once, at open. */
	baseline: string;
	protectedPaths: ReadonlyArray<string>;
	ownership: CompeteGroupOwnership;
}

/** One attempt's private checkout. */
export type AttemptWorkspace = CandidateWorktree;

export interface OpenWorkspaceTransactionInput {
	root: string;
	assignmentId: string;
	/** Paths an attempt may not modify. Rechecked at apply, never widened. */
	protectedPaths?: ReadonlyArray<string>;
}

/**
 * Everything the coordinator must have proven before an attempt's work may
 * reach the operator's branch. Every field is a hard precondition: none of them
 * trades against another, and none of them is a score.
 */
export interface AttemptApplyEvidence {
	/** The attempt settled as `succeeded`. */
	outcomeSucceeded: boolean;
	/** The attempt's terminal receipt passed integrity verification. */
	receiptIntegrityOk: boolean;
	/**
	 * The declared result contract conformed. `null` means the contract was
	 * never reached, which is not conformance and cannot authorize an apply.
	 */
	resultContractConformed: boolean | null;
	/**
	 * The required quality gate passed. `null` means no gate ran, which for a
	 * workspace mutation is a missing precondition rather than an implicit pass.
	 */
	qualityGatePassed: boolean | null;
}

/** Reasons decidable from evidence alone, before the repository is touched. */
export type ApplyIneligibility =
	| "attempt-did-not-succeed"
	| "receipt-integrity-unverified"
	| "result-contract-not-reached"
	| "result-contract-failed"
	| "quality-gate-absent"
	| "quality-gate-failed";

/** Reasons that only the repository's state at apply time can establish. */
export type ApplyRecheckFailure =
	| "protected-artifact-drift"
	| "baseline-ancestry-broken"
	| "destination-not-clean"
	| "merge-failed";

export type ApplyRefusal = ApplyIneligibility | ApplyRecheckFailure;

/**
 * Pure eligibility reduction. Kept separate from the git mutations so the
 * policy is testable without a repository, and so an ineligible attempt is
 * rejected before anything on disk is touched.
 */
export function evaluateApplyEligibility(evidence: AttemptApplyEvidence): ApplyIneligibility[] {
	const reasons: ApplyIneligibility[] = [];
	if (!evidence.outcomeSucceeded) reasons.push("attempt-did-not-succeed");
	if (!evidence.receiptIntegrityOk) reasons.push("receipt-integrity-unverified");
	if (evidence.resultContractConformed === null) reasons.push("result-contract-not-reached");
	else if (!evidence.resultContractConformed) reasons.push("result-contract-failed");
	if (evidence.qualityGatePassed === null) reasons.push("quality-gate-absent");
	else if (!evidence.qualityGatePassed) reasons.push("quality-gate-failed");
	return reasons;
}

export type ApplyResult =
	| { applied: true; branch: string }
	| {
			applied: false;
			reasons: ApplyRefusal[];
			/** Set when the winner's worktree is retained for operator recovery. */
			preserved?: { branch: string; path: string; recovery: string };
	  };

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
	}).trim();
}

/** Assignment ids are opaque; the group name must still be a safe path segment. */
function groupName(assignmentId: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(assignmentId)) {
		throw new Error(`assignment id '${assignmentId}' is not a safe workspace transaction group`);
	}
	return assignmentId;
}

/**
 * Claim a transaction and pin its baseline. Refuses a non-git checkout: there
 * is no way to give attempts private workspaces or to undo a losing attempt
 * without one, and silently sharing the checkout is the defect this exists to
 * remove.
 */
export function openWorkspaceTransaction(input: OpenWorkspaceTransactionInput): WorkspaceTransaction {
	if (!isGitRepository(input.root)) {
		throw new Error(`workspace transaction requires a git repository; ${input.root} is not one`);
	}
	const group = groupName(input.assignmentId);
	// Resolve the baseline before claiming, so a failure to read HEAD leaves no
	// claim behind, and so every attempt in this transaction shares one commit
	// even if the operator's HEAD moves while the assignment runs.
	const baseline = git(input.root, ["rev-parse", "HEAD"]);
	const ownership = claimWorktreeGroup(ATTEMPT_NAMESPACE, input.root, group);
	return {
		assignmentId: input.assignmentId,
		baseline,
		protectedPaths: [...(input.protectedPaths ?? [])],
		ownership,
	};
}

/**
 * Open a clean workspace for one attempt. `attempt` is the attempt number from
 * the assignment's lineage, so a retry never reuses its predecessor's path.
 */
export function beginAttempt(transaction: WorkspaceTransaction, attempt: number): AttemptWorkspace {
	return createCandidateWorktree(transaction.ownership, attempt + 1, transaction.baseline);
}

/** Seal an attempt's edits as one commit. False means the attempt changed nothing. */
export function sealAttempt(workspace: AttemptWorkspace, message: string): boolean {
	return commitCandidateWork(workspace, message, ATTEMPT_NAMESPACE.commitIdentity);
}

/**
 * Drop a failed, timed-out, stalled, canceled, or superseded attempt. Its
 * worktree and branch are removed, so nothing it wrote can be merged later or
 * observed by the next attempt.
 */
export function discardAttempt(transaction: WorkspaceTransaction, workspace: AttemptWorkspace): void {
	removeCandidateWorktree(transaction.ownership, workspace, true);
}

/**
 * Apply exactly one attempt to the operator's branch.
 *
 * Order matters: eligibility is reduced first and rejects without touching the
 * repository. The on-disk rechecks then re-establish, at apply time, what was
 * true at claim time, because the operator's checkout is not frozen while an
 * assignment runs.
 *
 * A failure after the merge begins preserves the winning worktree and returns
 * recovery instructions. Cleaning up here would destroy the only copy of work
 * that already passed every quality precondition.
 */
export function applyAttempt(
	transaction: WorkspaceTransaction,
	workspace: AttemptWorkspace,
	evidence: AttemptApplyEvidence,
): ApplyResult {
	const reasons = evaluateApplyEligibility(evidence);
	if (reasons.length > 0) return { applied: false, reasons };

	const root = transaction.ownership.root;
	const blocked = protectedPathsChangedByBranch(
		root,
		workspace.branch,
		transaction.protectedPaths,
		transaction.baseline,
	);
	if (blocked.length > 0) {
		return preserve(transaction, workspace, "protected-artifact-drift", `protected paths changed: ${blocked.join(", ")}`);
	}
	if (!isDescendantOf(root, transaction.baseline, workspace.branch)) {
		return preserve(transaction, workspace, "baseline-ancestry-broken", "attempt branch no longer descends the baseline");
	}
	const dirt = operatorDirt(root);
	if (dirt.length > 0) {
		return preserve(
			transaction,
			workspace,
			"destination-not-clean",
			`operator checkout has uncommitted changes: ${dirt.slice(0, 5).join(", ")}`,
		);
	}

	const merged = mergeWinnerBranch(root, workspace.branch, ATTEMPT_NAMESPACE.commitIdentity);
	if (!merged.ok) return preserve(transaction, workspace, "merge-failed", merged.reason);
	return { applied: true, branch: workspace.branch };
}

/**
 * Uncommitted paths in the operator's checkout, excluding the directory this
 * transaction and its siblings own. Attempt worktrees live inside the project
 * root so remote fleet nodes see the same path, which means they show up as
 * untracked unless the project happens to ignore them. Treating our own
 * scaffolding as operator work would refuse every apply.
 */
function operatorDirt(root: string): string[] {
	const owned = join(...ATTEMPT_NAMESPACE.parentSegments);
	// -uall lists untracked files individually. Without it git collapses an
	// untracked directory to a single "\.clio/" entry, which no prefix filter
	// for the owned subdirectory can match.
	return git(root, ["status", "--porcelain", "-z", "-uall"])
		.split("\0")
		.filter((entry) => entry.length > 3)
		.map((entry) => entry.slice(3))
		.filter((path) => path !== owned && !path.startsWith(`${owned}/`) && !path.startsWith(`${owned}\\`));
}

function isDescendantOf(root: string, baseline: string, branch: string): boolean {
	try {
		git(root, ["merge-base", "--is-ancestor", baseline, branch]);
		return true;
	} catch {
		return false;
	}
}

function preserve(
	transaction: WorkspaceTransaction,
	workspace: AttemptWorkspace,
	reason: ApplyRecheckFailure,
	detail: string,
): ApplyResult {
	// Record the preservation durably before returning, so a coordinator crash
	// between here and the caller cannot let restart recovery sweep the winner.
	transaction.ownership = markCompeteGroupWinnerPreserved(transaction.ownership, workspace.index);
	return {
		applied: false,
		reasons: [reason],
		preserved: {
			branch: workspace.branch,
			path: workspace.path,
			recovery: `${detail}. The attempt's work is preserved on branch ${workspace.branch} at ${workspace.path}; resolve and merge it manually, then remove the worktree.`,
		},
	};
}

/**
 * Release the transaction. Refuses while a winner is preserved, so a cleanup
 * pass cannot destroy the only successful result after a failed apply.
 */
export function closeWorkspaceTransaction(transaction: WorkspaceTransaction): void {
	if (transaction.ownership.state === "winner-preserved") {
		throw new Error(
			`workspace transaction ${transaction.assignmentId} preserves an unapplied winner; refusing to clean it up`,
		);
	}
	cleanupWorktreeGroup(markCompeteGroupCleanupReady(transaction.ownership));
}
