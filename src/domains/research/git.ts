/**
 * The git a campaign needs: the research branch created at the base and moved only by compare-and-swap, a detached
 * worktree per side, and the commit of an agent's change with the host identity a task worktree uses.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { internalGitArgv, withoutRepositoryEnv } from "../../core/internal-git.js";
import { hostCommitIdentity } from "../../tools/task-worktree.js";
import { RESEARCH_COMMIT_IDENTITY } from "./types.js";

export function git(cwd: string, args: ReadonlyArray<string>): string {
	return execFileSync("git", internalGitArgv(["-C", cwd, ...args]), {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 60_000,
		maxBuffer: 64 * 1024 * 1024,
		env: withoutRepositoryEnv(),
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
 * Untracked, unignored entries of a worktree, repository-relative. A directory that holds only untracked files is one
 * `dir/` entry, so a cache directory a check creates is named once whatever files land in it later.
 */
export function untrackedEntries(worktree: string): string[] {
	return git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames"])
		.split("\0")
		.filter((entry) => entry.startsWith("?? "))
		.map((entry) => entry.slice(3));
}

/** Whether an untracked file is one of `entries` or lies in a `dir/` entry. */
export function withinEntries(path: string, entries: ReadonlySet<string>): boolean {
	if (entries.has(path)) return true;
	for (const entry of entries) if (entry.endsWith("/") && path.startsWith(entry)) return true;
	return false;
}

/**
 * Untracked and ignored entries of a worktree, repository-relative; a wholly untracked or ignored directory is one
 * `dir/` entry. Taken before the agent runs, it is the environment a candidate keeps (an installed `node_modules`).
 */
export function environmentEntries(worktree: string): string[] {
	return git(worktree, ["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=normal", "--no-renames"])
		.split("\0")
		.filter((entry) => entry.startsWith("?? ") || entry.startsWith("!! "))
		.map((entry) => entry.slice(3));
}

/**
 * A fingerprint of every file under `entries` (relative path, type, size, mtime in nanoseconds and a link's target),
 * read with lstat and never following a link. Taken before and after the agent run, it shows whether the agent touched
 * the environment a candidate keeps.
 */
export function fingerprintEntries(worktree: string, entries: ReadonlyArray<string>): Map<string, string> {
	const prints = new Map<string, string>();
	const visit = (relativePath: string): void => {
		const path = join(worktree, relativePath);
		const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
		if (stat === undefined) return;
		if (stat.isDirectory()) {
			prints.set(`${relativePath}/`, "dir");
			for (const name of readdirSync(path).sort()) visit(`${relativePath}/${name}`);
			return;
		}
		const kind = stat.isSymbolicLink() ? `link:${readlinkSync(path)}` : stat.isFile() ? "file" : "other";
		prints.set(relativePath, `${kind}:${stat.size}:${stat.mtimeNs}`);
	};
	for (const entry of entries) visit(entry.endsWith("/") ? entry.slice(0, -1) : entry);
	return prints;
}

/** Paths added, removed or changed between two fingerprints, sorted. */
export function fingerprintChanges(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
	const changed = new Set<string>();
	for (const [path, print] of before) if (after.get(path) !== print) changed.add(path);
	for (const path of after.keys()) if (!before.has(path)) changed.add(path);
	return [...changed].sort();
}

/** An exclude pattern that matches exactly one repository-relative entry. */
function exactPattern(entry: string): string {
	return `/${entry.replace(/[\\*?[\]]/gu, (char) => `\\${char}`)}`;
}

/**
 * Remove every untracked and ignored file except the `keep` entries, so the worktree holds its HEAD tree plus the
 * environment it had before the agent ran.
 */
export function cleanWorktree(worktree: string, keep: ReadonlyArray<string> = []): void {
	git(worktree, ["clean", "-ffdxq", ...keep.flatMap((entry) => ["-e", exactPattern(entry)])]);
}

/**
 * Commit everything the agent left in the worktree, untracked files included, on top of whatever it committed
 * itself, except untracked files `leaveOut` names. Returns HEAD afterwards, which equals `parent` when nothing
 * changed, and the untracked files left out.
 */
export function commitWorktree(
	worktree: string,
	message: string,
	leaveOut: (path: string) => boolean = () => false,
): { head: string; leftOut: string[] } {
	const leftOut = git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])
		.split("\0")
		.filter((path) => path.length > 0 && leaveOut(path));
	git(worktree, ["add", "--all"]);
	if (leftOut.length > 0) git(worktree, ["reset", "--quiet", "--", ...leftOut.map((path) => `:(literal)${path}`)]);
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
	return { head: resolveCommit(worktree, "HEAD"), leftOut };
}

/** Repository-relative paths that differ between two commits. */
export function changedPaths(cwd: string, from: string, to: string): string[] {
	const out = git(cwd, ["diff", "--name-only", "--no-renames", "-z", from, to]);
	return out.split("\0").filter((path) => path.length > 0);
}
