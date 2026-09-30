import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface TaskWorktreeGitLayout {
	/** The worktree's own admin directory, `<common>/worktrees/<id>`. */
	adminDir: string;
	/** The shared repository directory every worktree of the checkout uses. */
	commonDir: string;
}

function physical(entry: string): string {
	try {
		return realpathSync(entry);
	} catch {
		// A path that does not resolve keeps its lexical spelling; the sandbox
		// binds it with -try and skips it when it is absent.
		return path.resolve(entry);
	}
}

/**
 * Resolve a linked worktree's Git directories from its `.git` file and the
 * admin directory's `commondir`, without spawning Git. Returns null for a
 * checkout whose `.git` is a directory or unreadable.
 */
export function readTaskWorktreeGitLayout(worktreePath: string): TaskWorktreeGitLayout | null {
	let gitFile: string;
	try {
		gitFile = readFileSync(path.join(worktreePath, ".git"), "utf8");
	} catch {
		// Not a linked worktree (a `.git` directory reads as EISDIR) or unreadable.
		return null;
	}
	const match = /^gitdir:\s*(.+?)\s*$/mu.exec(gitFile);
	if (match?.[1] === undefined) return null;
	const adminDir = path.resolve(worktreePath, match[1]);
	let commonDir: string;
	try {
		commonDir = path.resolve(adminDir, readFileSync(path.join(adminDir, "commondir"), "utf8").trim());
	} catch {
		// Without commondir Git treats the admin directory as the repository.
		commonDir = adminDir;
	}
	return { adminDir: physical(adminDir), commonDir: physical(commonDir) };
}

/**
 * Git metadata a worker must write for `git add` and `git commit` on its task
 * branch in a linked worktree: the object store, the worktree's own admin
 * directory (index, HEAD, its reflog), and the ref and reflog directories that
 * hold the task branch. Git creates `<ref>.lock` beside the ref and renames it
 * into place, so the containing directory must be writable, not only the ref
 * file. For `clio-coder/task/<runId>` that directory is shared by every task
 * branch of the checkout; that is a known widening a per-branch directory
 * layout would remove.
 *
 * Everything else under the common directory (config, hooks, HEAD, packed-refs,
 * other branches, tags) stays read-only. Typed Git (Phase C) supplies its own
 * set through the same WorkerSandboxSpec field rather than editing this.
 */
export function taskWorktreeGitWritablePaths(layout: TaskWorktreeGitLayout, branch: string): string[] {
	const branchDir = path.posix.dirname(branch);
	const refDir = branchDir === "." ? "" : branchDir;
	return [
		path.join(layout.commonDir, "objects"),
		layout.adminDir,
		path.join(layout.commonDir, "refs", "heads", refDir),
		path.join(layout.commonDir, "logs", "refs", "heads", refDir),
	];
}
