/**
 * The ownership claim Clio writes beside the repository when she creates a task
 * worktree (`src/tools/task-worktree.ts`), and the one question the claim lets
 * a core leaf answer: which workspace did Clio create this worktree from.
 * Workspace trust uses it to let a worktree inherit its origin's approval.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const SAFE_TASK_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const TASK_WORKTREE_OWNER_SUFFIX = ".task-owner.json";
export const TASK_WORKTREE_KIND = "clio-coder-task-worktree";
export const LEGACY_TASK_WORKTREE_KIND = "clio-task-worktree";

/** The claim always lives on disk with the repository, wherever the working tree is. */
export function taskWorktreeClaimParent(projectRoot: string): string {
	return join(projectRoot, ".clio-coder", "worktrees");
}

/**
 * The canonical root of the repository Clio created `workspace` from, or null
 * when `workspace` is not a task worktree she created. The worktree's own
 * `.git` file only locates the repository; the authority is the claim inside
 * that repository naming this exact path, which nothing in the worktree can
 * forge.
 */
export function taskWorktreeOrigin(workspace: string): string | null {
	try {
		const worktree = realpathSync(resolve(workspace));
		const dotGit = join(worktree, ".git");
		// A linked worktree's `.git` is a file; a primary checkout's is a directory.
		if (!lstatSync(dotGit).isFile()) return null;
		const gitdir = /^gitdir:\s*(.+?)\s*$/mu.exec(readFileSync(dotGit, "utf8"))?.[1];
		if (gitdir === undefined) return null;
		const linkedGitDir = resolve(worktree, gitdir);
		const commonDir = resolve(linkedGitDir, readFileSync(join(linkedGitDir, "commondir"), "utf8").trim());
		if (basename(commonDir) !== ".git") return null;
		const origin = realpathSync(dirname(commonDir));
		const runId = basename(worktree);
		if (!SAFE_TASK_RUN_ID.test(runId)) return null;
		const claim: unknown = JSON.parse(
			readFileSync(join(taskWorktreeClaimParent(origin), `${runId}${TASK_WORKTREE_OWNER_SUFFIX}`), "utf8"),
		);
		if (claim === null || typeof claim !== "object" || Array.isArray(claim)) return null;
		const marker = claim as Record<string, unknown>;
		if (
			(marker.version !== 1 && marker.version !== 2) ||
			(marker.kind !== TASK_WORKTREE_KIND && marker.kind !== LEGACY_TASK_WORKTREE_KIND) ||
			marker.runId !== runId ||
			typeof marker.root !== "string" ||
			realpathSync(marker.root) !== origin ||
			typeof marker.path !== "string" ||
			realpathSync(marker.path) !== worktree
		) {
			return null;
		}
		return origin;
	} catch {
		// Not a worktree, no claim, or an unreadable one: nothing is inherited.
		return null;
	}
}
