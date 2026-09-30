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
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
	// Off the project root the directory may sit on a filesystem other users
	// share (/dev/shm), so it is ours alone.
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	if (!isCanonicalWorktreePathInside(parent, path))
		throw new Error(`task worktree path escapes its parent for run ${runId}`);
	git(canonical, ["worktree", "add", "-b", branch, path, resolvedBase]);
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

export function applyTaskWorktree(input: {
	worktree: TaskWorktree;
	apply: TaskWorktreeApply;
	protectedPaths?: ReadonlyArray<string>;
	/** The worker's validated `commitMessage`; a merge lands it on the operator's branch. */
	commitMessage?: string | null;
}): TaskWorktreeReceipt {
	const { worktree } = input;
	const before = checkTaskWorktreeHead(worktree);
	if (!before.ok) return headMovedReceipt(worktree, input.apply, before.detail);
	const taskLine = `Clio Coder task ${worktree.runId}`;
	const authored = input.commitMessage?.trim();
	commitWorktreePath(
		worktree.path,
		COMMIT_IDENTITY,
		authored !== undefined && authored.length > 0 ? `${authored}\n\n${taskLine}` : taskLine,
	);
	// Pin the commit the snapshot produced. Everything after this reads and
	// merges that immutable id, so a branch moved later cannot swap it (F5).
	const pinned = checkTaskWorktreeHead(worktree);
	if (!pinned.ok) return headMovedReceipt(worktree, input.apply, pinned.detail);
	const commit = pinned.commit;
	const receipt: TaskWorktreeReceipt = {
		path: worktree.path,
		branch: worktree.branch,
		diffHash: taskWorktreeDiffHash(worktree, commit),
		changedPaths: nullDelimitedPaths(
			gitBytes(worktree.root, ["diff", "--name-only", "-z", `${worktree.base}..${commit}`]),
		),
		commit,
		apply: input.apply,
		applied: false,
	};
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
	const merged = mergeWorktreeBranch(worktree.root, commit, COMMIT_IDENTITY, `Merge branch '${worktree.branch}'`);
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
	rmSync(claimPathFor(worktree.root, worktree.runId), { force: true });
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
function workHeldBy(canonical: string, claim: TaskClaim): string | null {
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
