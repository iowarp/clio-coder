/**
 * Scratch git worktrees for the compete dispatch topology.
 *
 * Each candidate builds in its own worktree on its own branch
 * (`clio/compete/<group>/<n>`), created from the repository HEAD under
 * `<root>/.clio/worktrees/<group>/candidate-<n>`. The path sits inside the
 * project root because remote fleet nodes share the filesystem and doctor
 * preflight verifies path parity only for the project root; `.clio/` is
 * ignored, so candidate churn never dirties the repository status.
 *
 * After a candidate's builder finishes, its work is committed in the worktree
 * so the branch carries the full result: judges rank durable commits, the
 * winner applies with a plain merge, and losers are removed without loss of
 * evidence (the receipt chain still references the candidate runs).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface CandidateWorktree {
	index: number;
	branch: string;
	path: string;
}

function git(root: string, args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
	}).trim();
}

export function isGitRepository(root: string): boolean {
	try {
		return git(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
	} catch {
		return false;
	}
}

export function competeBranch(group: string, index: number): string {
	return `clio/compete/${group}/${index}`;
}

export function createCandidateWorktree(root: string, group: string, index: number): CandidateWorktree {
	const branch = competeBranch(group, index);
	const path = join(root, ".clio", "worktrees", group, `candidate-${index}`);
	git(root, ["worktree", "add", "-b", branch, path, "HEAD"]);
	return { index, branch, path };
}

/**
 * Seal a candidate's work as one commit on its branch. Returns false when the
 * builder changed nothing (an empty candidate is a legitimate ranking fact).
 */
export function commitCandidateWork(worktree: CandidateWorktree, message: string): boolean {
	git(worktree.path, ["add", "-A"]);
	const staged = git(worktree.path, ["status", "--porcelain"]);
	if (staged.length === 0) return false;
	git(worktree.path, [
		"-c",
		"user.name=clio-compete",
		"-c",
		"user.email=clio-compete@local",
		"commit",
		"-m",
		message,
		"--no-verify",
	]);
	return true;
}

/** One-line stat summary of what a candidate branch changed relative to HEAD. */
export function candidateDiffStat(root: string, branch: string): string {
	try {
		return git(root, ["diff", "--shortstat", `HEAD...${branch}`]) || "no changes";
	} catch {
		return "diff unavailable";
	}
}

export function removeCandidateWorktree(root: string, worktree: CandidateWorktree, deleteBranch: boolean): void {
	try {
		git(root, ["worktree", "remove", "--force", worktree.path]);
	} catch {
		// The worktree may already be gone (crash, manual cleanup); fall through
		// to the directory and branch cleanup below.
		try {
			if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
			git(root, ["worktree", "prune"]);
		} catch {
			// Best-effort: a stale dir is swept by the next compete run.
		}
	}
	if (deleteBranch) {
		try {
			git(root, ["branch", "-D", worktree.branch]);
		} catch {
			// Branch already gone or never created.
		}
	}
}

/**
 * Merge the winning candidate branch into the current branch. Fast-forward
 * is impossible by construction (the candidate branched from HEAD and HEAD
 * may have moved), so a regular merge commit is created; a conflict aborts
 * the merge and reports failure so the operator decides.
 */
export function mergeWinnerBranch(root: string, branch: string): { ok: true } | { ok: false; reason: string } {
	try {
		git(root, [
			"-c",
			"user.name=clio-compete",
			"-c",
			"user.email=clio-compete@local",
			"merge",
			"--no-edit",
			"--no-verify",
			branch,
		]);
		return { ok: true };
	} catch (err) {
		try {
			git(root, ["merge", "--abort"]);
		} catch {
			// No merge in progress; nothing to abort.
		}
		return { ok: false, reason: err instanceof Error ? (err.message.split("\n")[0] ?? "merge failed") : String(err) };
	}
}

/**
 * Remove every worktree and branch of one compete group: the group directory
 * under `.clio/worktrees/<group>`, its registered worktrees, and its
 * `clio/compete/<group>/*` branches. Called from the compete flow's cleanup
 * (including abort paths) and after a winner is applied. Never sweeps other
 * groups, so a preserved winner awaiting apply_winner survives later runs.
 */
export function cleanupCompeteGroup(root: string, group: string): void {
	try {
		const groupDir = join(root, ".clio", "worktrees", group);
		const listing = git(root, ["worktree", "list", "--porcelain"]);
		for (const block of listing.split("\n\n")) {
			const line = block.split("\n").find((entry) => entry.startsWith("worktree "));
			const path = line?.slice("worktree ".length) ?? "";
			if (!path.startsWith(groupDir)) continue;
			try {
				git(root, ["worktree", "remove", "--force", path]);
			} catch {
				// Directory removal below still clears it; prune drops the record.
			}
		}
		if (existsSync(groupDir)) rmSync(groupDir, { recursive: true, force: true });
		const parent = join(root, ".clio", "worktrees");
		if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
		git(root, ["worktree", "prune"]);
		for (const branch of git(root, ["branch", "--list", `clio/compete/${group}/*`, "--format=%(refname:short)"])
			.split("\n")
			.filter((entry) => entry.length > 0)) {
			try {
				git(root, ["branch", "-D", branch]);
			} catch {
				// Branch already gone.
			}
		}
	} catch {
		// Cleanup is hygiene, never a dispatch failure.
	}
}
