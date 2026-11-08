/**
 * The git a campaign needs: the research branch created at the base and moved only by compare-and-swap, a detached
 * worktree per side, and the commit of an agent's change with the host identity a task worktree uses.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { internalGitArgv } from "../../core/internal-git.js";
import { hostCommitIdentity } from "../../tools/task-worktree.js";
import { RESEARCH_COMMIT_IDENTITY } from "./types.js";

export function git(cwd: string, args: ReadonlyArray<string>): string {
	return execFileSync("git", internalGitArgv(["-C", cwd, ...args]), {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 60_000,
		maxBuffer: 64 * 1024 * 1024,
	})
		.toString("utf8")
		.trim();
}

export function gitFailure(error: unknown): string {
	const stderr =
		error !== null && typeof error === "object" && "stderr" in error
			? String((error as { stderr?: unknown }).stderr ?? "")
			: "";
	const line = stderr.split(/\r?\n/u).find((entry) => entry.trim().length > 0);
	return line?.trim() ?? (error instanceof Error ? error.message : String(error));
}

export function resolveCommit(cwd: string, rev: string): string {
	return git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
}

export function treeOf(cwd: string, commit: string): string {
	return git(cwd, ["rev-parse", "--verify", "--quiet", `${commit}^{tree}`]);
}

/** Create the research branch at `base`; fails when the ref already exists. */
export function createResearchRef(root: string, ref: string, base: string): void {
	git(root, ["update-ref", "-m", "clio-coder research: open", ref, base, ""]);
}

/** The research branch's tip, or null when it does not exist. */
export function readResearchRef(root: string, ref: string): string | null {
	try {
		return git(root, ["rev-parse", "--verify", "--quiet", ref]);
	} catch {
		return null;
	}
}

/** Move the research branch from `from` to `to` only if it still points at `from`. */
export function casResearchRef(root: string, ref: string, to: string, from: string, message: string): boolean {
	try {
		git(root, ["update-ref", "-m", message, ref, to, from]);
		return true;
	} catch {
		return false;
	}
}

export function researchWorktreeParent(root: string): string {
	return join(root, ".clio-coder", "worktrees");
}

/** A detached worktree at `commit`. */
export function addResearchWorktree(root: string, path: string, commit: string): void {
	mkdirSync(researchWorktreeParent(root), { recursive: true });
	git(root, ["worktree", "add", "--detach", "--quiet", path, commit]);
}

export function removeResearchWorktree(root: string, path: string): void {
	try {
		if (existsSync(path)) git(root, ["worktree", "remove", "--force", path]);
	} finally {
		try {
			git(root, ["worktree", "prune"]);
		} catch {
			// Prune is hygiene; the removal above decides whether the tree is gone.
		}
	}
}

export function checkoutDetached(worktree: string, commit: string): void {
	git(worktree, ["checkout", "--quiet", "--detach", commit]);
}

/**
 * Commit everything the agent left in the worktree, untracked files included, on top of whatever it committed
 * itself. Returns HEAD afterwards, which equals `parent` when nothing changed.
 */
export function commitWorktree(worktree: string, message: string): string {
	git(worktree, ["add", "--all"]);
	const staged = git(worktree, ["diff", "--cached", "--name-only"]);
	if (staged.length > 0)
		git(worktree, [
			...hostCommitIdentity(worktree, RESEARCH_COMMIT_IDENTITY),
			"commit",
			"--quiet",
			"--no-verify",
			"-m",
			message,
		]);
	return resolveCommit(worktree, "HEAD");
}

/** Repository-relative paths that differ between two commits. */
export function changedPaths(cwd: string, from: string, to: string): string[] {
	const out = git(cwd, ["diff", "--name-only", "--no-renames", "-z", from, to]);
	return out.split("\0").filter((path) => path.length > 0);
}
