import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stripAuthoredTrailers } from "../core/commit-message.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { currentProcessLease, ownerIsAlive, type ProcessLease, validProcessLease } from "./process-lease.js";
import { diskWorktreeParent } from "./worktree-root.js";

export type TaskWorktreeApply = "merge" | "preserve";

export interface TaskWorktree {
	root: string;
	runId: string;
	/** `<parent>/<runId>`. */
	path: string;
	/**
	 * Directory the working tree was created in: the project-root location or
	 * the resolved `fleet.worktrees.root`. Absent on a value built before the
	 * root was configurable, which always means the project-root location.
	 */
	parent?: string;
	branch: string;
	base: string;
	ownerToken: string;
}

/**
 * Where a claim stands. `active` is a run in flight, or one whose owner died
 * before it settled. `settled` is a finished run that kept its worktree on
 * purpose (apply mode preserve, a failed run, a merge conflict). `abandoned`
 * is a dead owner's worktree that restart recovery found holding work and
 * kept for the operator; it is reported once at startup and listed by doctor.
 */
export type TaskWorktreeState = "active" | "settled" | "abandoned";

/** A task worktree that outlived its run, as doctor and recovery report it. */
export interface PreservedTaskWorktree {
	runId: string;
	path: string;
	/** The claim file, always under the project root. */
	claimPath: string;
	branch: string;
	base: string;
	state: TaskWorktreeState;
	/** ISO UTC instant the claim was written; null for a claim older than recovery. */
	createdAt: string | null;
	/** Why recovery kept it rather than removing it. */
	reason: string;
}

export interface TaskWorktreeRecoveryResult {
	removed: string[];
	preserved: PreservedTaskWorktree[];
	failed: Array<{ runId: string; message: string }>;
}

export interface TaskWorktreeReceipt {
	path: string;
	branch: string;
	/** Null when no trustworthy diff exists: an unreadable snapshot, or a worktree whose HEAD moved. */
	diffHash: string | null;
	changedPaths?: string[];
	/** Absent means the diff is committed on the task branch. */
	snapshot?: "working-tree" | "unavailable";
	/** The task commit pinned at snapshot time; application merges this id, never the mutable branch name (F5). */
	commit?: string;
	apply: TaskWorktreeApply;
	applied: boolean;
	reason?: string;
	/** Human-readable explanation of `reason` when the code alone does not carry it. */
	detail?: string;
}

/** Receipt reason for a task worktree whose HEAD no longer names its own task branch (F5). */
export const WORKTREE_HEAD_MOVED = "worktree_head_moved";

/** Receipt reason for a merge refused because the worktree no longer holds the commit an operator was shown. */
export const WORKTREE_CHANGED_SINCE_PREVIEW = "worktree_changed_since_preview";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OWNER_FILE_SUFFIX = ".task-owner.json";
const TASK_WORKTREE_KIND = "clio-coder-task-worktree";
const LEGACY_TASK_WORKTREE_KIND = "clio-task-worktree";
/** Identity of commits the host makes on a task branch, and of worker commits when the repository names none. */
export const COMMIT_IDENTITY = "clio-coder-task";

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

export function commitWorktreePath(
	path: string,
	identity: string,
	message: string,
	excludedPaths: ReadonlyArray<string> = [],
): boolean {
	// Runtime state can already be staged by a worker. Reset only these exact
	// index entries, leaving their working files and every authored path intact.
	if (excludedPaths.length > 0) {
		git(path, ["reset", "-q", "HEAD", "--", ...excludedPaths.map((entry) => `:(top,literal)${entry}`)]);
	}
	git(path, ["add", "-A", "--", ".", ...excludedPaths.map((entry) => `:(top,exclude,literal)${entry}`)]);
	if (git(path, ["diff", "--cached", "--name-only", "-z"]).length === 0) return false;
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
	/** Merge commit message; git's default names `branch`, which reads badly when it is a commit id. */
	message?: string,
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
			...(message !== undefined ? ["-m", message] : []),
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

/**
 * Refusal for a task worktree requested in a repository with no commits. A
 * worktree branches from a commit, and an unborn HEAD has none, so the request
 * is refused before any mode split rather than failing inside `git worktree add`
 * with a raw rev-parse error on one path and not another (D4).
 */
export const WORKTREE_UNBORN_HEAD_MESSAGE =
	"worktree_unborn_head: the repository has no commits, so a task worktree has nothing to branch from. Make an initial commit, or dispatch without worktree.";

/** Whether a checkout's HEAD names no commit yet (`git init` with nothing committed). */
export function gitHeadIsUnborn(root: string): boolean {
	try {
		git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
		return false;
	} catch {
		return true;
	}
}

/** The claim always lives on disk with the repository, wherever the working tree is. */
function claimPathFor(root: string, runId: string): string {
	return join(diskWorktreeParent(root), `${runId}${OWNER_FILE_SUFFIX}`);
}

const CLAIMS_EXCLUDE_PATTERN = "/.clio-coder/worktrees/";

/**
 * Keep the claim directory out of the operator's `git status`. The claim JSON
 * and any on-disk worktree live under the project root, and an untracked
 * `.clio-coder/` in the operator's repo is noise Clio must not create. The
 * checkout's own `info/exclude` is used so no tracked file changes.
 */
function excludeClaimsFromStatus(root: string): void {
	try {
		const excludePath = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
		const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
		if (current.split(/\r?\n/u).includes(CLAIMS_EXCLUDE_PATTERN)) return;
		safeResourceWrite(
			excludePath,
			`${current}${current.length === 0 || current.endsWith("\n") ? "" : "\n"}${CLAIMS_EXCLUDE_PATTERN}\n`,
		);
	} catch {
		// Best effort: an unwritable info/exclude leaves the claim visible to git status, and the run is unaffected.
	}
}

export function createTaskWorktree(
	root: string,
	runId: string,
	base?: string,
	apply: TaskWorktreeApply = "merge",
	/** Resolved `fleet.worktrees.root` parent; the project-root location when absent. */
	worktreeParent?: string,
): TaskWorktree {
	validateRunId(runId);
	const canonical = realpathSync(root);
	if (base === undefined && gitHeadIsUnborn(canonical)) throw new Error(WORKTREE_UNBORN_HEAD_MESSAGE);
	const resolvedBase = base ?? git(canonical, ["rev-parse", "HEAD"]);
	const claimParent = diskWorktreeParent(canonical);
	const parent = worktreeParent ?? claimParent;
	const path = join(parent, runId);
	const branch = `clio-coder/task/${runId}`;
	mkdirSync(claimParent, { recursive: true });
	excludeClaimsFromStatus(canonical);
	// Off the project root the directory may sit on a filesystem other users
	// share (/dev/shm), so it is ours alone.
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	if (!isCanonicalWorktreePathInside(parent, path))
		throw new Error(`task worktree path escapes its parent for run ${runId}`);
	// Bound checkout parallelism for off-disk tasks: fleet workers already compete for CPUs.
	git(canonical, [
		...(parent !== claimParent ? ["-c", "checkout.workers=4"] : []),
		"worktree",
		"add",
		"-b",
		branch,
		path,
		resolvedBase,
	]);
	const ownerToken = randomBytes(16).toString("hex");
	writeFileSync(
		claimPathFor(canonical, runId),
		`${JSON.stringify(
			{
				version: 2,
				kind: TASK_WORKTREE_KIND,
				root: canonical,
				runId,
				branch,
				base: resolvedBase,
				ownerToken,
				// What restart recovery needs to tell a crashed run from a live one.
				state: "active" satisfies TaskWorktreeState,
				apply,
				createdAt: new Date().toISOString(),
				owner: currentProcessLease(),
				path,
			},
			null,
			2,
		)}\n`,
		{ encoding: "utf8", flag: "wx" },
	);
	return { root: canonical, runId, path, parent, branch, base: resolvedBase, ownerToken };
}

const DEPENDENCY_INPUTS = {
	node_modules: [
		"package.json",
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
		"package-lock.json",
		"yarn.lock",
		"bun.lock",
		"bun.lockb",
		".npmrc",
	],
	".venv": [
		"pyproject.toml",
		"uv.lock",
		"poetry.lock",
		"Pipfile",
		"Pipfile.lock",
		"requirements.txt",
		"setup.py",
		"setup.cfg",
	],
};

function dependencyInput(path: string): Buffer | null {
	try {
		return readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** Reuse installed environments only when the caller enforces these returned roots as read-only. */
export function shareTaskWorktreeDependencies(worktree: TaskWorktree): string[] {
	if (isCanonicalWorktreePathInside(worktree.root, worktree.path)) return [];
	assertOwnership(worktree);
	const readOnlyRoots = new Set<string>();
	for (const [name, inputs] of Object.entries(DEPENDENCY_INPUTS)) {
		let source: string;
		try {
			source = realpathSync(join(worktree.root, name));
			if (!lstatSync(source).isDirectory()) continue;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		// An environment may link workspace packages beside it; protect that checkout too.
		const sourceRoot = dirname(source);
		if (sourceRoot === worktree.path || isCanonicalWorktreePathInside(sourceRoot, worktree.path)) continue;
		if (
			!inputs.every((name) => {
				const parent = dependencyInput(join(worktree.root, name));
				const task = dependencyInput(join(worktree.path, name));
				return parent === null ? task === null : task !== null && parent.equals(task);
			})
		) {
			continue;
		}
		try {
			git(worktree.path, ["check-ignore", "-q", "--", `${name}/`]);
		} catch (error) {
			if ((error as { status?: number }).status === 1) continue;
			throw error;
		}
		const destination = join(worktree.path, name);
		if (!existsSync(destination)) {
			// A real ignored directory keeps links out of commits even with a `node_modules/` rule.
			mkdirSync(destination);
			try {
				for (const entry of readdirSync(source)) symlinkSync(join(source, entry), join(destination, entry));
			} catch (error) {
				rmSync(destination, { recursive: true, force: true });
				throw error;
			}
		}
		readOnlyRoots.add(worktree.root);
		readOnlyRoots.add(sourceRoot);
	}
	return [...readOnlyRoots];
}

function assertOwnership(worktree: TaskWorktree): void {
	const parent = worktree.parent ?? diskWorktreeParent(worktree.root);
	const expected = join(parent, worktree.runId);
	if (resolve(worktree.path) !== resolve(expected) || !isCanonicalWorktreePathInside(parent, worktree.path)) {
		throw new Error(`task worktree ${worktree.runId} has an invalid ownership path`);
	}
	const ownerPath = claimPathFor(worktree.root, worktree.runId);
	if (!existsSync(ownerPath)) throw new Error(`task worktree ${worktree.runId} has no ownership file`);
	let marker: Record<string, unknown>;
	try {
		const value = JSON.parse(readFileSync(ownerPath, "utf8")) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
		marker = value as Record<string, unknown>;
	} catch {
		throw new Error(`task worktree ${worktree.runId} has an invalid ownership file`);
	}
	if (
		(marker.version !== 1 && marker.version !== 2) ||
		(marker.kind !== TASK_WORKTREE_KIND && marker.kind !== LEGACY_TASK_WORKTREE_KIND) ||
		marker.root !== worktree.root ||
		marker.runId !== worktree.runId ||
		marker.branch !== worktree.branch ||
		marker.base !== worktree.base ||
		marker.ownerToken !== worktree.ownerToken ||
		// A claim that names a path names this one; an older claim names none.
		(marker.path !== undefined && marker.path !== worktree.path)
	) {
		throw new Error(`task worktree ${worktree.runId} ownership facts do not match`);
	}
}

function canonicalOrResolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

type TaskHeadCheck = { ok: true; commit: string } | { ok: false; detail: string };

function headMovedDetail(worktree: TaskWorktree, actual: string, candidate: string | null): string {
	return `${WORKTREE_HEAD_MOVED}: task worktree ${worktree.runId} expected HEAD refs/heads/${worktree.branch}, found ${actual}; candidate commit ${candidate ?? "none"}. Nothing was committed or merged; the worktree and its branch are preserved.`;
}

/**
 * Whether the working tree at `worktree.path` is still this run's task
 * worktree with HEAD on its own branch. A worker can switch branches or detach
 * HEAD; committing there put its work on another branch while the receipt
 * reported the untouched task branch as an empty, successful diff (F5). Every
 * git fact is read from the working tree itself, not assumed from the claim.
 */
function checkTaskWorktreeHead(worktree: TaskWorktree): TaskHeadCheck {
	assertOwnership(worktree);
	let headCommit: string | null = null;
	try {
		headCommit = git(worktree.path, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
	} catch {
		// An unreadable HEAD is reported as a mismatch below rather than thrown.
	}
	const candidate = headCommit !== null && headCommit !== worktree.base ? headCommit : null;
	const moved = (actual: string): TaskHeadCheck => ({ ok: false, detail: headMovedDetail(worktree, actual, candidate) });
	try {
		const top = git(worktree.path, ["rev-parse", "--show-toplevel"]);
		if (canonicalOrResolved(top) !== canonicalOrResolved(worktree.path)) return moved(`a working tree rooted at ${top}`);
		const common = git(worktree.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const rootCommon = git(worktree.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		if (canonicalOrResolved(common) !== canonicalOrResolved(rootCommon))
			return moved(`a checkout of another repository (${common})`);
	} catch (error) {
		return moved(
			`no readable git checkout (${error instanceof Error ? (error.message.split("\n")[0] ?? "git failed") : String(error)})`,
		);
	}
	let symbolic = "";
	try {
		symbolic = git(worktree.path, ["symbolic-ref", "-q", "HEAD"]);
	} catch {
		// symbolic-ref exits nonzero on a detached HEAD, reported below.
	}
	if (symbolic.length === 0) return moved(`detached HEAD at ${headCommit ?? "unknown"}`);
	if (symbolic !== `refs/heads/${worktree.branch}`) return moved(symbolic);
	if (headCommit === null) return moved(`${symbolic} with no commit`);
	return { ok: true, commit: headCommit };
}

/**
 * Attest, at call time, that a Git command run in `cwd` acts on this run's own
 * task worktree with HEAD on its task branch (Phase C). The cwd must sit
 * inside the worktree and resolve to the worktree's own top level, so a nested
 * repository or a `.git` file the worker planted in a subdirectory cannot
 * redirect a commit elsewhere. Never throws: any failure is a refusal.
 */
export function attestTaskWorktreeCwd(
	worktree: TaskWorktree,
	cwd: string,
): { ok: true } | { ok: false; detail: string } {
	try {
		const top = canonicalOrResolved(worktree.path);
		const at = canonicalOrResolved(cwd);
		const rel = relative(top, at);
		if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
			return { ok: false, detail: `cwd ${cwd} is outside task worktree ${worktree.path}` };
		}
		const cwdTop = canonicalOrResolved(git(at, ["rev-parse", "--show-toplevel"]));
		if (cwdTop !== top) return { ok: false, detail: `cwd ${cwd} belongs to the working tree ${cwdTop}, not ${top}` };
		const head = checkTaskWorktreeHead(worktree);
		return head.ok ? { ok: true } : { ok: false, detail: head.detail };
	} catch (error) {
		return {
			ok: false,
			detail: `task worktree ${worktree.runId} could not be attested: ${error instanceof Error ? (error.message.split("\n")[0] ?? "git failed") : String(error)}`,
		};
	}
}

function headMovedReceipt(worktree: TaskWorktree, apply: TaskWorktreeApply, detail: string): TaskWorktreeReceipt {
	return {
		path: worktree.path,
		branch: worktree.branch,
		diffHash: null,
		snapshot: "unavailable",
		apply,
		applied: false,
		reason: WORKTREE_HEAD_MOVED,
		detail,
	};
}

function taskWorktreeDiffHash(worktree: Pick<TaskWorktree, "root" | "base">, commit: string): string {
	const bytes = gitBytes(worktree.root, ["diff", `${worktree.base}..${commit}`]);
	return createHash("sha256").update(bytes).digest("hex");
}

function nullDelimitedPaths(bytes: Buffer): string[] {
	return bytes.toString("utf8").split("\0").filter(Boolean).sort();
}

/** Preserve failure evidence without committing a peer's incomplete edits. */
export function snapshotTaskWorktree(worktree: TaskWorktree, apply: TaskWorktreeApply): TaskWorktreeReceipt {
	// A diff against a foreign HEAD would describe another branch's state (F5).
	const head = checkTaskWorktreeHead(worktree);
	if (!head.ok) return headMovedReceipt(worktree, apply, head.detail);
	// Against the base, not HEAD: commits the worker made on its task branch
	// (Phase C) are part of what it produced, alongside uncommitted edits.
	const tracked = gitBytes(worktree.path, ["diff", "--binary", worktree.base]);
	const untracked = nullDelimitedPaths(gitBytes(worktree.path, ["ls-files", "--others", "--exclude-standard", "-z"]));
	const changedPaths = [
		...new Set([
			...nullDelimitedPaths(gitBytes(worktree.path, ["diff", "--name-only", "-z", worktree.base])),
			...untracked,
		]),
	].sort();
	const hash = createHash("sha256").update("working-tree\0").update(tracked);
	for (const name of untracked) {
		const candidate = join(worktree.path, name);
		const stat = lstatSync(candidate);
		hash.update(name).update("\0").update(String(stat.mode)).update("\0");
		if (stat.isSymbolicLink()) hash.update(readlinkSync(candidate));
		else if (stat.isFile()) {
			const descriptor = openSync(candidate, "r");
			try {
				const buffer = Buffer.allocUnsafe(64 * 1024);
				for (;;) {
					const count = readSync(descriptor, buffer, 0, buffer.length, null);
					if (count === 0) break;
					hash.update(buffer.subarray(0, count));
				}
			} finally {
				closeSync(descriptor);
			}
		}
	}
	return {
		path: worktree.path,
		branch: worktree.branch,
		diffHash: hash.digest("hex"),
		changedPaths,
		snapshot: "working-tree",
		apply,
		applied: false,
	};
}

const BASE_DIFF_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Zero-context text diff of the worktree's tracked changes against its base,
 * for the merge gate to read removed lines from. Null when git cannot produce
 * it within the byte bound, so a huge or unreadable diff never blocks a run.
 */
export function taskWorktreeBaseDiff(worktree: TaskWorktree): string | null {
	try {
		return execFileSync("git", ["-C", worktree.path, "diff", "--no-color", "--no-ext-diff", "-U0", worktree.base], {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
			maxBuffer: BASE_DIFF_MAX_BYTES,
		}).toString("utf8");
	} catch {
		// Fail open: the gate is an extra signal, and its other checks still run.
		return null;
	}
}

function committedReceipt(worktree: TaskWorktree, commit: string, apply: TaskWorktreeApply): TaskWorktreeReceipt {
	return {
		path: worktree.path,
		branch: worktree.branch,
		diffHash: taskWorktreeDiffHash(worktree, commit),
		changedPaths: nullDelimitedPaths(
			gitBytes(worktree.root, ["diff", "--name-only", "-z", `${worktree.base}..${commit}`]),
		),
		commit,
		apply,
		applied: false,
	};
}

/** How a worktree no longer holds exactly the commit that was previewed, or null when it does. */
function previewDrift(worktree: TaskWorktree, pinned: string, head: string): string | null {
	if (head !== pinned) return `is now at ${head}`;
	// Ignored files never reach a commit, so only what a commit would take counts.
	if (gitBytes(worktree.path, ["status", "--porcelain", "-z"]).length > 0) return "has uncommitted changes";
	return null;
}

export function applyTaskWorktree(input: {
	worktree: TaskWorktree;
	apply: TaskWorktreeApply;
	protectedPaths?: ReadonlyArray<string>;
	/** The worker's validated `commitMessage`; a merge lands it on the operator's branch. */
	commitMessage?: string | null;
	/**
	 * Merge exactly this commit, one an earlier pass pinned and an operator was
	 * shown, instead of committing the working tree again. Refused unless the
	 * branch still names it and the tree holds nothing newer, so a window
	 * between the preview and the merge cannot land work nobody saw.
	 */
	pinnedCommit?: string;
}): TaskWorktreeReceipt {
	const { worktree } = input;
	const before = checkTaskWorktreeHead(worktree);
	if (!before.ok) return headMovedReceipt(worktree, input.apply, before.detail);
	let commit: string;
	if (input.pinnedCommit !== undefined) {
		commit = input.pinnedCommit;
		const found = previewDrift(worktree, commit, before.commit);
		if (found !== null) {
			const drift = `${WORKTREE_CHANGED_SINCE_PREVIEW}: task worktree ${worktree.runId} ${found} since commit ${commit} was offered for merge. Nothing was merged; the branch ${worktree.branch} is preserved.`;
			return { ...committedReceipt(worktree, commit, input.apply), reason: WORKTREE_CHANGED_SINCE_PREVIEW, detail: drift };
		}
	} else {
		const taskLine = `Clio Coder task ${worktree.runId}`;
		// The validated message is already stripped; this is the sink, and only
		// Clio's managed hook may write trailers onto the operator's branch.
		const authored =
			input.commitMessage === undefined || input.commitMessage === null
				? undefined
				: stripAuthoredTrailers(input.commitMessage);
		commitWorktreePath(
			worktree.path,
			COMMIT_IDENTITY,
			authored !== undefined && authored.length > 0 ? `${authored}\n\n${taskLine}` : taskLine,
		);
		// Pin the commit the snapshot produced. Everything after this reads and
		// merges that immutable id, so a branch moved later cannot swap it (F5).
		const pinned = checkTaskWorktreeHead(worktree);
		if (!pinned.ok) return headMovedReceipt(worktree, input.apply, pinned.detail);
		commit = pinned.commit;
	}
	const receipt = committedReceipt(worktree, commit, input.apply);
	if (input.apply === "preserve") return receipt;
	const protectedChanges = protectedPathsChangedByWorktreeBranch(worktree.root, commit, input.protectedPaths ?? []);
	if (protectedChanges.length > 0) return { ...receipt, reason: "protected_artifact_changed" };
	// Right before mutating the source checkout, the branch and HEAD must still
	// name the pinned commit; otherwise the merge would apply what nobody hashed.
	const beforeMerge = checkTaskWorktreeHead(worktree);
	if (!beforeMerge.ok) return { ...headMovedReceipt(worktree, input.apply, beforeMerge.detail), commit };
	let branchTip: string | null = null;
	try {
		branchTip = git(worktree.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}^{commit}`]);
	} catch {
		// A deleted branch is reported as the mismatch below.
	}
	if (branchTip !== commit || beforeMerge.commit !== commit) {
		const detail = `${WORKTREE_HEAD_MOVED}: task branch refs/heads/${worktree.branch} moved from pinned commit ${commit} to ${branchTip ?? "nothing"} before merge; candidate commit ${commit}. Nothing was merged; the worktree and its branch are preserved.`;
		return { ...headMovedReceipt(worktree, input.apply, detail), commit };
	}
	const destinationBranch = git(worktree.root, ["branch", "--show-current"]) || "detached HEAD";
	const merged = mergeWorktreeBranch(worktree.root, commit, COMMIT_IDENTITY, `Merge branch '${worktree.branch}'`);
	if (!merged.ok) return { ...receipt, reason: "worktree_merge_conflict" };
	const landedCommit = git(worktree.root, ["rev-parse", "HEAD"]);
	return { ...receipt, applied: true, detail: `merged ${landedCommit.slice(0, 7)} onto ${destinationBranch}` };
}

function removeWorktreeDirectory(worktree: TaskWorktree): void {
	try {
		git(worktree.root, ["worktree", "remove", "--force", worktree.path]);
	} catch {
		if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
		git(worktree.root, ["worktree", "prune"]);
	}
}

export function cleanupTaskWorktree(worktree: TaskWorktree, deleteBranch: boolean): void {
	assertOwnership(worktree);
	removeWorktreeDirectory(worktree);
	if (deleteBranch) git(worktree.root, ["branch", "-D", worktree.branch]);
	rmSync(claimPathFor(worktree.root, worktree.runId), { force: true });
}

function branchExists(worktree: TaskWorktree): boolean {
	try {
		git(worktree.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}`]);
		return true;
	} catch {
		return false;
	}
}

/** What an operator's discard of a task worktree actually removed. */
export type TaskWorktreeDiscard =
	/** The worktree and the branch are gone; `claimReleased` is false only when the claim file could not be removed. */
	| { outcome: "discarded"; claimReleased: boolean }
	/** The worktree is gone but the branch is not; `claimReleased` says whether the ownership claim went with it. */
	| { outcome: "branch_kept"; claimReleased: boolean; error: unknown }
	/** Nothing was removed. */
	| { outcome: "kept"; error: unknown }
	/** The worktree no longer holds the previewed commit, so nothing was removed. `detail` says how. */
	| { outcome: "changed"; detail: string };

/**
 * Remove a task worktree and its branch for an operator who chose to, and report
 * what each step actually did. The outcome is read from the steps, never
 * inferred from the one that failed: a claim that cannot be removed after the
 * branch is deleted is still a discard, and a branch that is already gone needs
 * no `git branch -D`. With `pinnedCommit`, nothing is removed unless the
 * worktree still holds exactly that commit. A worktree gone with its branch kept releases the claim,
 * because nothing of Clio's is left to guard and the operator holds the branch.
 */
export function discardTaskWorktree(worktree: TaskWorktree, pinnedCommit?: string): TaskWorktreeDiscard {
	try {
		assertOwnership(worktree);
		// `worktree remove --force` and `branch -D` delete whatever was added after
		// the preview, so a pinned discard applies the same drift check as Merge.
		if (pinnedCommit !== undefined) {
			const head = checkTaskWorktreeHead(worktree);
			if (!head.ok) return { outcome: "changed", detail: head.detail };
			const found = previewDrift(worktree, pinnedCommit, head.commit);
			if (found !== null) {
				return {
					outcome: "changed",
					detail: `task worktree ${worktree.runId} ${found} since commit ${pinnedCommit} was offered for discard`,
				};
			}
		}
		try {
			removeWorktreeDirectory(worktree);
		} catch (error) {
			// A failed prune after the directory went leaves nothing on disk to keep.
			if (existsSync(worktree.path)) return { outcome: "kept", error };
		}
	} catch (error) {
		return { outcome: "kept", error };
	}
	let branchKept: { error: unknown } | null = null;
	try {
		git(worktree.root, ["branch", "-D", worktree.branch]);
	} catch (error) {
		if (branchExists(worktree)) branchKept = { error };
	}
	let claimReleased = true;
	try {
		rmSync(claimPathFor(worktree.root, worktree.runId), { force: true });
	} catch {
		// The claim stays; the closing settle or restart recovery reads it.
		claimReleased = false;
	}
	return branchKept === null
		? { outcome: "discarded", claimReleased }
		: { outcome: "branch_kept", claimReleased, error: branchKept.error };
}

/**
 * The cancel-path twin of restart recovery's rule: a canceled run whose worktree
 * has no commit beyond its base and no modified, staged, or untracked file is
 * removed with its branch and claim; one that holds work is left for the
 * caller to settle. Returns whether it was removed. Esc in the TUI and
 * `fleet cancel` both seal through the dispatch finalizer, so they share this.
 */
export function discardIdleTaskWorktree(worktree: TaskWorktree): boolean {
	assertOwnership(worktree);
	if (workHeldBy(worktree.root, worktree) !== null) return false;
	// workHeldBy counts base..branch only. A worker that detached HEAD or moved to
	// another branch and committed there holds work the branch count cannot see,
	// and deleting the worktree would orphan it. A gone working tree has no HEAD
	// to read, so workHeldBy's verdict stands.
	if (existsSync(worktree.path)) {
		if (!checkTaskWorktreeHead(worktree).ok) return false;
		try {
			const strayed = Number.parseInt(git(worktree.path, ["rev-list", "--count", `${worktree.branch}..HEAD`]), 10);
			if (strayed !== 0) return false;
		} catch {
			// A git failure means HEAD cannot be shown to hold nothing, so keep it.
			return false;
		}
	}
	cleanupTaskWorktree(worktree, true);
	return true;
}

function replaceMarker(ownerPath: string, marker: Record<string, unknown>): void {
	const temporary = `${ownerPath}.${randomBytes(6).toString("hex")}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
	renameSync(temporary, ownerPath);
}

/**
 * Record that a run ended and kept its worktree on purpose, so restart
 * recovery does not read the claim as a crash. A claim written before recovery
 * existed carries no state and is left as it is.
 */
export function settleTaskWorktree(worktree: TaskWorktree): void {
	assertOwnership(worktree);
	const ownerPath = claimPathFor(worktree.root, worktree.runId);
	const marker = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
	if (marker.version !== 2) return;
	replaceMarker(ownerPath, { ...marker, state: "settled" satisfies TaskWorktreeState });
}

interface TaskClaim {
	runId: string;
	path: string;
	ownerPath: string;
	marker: Record<string, unknown>;
	branch: string;
	base: string;
	state: TaskWorktreeState;
	createdAt: string | null;
	owner: ProcessLease | null;
}

/**
 * Every task claim under the root whose facts are internally consistent: the
 * marker names this root, its own run id, the canonical branch, and a path
 * that is exactly `<parent>/<runId>` under an allowed parent. Anything else is not provably ours and
 * is never returned, so recovery never touches it.
 */
function readTaskClaims(canonical: string, allowedParents: ReadonlyArray<string>): TaskClaim[] {
	const parent = diskWorktreeParent(canonical);
	let names: string[];
	try {
		names = readdirSync(parent);
	} catch {
		return [];
	}
	const claims: TaskClaim[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(OWNER_FILE_SUFFIX)) continue;
		const runId = name.slice(0, -OWNER_FILE_SUFFIX.length);
		if (!SAFE_RUN_ID.test(runId)) continue;
		const ownerPath = join(parent, name);
		let marker: Record<string, unknown>;
		try {
			const value = JSON.parse(readFileSync(ownerPath, "utf8")) as unknown;
			if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
			marker = value as Record<string, unknown>;
		} catch {
			continue;
		}
		// The claim names where its working tree is. It is believed only when
		// that is `<allowed parent>/<runId>`; recovery runs git and rm on it.
		const path = typeof marker.path === "string" ? marker.path : join(parent, runId);
		const pathParent = allowedParents.find((allowed) => resolve(allowed) === resolve(dirname(path)));
		if (pathParent === undefined || basename(path) !== runId) continue;
		if (
			(marker.version !== 1 && marker.version !== 2) ||
			(marker.kind !== TASK_WORKTREE_KIND && marker.kind !== LEGACY_TASK_WORKTREE_KIND) ||
			marker.root !== canonical ||
			marker.runId !== runId ||
			(marker.branch !== `clio-coder/task/${runId}` && marker.branch !== `clio/task/${runId}`) ||
			typeof marker.base !== "string" ||
			!/^[0-9a-f]{40,64}$/u.test(marker.base) ||
			(existsSync(path) && !isCanonicalWorktreePathInside(pathParent, path))
		) {
			continue;
		}
		const state: TaskWorktreeState = marker.state === "settled" || marker.state === "abandoned" ? marker.state : "active";
		claims.push({
			runId,
			path,
			ownerPath,
			marker,
			branch: marker.branch,
			base: marker.base,
			state,
			createdAt: typeof marker.createdAt === "string" ? marker.createdAt : null,
			owner: marker.version === 2 && validProcessLease(marker.owner) ? marker.owner : null,
		});
	}
	return claims;
}

/**
 * Why a dead owner's worktree must be kept, or null when it holds nothing: no
 * commit beyond its base and no modified, staged, or untracked file. Any git
 * failure is a reason to keep it.
 */
function workHeldBy(canonical: string, claim: Pick<TaskClaim, "base" | "branch" | "path">): string | null {
	try {
		const commits = Number.parseInt(git(canonical, ["rev-list", "--count", `${claim.base}..${claim.branch}`]), 10);
		if (!Number.isSafeInteger(commits)) return "its commits could not be counted";
		if (commits > 0) {
			return existsSync(claim.path)
				? `${commits} commit(s) beyond its base`
				: `${commits} commit(s) beyond its base (its working tree is gone)`;
		}
		// Gone with a tmpfs root at reboot: whatever was uncommitted went with it.
		if (!existsSync(claim.path)) return null;
		const dirty = git(claim.path, ["status", "--porcelain", "--untracked-files=all"]);
		return dirty.length > 0 ? `${dirty.split("\n").length} uncommitted path(s)` : null;
	} catch (error) {
		return `git could not inspect it: ${error instanceof Error ? (error.message.split("\n")[0] ?? "error") : String(error)}`;
	}
}

/**
 * Whether a finished run's worktree holds anything to land: a commit beyond its base, or any modified, staged
 * or untracked file. Fails toward true, so an unreadable tree keeps every gate that would have applied to it.
 */
export function taskWorktreeHoldsWork(worktree: TaskWorktree): boolean {
	return workHeldBy(worktree.root, worktree) !== null;
}

function preservedView(claim: TaskClaim, state: TaskWorktreeState, reason: string): PreservedTaskWorktree {
	return {
		runId: claim.runId,
		path: claim.path,
		claimPath: claim.ownerPath,
		branch: claim.branch,
		base: claim.base,
		state,
		createdAt: claim.createdAt,
		reason,
	};
}

/**
 * Restart recovery for `worktree: true` dispatch. A crash used to leave the
 * worktree, its branch, and its claim under `.clio-coder/worktrees/` forever.
 * Only an `active` claim whose owner is provably gone is acted on: one that
 * holds no work is removed with its branch, and one that holds commits or
 * uncommitted files becomes `abandoned` and is returned for the startup
 * report. It is never merged and never deleted. A live owner, an owner on
 * another host, a claim without a lease, and a settled or already abandoned
 * claim are left exactly as they are.
 */
export function recoverTaskWorktrees(
	root: string,
	/** Defaults to the project-root location; pass allowedWorktreeParents() to cover a configured root. */
	allowedParents?: ReadonlyArray<string>,
): TaskWorktreeRecoveryResult {
	const result: TaskWorktreeRecoveryResult = { removed: [], preserved: [], failed: [] };
	let canonical: string;
	try {
		canonical = realpathSync(root);
	} catch {
		return result;
	}
	for (const claim of readTaskClaims(canonical, allowedParents ?? [diskWorktreeParent(canonical)])) {
		if (claim.state !== "active" || claim.owner === null || ownerIsAlive(claim.owner)) continue;
		try {
			const held = workHeldBy(canonical, claim);
			if (held !== null) {
				replaceMarker(claim.ownerPath, { ...claim.marker, state: "abandoned" satisfies TaskWorktreeState });
				result.preserved.push(preservedView(claim, "abandoned", held));
				continue;
			}
			if (existsSync(claim.path)) git(canonical, ["worktree", "remove", "--force", claim.path]);
			else git(canonical, ["worktree", "prune"]);
			git(canonical, ["branch", "-D", claim.branch]);
			rmSync(claim.ownerPath, { force: true });
			result.removed.push(claim.runId);
		} catch (error) {
			result.failed.push({ runId: claim.runId, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return result;
}

/**
 * The task worktrees that outlived their run, for doctor: settled ones kept on
 * purpose, abandoned ones recovery kept, and claims too old to carry a lease.
 * A claim whose owner is still alive is a run in flight and is not listed.
 */
export function listPreservedTaskWorktrees(
	root: string,
	allowedParents?: ReadonlyArray<string>,
): PreservedTaskWorktree[] {
	let canonical: string;
	try {
		canonical = realpathSync(root);
	} catch {
		return [];
	}
	const out: PreservedTaskWorktree[] = [];
	for (const claim of readTaskClaims(canonical, allowedParents ?? [diskWorktreeParent(canonical)])) {
		if (claim.state === "settled") out.push(preservedView(claim, "settled", "kept by its run"));
		else if (claim.state === "abandoned") out.push(preservedView(claim, "abandoned", "its owner died holding work"));
		else if (claim.owner === null) out.push(preservedView(claim, "active", "its claim predates restart recovery"));
		else if (!ownerIsAlive(claim.owner))
			out.push(preservedView(claim, "active", "its owner is gone; the next start recovers it"));
	}
	return out;
}
