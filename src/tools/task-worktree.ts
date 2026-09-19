import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { currentProcessLease, ownerIsAlive, type ProcessLease, validProcessLease } from "./process-lease.js";

export type TaskWorktreeApply = "merge" | "preserve";

export interface TaskWorktree {
	root: string;
	runId: string;
	path: string;
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
	diffHash: string;
	apply: TaskWorktreeApply;
	applied: boolean;
	reason?: string;
}

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OWNER_FILE_SUFFIX = ".task-owner.json";
const TASK_WORKTREE_KIND = "clio-coder-task-worktree";
const LEGACY_TASK_WORKTREE_KIND = "clio-task-worktree";
const COMMIT_IDENTITY = "clio-coder-task";

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

export function createTaskWorktree(
	root: string,
	runId: string,
	base?: string,
	apply: TaskWorktreeApply = "merge",
): TaskWorktree {
	validateRunId(runId);
	const canonical = realpathSync(root);
	const resolvedBase = base ?? git(canonical, ["rev-parse", "HEAD"]);
	const parent = join(canonical, ".clio-coder", "worktrees");
	const path = join(parent, runId);
	const branch = `clio-coder/task/${runId}`;
	mkdirSync(parent, { recursive: true });
	if (!isCanonicalWorktreePathInside(parent, path))
		throw new Error(`task worktree path escapes its parent for run ${runId}`);
	git(canonical, ["worktree", "add", "-b", branch, path, resolvedBase]);
	const ownerToken = randomBytes(16).toString("hex");
	writeFileSync(
		`${path}${OWNER_FILE_SUFFIX}`,
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
			},
			null,
			2,
		)}\n`,
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
	const ownerPath = `${worktree.path}${OWNER_FILE_SUFFIX}`;
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
		marker.ownerToken !== worktree.ownerToken
	) {
		throw new Error(`task worktree ${worktree.runId} ownership facts do not match`);
	}
}

function commitTaskWorktree(worktree: TaskWorktree, message = `Clio Coder task ${worktree.runId}`): boolean {
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

function taskWorktreeParent(root: string): string {
	return join(root, ".clio-coder", "worktrees");
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
	const ownerPath = `${worktree.path}${OWNER_FILE_SUFFIX}`;
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
 * that is exactly `<parent>/<runId>`. Anything else is not provably ours and
 * is never returned, so recovery never touches it.
 */
function readTaskClaims(canonical: string): TaskClaim[] {
	const parent = taskWorktreeParent(canonical);
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
		const path = join(parent, runId);
		if (
			(marker.version !== 1 && marker.version !== 2) ||
			(marker.kind !== TASK_WORKTREE_KIND && marker.kind !== LEGACY_TASK_WORKTREE_KIND) ||
			marker.root !== canonical ||
			marker.runId !== runId ||
			(marker.branch !== `clio-coder/task/${runId}` && marker.branch !== `clio/task/${runId}`) ||
			typeof marker.base !== "string" ||
			!/^[0-9a-f]{40,64}$/u.test(marker.base) ||
			(existsSync(path) && !isCanonicalWorktreePathInside(parent, path))
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
		if (commits > 0) return `${commits} commit(s) beyond its base`;
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
export function recoverTaskWorktrees(root: string): TaskWorktreeRecoveryResult {
	const result: TaskWorktreeRecoveryResult = { removed: [], preserved: [], failed: [] };
	let canonical: string;
	try {
		canonical = realpathSync(root);
	} catch {
		return result;
	}
	for (const claim of readTaskClaims(canonical)) {
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
export function listPreservedTaskWorktrees(root: string): PreservedTaskWorktree[] {
	let canonical: string;
	try {
		canonical = realpathSync(root);
	} catch {
		return [];
	}
	const out: PreservedTaskWorktree[] = [];
	for (const claim of readTaskClaims(canonical)) {
		if (claim.state === "settled") out.push(preservedView(claim, "settled", "kept by its run"));
		else if (claim.state === "abandoned") out.push(preservedView(claim, "abandoned", "its owner died holding work"));
		else if (claim.owner === null) out.push(preservedView(claim, "active", "its claim predates restart recovery"));
		else if (!ownerIsAlive(claim.owner))
			out.push(preservedView(claim, "active", "its owner is gone; the next start recovers it"));
	}
	return out;
}
