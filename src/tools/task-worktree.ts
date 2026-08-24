import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type TaskWorktreeApply = "merge" | "preserve";

export interface TaskWorktree {
	root: string;
	runId: string;
	path: string;
	branch: string;
	base: string;
	ownerToken: string;
}

export interface TaskWorktreeReceipt {
	path: string;
	branch: string;
	diffHash: string;
	apply: TaskWorktreeApply;
	applied: boolean;
	reason?: string;
}

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OWNER_FILE_SUFFIX = ".task-owner.json";
const COMMIT_IDENTITY = "clio-task";

function gitBytes(root: string, args: string[]): Buffer {
	return execFileSync("git", ["-C", root, ...args], {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
	});
}

function git(root: string, args: string[]): string {
	return gitBytes(root, args).toString("utf8").trim();
}

export function isCanonicalWorktreePathInside(parent: string, candidate: string): boolean {
	let canonicalParent: string;
	let canonicalCandidate: string;
	try {
		canonicalParent = realpathSync(parent);
	} catch {
		canonicalParent = resolve(parent);
	}
	try {
		canonicalCandidate = realpathSync(candidate);
	} catch {
		canonicalCandidate = resolve(candidate);
	}
	const rel = relative(canonicalParent, canonicalCandidate);
	return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function commitWorktreePath(path: string, identity: string, message: string): boolean {
	git(path, ["add", "-A"]);
	if (git(path, ["status", "--porcelain"]).length === 0) return false;
	git(path, [
		"-c",
		`user.name=${identity}`,
		"-c",
		`user.email=${identity}@local`,
		"commit",
		"-m",
		message,
		"--no-verify",
	]);
	return true;
}

export function worktreeBranchDiffStat(root: string, branch: string): string {
	try {
		return git(root, ["diff", "--shortstat", `HEAD...${branch}`]) || "no changes";
	} catch {
		return "diff unavailable";
	}
}

export function protectedPathsChangedByWorktreeBranch(
	root: string,
	branch: string,
	protectedPaths: ReadonlyArray<string>,
): string[] {
	const canonical = realpathSync(root);
	const protectedInside = protectedPaths
		.map((path) => resolve(path))
		.filter((path) => {
			const rel = relative(canonical, path);
			return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
		});
	if (protectedInside.length === 0) return [];
	const changed = git(canonical, ["diff", "--name-only", "-z", "--no-renames", `HEAD...${branch}`])
		.split("\0")
		.filter((path) => path.length > 0)
		.map((path) => resolve(canonical, path));
	const blocked = new Set<string>();
	for (const candidate of changed) {
		for (const protectedPath of protectedInside) {
			const rel = relative(protectedPath, candidate);
			if (
				candidate === protectedPath ||
				(rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
			) {
				blocked.add(protectedPath);
			}
		}
	}
	return [...blocked].sort();
}

export function mergeWorktreeBranch(
	root: string,
	branch: string,
	identity: string,
): { ok: true } | { ok: false; reason: string } {
	try {
		git(root, [
			"-c",
			`user.name=${identity}`,
			"-c",
			`user.email=${identity}@local`,
			"merge",
			"--no-edit",
			"--no-verify",
			branch,
		]);
		return { ok: true };
	} catch (error) {
		try {
			git(root, ["merge", "--abort"]);
		} catch {
			// No merge remains to abort.
		}
		return {
			ok: false,
			reason: error instanceof Error ? (error.message.split("\n")[0] ?? "merge failed") : String(error),
		};
	}
}

function validateRunId(runId: string): void {
	if (!SAFE_RUN_ID.test(runId) || runId === "." || runId === "..")
		throw new Error(`invalid task worktree run id '${runId}'`);
}

export function gitCheckoutRoot(cwd: string): string | null {
	try {
		return realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
	} catch {
		return null;
	}
}

export function createTaskWorktree(root: string, runId: string, base?: string): TaskWorktree {
	validateRunId(runId);
	const canonical = realpathSync(root);
	const resolvedBase = base ?? git(canonical, ["rev-parse", "HEAD"]);
	const parent = join(canonical, ".clio-coder", "worktrees");
	const path = join(parent, runId);
	const branch = `clio/task/${runId}`;
	mkdirSync(parent, { recursive: true });
	if (!isCanonicalWorktreePathInside(parent, path))
		throw new Error(`task worktree path escapes its parent for run ${runId}`);
	git(canonical, ["worktree", "add", "-b", branch, path, resolvedBase]);
	const ownerToken = randomBytes(16).toString("hex");
	writeFileSync(
		`${path}${OWNER_FILE_SUFFIX}`,
		`${JSON.stringify({ version: 1, kind: "clio-task-worktree", root: canonical, runId, branch, base: resolvedBase, ownerToken }, null, 2)}\n`,
		{ encoding: "utf8", flag: "wx" },
	);
	return { root: canonical, runId, path, branch, base: resolvedBase, ownerToken };
}

function assertOwnership(worktree: TaskWorktree): void {
	const expected = join(worktree.root, ".clio-coder", "worktrees", worktree.runId);
	if (
		resolve(worktree.path) !== resolve(expected) ||
		!isCanonicalWorktreePathInside(join(worktree.root, ".clio-coder", "worktrees"), worktree.path)
	) {
		throw new Error(`task worktree ${worktree.runId} has an invalid ownership path`);
	}
	if (!existsSync(`${worktree.path}${OWNER_FILE_SUFFIX}`))
		throw new Error(`task worktree ${worktree.runId} has no ownership file`);
}

function commitTaskWorktree(worktree: TaskWorktree, message = `Clio task ${worktree.runId}`): boolean {
	assertOwnership(worktree);
	return commitWorktreePath(worktree.path, COMMIT_IDENTITY, message);
}

function taskWorktreeDiffHash(worktree: Pick<TaskWorktree, "root" | "base" | "branch">): string {
	const bytes = gitBytes(worktree.root, ["diff", `${worktree.base}..${worktree.branch}`]);
	return createHash("sha256").update(bytes).digest("hex");
}

function protectedPathsChangedByTaskBranch(
	worktree: Pick<TaskWorktree, "root" | "branch">,
	protectedPaths: ReadonlyArray<string>,
): string[] {
	return protectedPathsChangedByWorktreeBranch(worktree.root, worktree.branch, protectedPaths);
}

export function applyTaskWorktree(input: {
	worktree: TaskWorktree;
	apply: TaskWorktreeApply;
	protectedPaths?: ReadonlyArray<string>;
}): TaskWorktreeReceipt {
	assertOwnership(input.worktree);
	commitTaskWorktree(input.worktree);
	const receipt: TaskWorktreeReceipt = {
		path: input.worktree.path,
		branch: input.worktree.branch,
		diffHash: taskWorktreeDiffHash(input.worktree),
		apply: input.apply,
		applied: false,
	};
	if (input.apply === "preserve") return receipt;
	const protectedChanges = protectedPathsChangedByTaskBranch(input.worktree, input.protectedPaths ?? []);
	if (protectedChanges.length > 0) return { ...receipt, reason: "protected_artifact_changed" };
	const merged = mergeWorktreeBranch(input.worktree.root, input.worktree.branch, COMMIT_IDENTITY);
	if (!merged.ok) return { ...receipt, reason: "worktree_merge_conflict" };
	return { ...receipt, applied: true };
}

export function cleanupTaskWorktree(worktree: TaskWorktree, deleteBranch: boolean): void {
	assertOwnership(worktree);
	try {
		git(worktree.root, ["worktree", "remove", "--force", worktree.path]);
	} catch {
		if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
		git(worktree.root, ["worktree", "prune"]);
	}
	if (deleteBranch) git(worktree.root, ["branch", "-D", worktree.branch]);
	rmSync(`${worktree.path}${OWNER_FILE_SUFFIX}`, { force: true });
}
