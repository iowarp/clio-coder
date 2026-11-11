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
import { attributeCommitMessage } from "../core/commit-attribution.js";
import { stripAuthoredTrailers } from "../core/commit-message.js";
import { autonomousLandAuthorship } from "../core/git-commit-attribution.js";
import { internalGitArgv, withoutRepositoryEnv } from "../core/internal-git.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import {
	LEGACY_TASK_WORKTREE_KIND,
	SAFE_TASK_RUN_ID,
	TASK_WORKTREE_KIND,
	TASK_WORKTREE_OWNER_SUFFIX,
} from "../core/task-worktree-claim.js";
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
	/**
	 * Branch the source checkout had checked out at dispatch. A merge lands only
	 * while that branch is still checked out. Absent when HEAD was detached, and
	 * on a value built before this was recorded.
	 */
	sourceBranch?: string;
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
	/**
	 * Its branch and its working tree are both gone, removed by hand, so the
	 * claim file is all that is left and nothing of the run can be lost with it.
	 */
	stale: boolean;
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
	/**
	 * New files the host commit left out because no mutation call of the run
	 * wrote them and the worker did not stage them, or because the repository's
	 * ignore rules match them. `paths` holds at most `LEFT_UNCOMMITTED_LIST_LIMIT`
	 * of the `count`.
	 */
	leftUncommitted?: { count: number; paths: string[] };
	/**
	 * What kept a merged worktree from automatic cleanup: files changed or new
	 * since the commit and `leftUncommitted` accounted for its contents. Bounded
	 * like `leftUncommitted`.
	 */
	changedAfterCommit?: { count: number; paths: string[] };
}

/** Receipt reason for a task worktree whose HEAD no longer names its own task branch (F5). */
export const WORKTREE_HEAD_MOVED = "worktree_head_moved";

/** Receipt reason for a merge refused because the source checkout is no longer on a branch that holds the task's base. */
export const WORKTREE_DESTINATION_MOVED = "worktree_destination_moved";

/** Receipt reason for a merge refused because the source checkout already has a Git operation in progress. */
export const WORKTREE_DESTINATION_BUSY = "worktree_destination_busy";

/** Receipt reason for a merge refused because the worktree no longer holds the commit an operator was shown. */
export const WORKTREE_CHANGED_SINCE_PREVIEW = "worktree_changed_since_preview";

const SAFE_RUN_ID = SAFE_TASK_RUN_ID;
const OWNER_FILE_SUFFIX = TASK_WORKTREE_OWNER_SUFFIX;
/** Identity of commits the host makes on a task branch, and of worker commits when the repository names none. */
export const COMMIT_IDENTITY = "clio-coder-task";

interface GitOptions {
	env?: NodeJS.ProcessEnv;
}

function gitBytes(root: string, args: string[], options: GitOptions = {}): Buffer {
	return execFileSync("git", internalGitArgv(["-C", root, ...args]), {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
		...options,
		env: withoutRepositoryEnv(options.env),
	});
}

const MANIFEST_PATHSPECS = [
	":(glob)**/package.json",
	":(glob)**/.npmrc",
	":(glob)**/pnpm-workspace.yaml",
	":(exclude,glob)**/node_modules/**",
];

/**
 * Whether the task worktree's package manifests or package-manager config
 * differ from its base: committed, staged, unstaged, untracked or ignored.
 * Any Git failure counts as changed.
 */
export function taskWorktreeManifestsChanged(worktree: Pick<TaskWorktree, "path" | "base">): boolean {
	try {
		const tracked = gitBytes(worktree.path, ["diff", "--name-only", worktree.base, "--", ...MANIFEST_PATHSPECS]);
		if (tracked.length > 0) return true;
		const added = gitBytes(worktree.path, ["ls-files", "--others", "--", ...MANIFEST_PATHSPECS]);
		return added.length > 0;
	} catch {
		return true;
	}
}

function git(root: string, args: string[], options: GitOptions = {}): string {
	return gitBytes(root, args, options).toString("utf8").trim();
}

function gitErrorOutput(error: unknown, stream: "stdout" | "stderr"): string {
	if (error === null || typeof error !== "object") return "";
	const output = (error as { stdout?: unknown; stderr?: unknown })[stream];
	return typeof output === "string" ? output : Buffer.isBuffer(output) ? output.toString("utf8") : "";
}

function gitFailureReason(error: unknown, fallback: string): string {
	const lines = gitErrorOutput(error, "stderr").split(/\r?\n/);
	const stderr = lines.find((line) => line.trim().length > 0)?.trim();
	if (stderr !== undefined) {
		// Git names the paths it refuses over on tab-indented lines after the message.
		const paths = lines.filter((line) => line.startsWith("\t")).map((line) => line.trim());
		if (paths.length === 0) return stderr;
		return `${stderr} ${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ` and ${paths.length - 10} more` : ""}`;
	}
	const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
	if (typeof code !== "string") return fallback;
	const cause =
		code === "ENOENT"
			? "Git executable was not found."
			: code === "ETIMEDOUT"
				? "Git exceeded its subprocess timeout."
				: code === "ENOBUFS"
					? "Git exceeded its subprocess output buffer."
					: fallback;
	return `${code}: ${cause}`;
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

/** The checkout's configured value for `key`, or null when it is unset. */
function configuredGitValue(cwd: string, key: string): string | null {
	try {
		const value = git(cwd, ["config", "--get", key]);
		return value.length > 0 ? value : null;
	} catch {
		// `git config --get` exits 1 for an unset key.
		return null;
	}
}

/**
 * `-c` overrides for a commit the host makes on the operator's behalf. The
 * checkout's own identity authors it, the same identity the main agent's
 * commits carry; `identity` fills in only what is not configured, so a
 * merged task never lands under a synthetic author the operator did not pick.
 */
export function hostCommitIdentity(cwd: string, identity: string): string[] {
	const config: string[] = [];
	if (configuredGitValue(cwd, "user.name") === null) config.push("-c", `user.name=${identity}`);
	if (configuredGitValue(cwd, "user.email") === null) config.push("-c", `user.email=${identity}@local`);
	return config;
}

export interface GitIdent {
	name: string;
	email: string;
}

/**
 * The author and committer a host commit at `cwd` would record, spelled out for
 * a commit made elsewhere (an SSH node's worktree) that lands in this
 * checkout. Git resolves them with the `hostCommitIdentity` fill-ins, so
 * GIT_AUTHOR_* and GIT_COMMITTER_* environment, author.* and committer.*
 * config, and user.* config win exactly as they would for a local commit.
 */
export function hostCommitIdents(cwd: string, identity: string): { author: GitIdent; committer: GitIdent } {
	const fallback = { name: identity, email: `${identity}@local` };
	const resolveIdent = (kind: "GIT_AUTHOR_IDENT" | "GIT_COMMITTER_IDENT"): GitIdent => {
		try {
			const raw = git(cwd, [...hostCommitIdentity(cwd, identity), "-c", "user.useConfigOnly=true", "var", kind]);
			const match = /^(.+?) <([^<>]*)> \d+ [-+]\d{4}$/u.exec(raw);
			return match?.[1] !== undefined && match[2] !== undefined ? { name: match[1], email: match[2] } : fallback;
		} catch {
			return fallback;
		}
	};
	return { author: resolveIdent("GIT_AUTHOR_IDENT"), committer: resolveIdent("GIT_COMMITTER_IDENT") };
}

/** What a host commit of a worker's worktree took, and the new files it left out. */
export interface WorktreeCommit {
	committed: boolean;
	/** Files still untracked after the host commit, top-relative and sorted, excluding runtime state. */
	leftUncommitted: string[];
	/** Authored files the repository's ignore rules kept out of the commit; see `ignoredAuthoredPaths`. */
	ignoredAuthored: string[];
	/** The commit and stamps from that same post-commit listing, for guarded cleanup. */
	accounted: TaskWorktreePreview;
}

/** How many left-out paths a receipt names; the count still covers all of them. */
export const LEFT_UNCOMMITTED_LIST_LIMIT = 20;

const GIT_PATHSPEC_BATCH = 256;

function untrackedPaths(path: string): string[] {
	return nullDelimitedPaths(gitBytes(path, ["ls-files", "--others", "--exclude-standard", "-z"]));
}

/**
 * Files a run authored that the repository's ignore rules keep out of every
 * host commit. They are never forced into history and never copied into the
 * checkout, so they live only in the worktree, which must outlive the landing.
 * With no write record, every ignored path counts (collapsed per directory).
 */
function ignoredAuthoredPaths(
	path: string,
	authoredPaths: Iterable<string> | null,
	excludedPaths: ReadonlyArray<string> = [],
): string[] {
	const listing = ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"];
	const excluded = new Set(excludedPaths);
	if (authoredPaths === null) {
		return nullDelimitedPaths(gitBytes(path, [...listing, "--directory"]))
			.map((entry) => entry.replace(/\/$/u, ""))
			.filter((entry) => !excluded.has(entry))
			.sort();
	}
	const authored = [...worktreeRelativePaths(path, authoredPaths)].filter((entry) => !excluded.has(entry));
	const ignored = new Set<string>();
	for (let index = 0; index < authored.length; index += GIT_PATHSPEC_BATCH) {
		const batch = authored.slice(index, index + GIT_PATHSPEC_BATCH);
		for (const entry of nullDelimitedPaths(
			gitBytes(path, [...listing, "--", ...batch.map((entry) => `:(top,literal)${entry}`)]),
		))
			ignored.add(entry);
	}
	return [...ignored].sort();
}

/** Top-relative POSIX spellings of the absolute `paths` that sit inside the worktree at `path`. */
function worktreeRelativePaths(path: string, paths: Iterable<string>): Set<string> {
	const roots = new Set([resolve(path)]);
	try {
		roots.add(realpathSync(path));
	} catch {
		// A worktree that cannot be canonicalized is matched by its given spelling only.
	}
	const inside = new Set<string>();
	for (const candidate of paths) {
		for (const root of roots) {
			const rel = relative(root, resolve(candidate));
			if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
			inside.add(rel.split(sep).join("/"));
		}
	}
	return inside;
}

/**
 * Commit a worker's worktree as the host. The commit takes changes to tracked
 * files, whatever the worker staged through the git capability, and the
 * untracked files in `authoredPaths`, which are the host-observed targets of the
 * run's own successful mutation calls. Every other new file is a byproduct
 * (`__pycache__`, object files, build outputs) that the worker never chose to
 * ship, so it stays out and is reported instead: committed, it lands beside the
 * fix and collides with the destination's own untracked copies at merge.
 *
 * `authoredPaths: null` means the host holds no complete write record for the
 * run, so it cannot tell an authored file from a byproduct and takes every
 * untracked file.
 */
export function commitWorktreePath(
	path: string,
	identity: string,
	message: string,
	scope: { authoredPaths: Iterable<string> | null; excludedPaths?: ReadonlyArray<string> },
): WorktreeCommit {
	const excludedPaths = scope.excludedPaths ?? [];
	// Runtime state can already be staged by a worker. Reset only these exact
	// index entries, leaving their working files and every authored path intact.
	if (excludedPaths.length > 0) {
		git(path, ["reset", "-q", "HEAD", "--", ...excludedPaths.map((entry) => `:(top,literal)${entry}`)]);
	}
	git(path, ["add", "-u", "--", ".", ...excludedPaths.map((entry) => `:(top,exclude,literal)${entry}`)]);
	const excluded = new Set(excludedPaths);
	const untracked = untrackedPaths(path).filter((entry) => !excluded.has(entry));
	const authored = scope.authoredPaths === null ? new Set(untracked) : worktreeRelativePaths(path, scope.authoredPaths);
	const take = untracked.filter((entry) => authored.has(entry));
	for (let index = 0; index < take.length; index += GIT_PATHSPEC_BATCH) {
		const batch = take.slice(index, index + GIT_PATHSPEC_BATCH);
		git(path, ["add", "--", ...batch.map((entry) => `:(top,literal)${entry}`)]);
	}
	const committed = git(path, ["diff", "--cached", "--name-only", "-z"]).length > 0;
	if (committed) {
		// Landing dispatched work is autonomous: under `auto` Clio authors it and the human co-authors.
		const authorship = autonomousLandAuthorship(path);
		const attributed =
			authorship === null ? message : attributeCommitMessage(message, {}, true, { clioAuthorFor: authorship.human });
		git(
			path,
			[...hostCommitIdentity(path, identity), "commit", "-m", attributed, "--no-verify"],
			authorship === null ? {} : { env: { ...withoutRepositoryEnv(), ...authorship.env } },
		);
	}
	const leftUncommitted = untrackedPaths(path).filter((entry) => !excluded.has(entry));
	const ignoredAuthored = ignoredAuthoredPaths(path, scope.authoredPaths, excludedPaths);
	const { stamps } = untrackedState(path, leftUncommitted);
	return {
		committed,
		leftUncommitted,
		ignoredAuthored,
		accounted: {
			commit: git(path, ["rev-parse", "HEAD"]),
			untracked: stamps,
			...(ignoredAuthored.length > 0 ? { ignored: ignoredAuthored } : {}),
		},
	};
}

/** The bounded account of new files a host commit left out, or undefined when it left none. */
export function leftUncommittedReport(paths: ReadonlyArray<string>): TaskWorktreeReceipt["leftUncommitted"] {
	return paths.length === 0 ? undefined : { count: paths.length, paths: paths.slice(0, LEFT_UNCOMMITTED_LIST_LIMIT) };
}

function leftUncommittedField(paths: ReadonlyArray<string>): Pick<TaskWorktreeReceipt, "leftUncommitted"> {
	const report = leftUncommittedReport(paths);
	return report === undefined ? {} : { leftUncommitted: report };
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
): { ok: true } | { ok: false; reason: string; code?: typeof WORKTREE_DESTINATION_BUSY } {
	let mergeAttempted = false;
	let targetCommit: string | undefined;
	let mergeHeadPath: string | undefined;
	// Conflict-path reporting parses Git diagnostics, so merge subprocesses need a stable locale.
	const authorship = autonomousLandAuthorship(root);
	const mergeEnv = { ...withoutRepositoryEnv(), ...authorship?.env, LC_ALL: "C", LANGUAGE: "" };
	const mergeMessage =
		authorship === null
			? message
			: attributeCommitMessage(message ?? `Merge branch '${branch}'`, {}, true, { clioAuthorFor: authorship.human });
	try {
		targetCommit = git(root, ["rev-parse", "--verify", "--end-of-options", `${branch}^{commit}`]);
		const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
		mergeHeadPath = join(gitDir, "MERGE_HEAD");
		// A task must not interrupt the operator's partially completed Git operation.
		const operation = gitOperationInProgress(gitDir);
		if (operation !== null) {
			return {
				ok: false,
				code: WORKTREE_DESTINATION_BUSY,
				reason: `Cannot merge: a ${operation} is already in progress in the destination checkout.`,
			};
		}
		mergeAttempted = true;
		git(
			root,
			[
				...hostCommitIdentity(root, identity),
				// An autostash merges over the operator's WIP, exits 0 and leaves the restore conflicted; refuse instead.
				"-c",
				"merge.autoStash=false",
				"merge",
				"--no-edit",
				"--no-verify",
				...(mergeMessage !== undefined ? ["-m", mergeMessage] : []),
				branch,
			],
			{ env: mergeEnv },
		);
		return { ok: true };
	} catch (error) {
		const stdout = gitErrorOutput(error, "stdout");
		const conflictLines = stdout.split(/\r?\n/).filter((line) => line.startsWith("CONFLICT "));
		const status = error !== null && typeof error === "object" && "status" in error ? error.status : undefined;
		const reportsConflict = mergeAttempted && status === 1 && conflictLines.length > 0;
		let mergeLeftInProgress = false;
		// Exit 128 refuses an operator's merge, including a same-oid merge with unresolved index entries.
		// Only exit 1 can own cleanup, and the pin protects a branch moved before Git runs.
		if (mergeAttempted && targetCommit !== undefined && mergeHeadPath !== undefined) {
			try {
				if (existsSync(mergeHeadPath)) {
					if (status === 128) {
						return {
							ok: false,
							code: WORKTREE_DESTINATION_BUSY,
							reason: gitFailureReason(error, "Cannot merge: a merge is already in progress in the destination checkout."),
						};
					}
					if (status === 1 && readFileSync(mergeHeadPath, "utf8").trim() === targetCommit) {
						git(root, ["merge", "--abort"], { env: mergeEnv });
					} else {
						mergeLeftInProgress = true;
					}
				}
			} catch {
				return {
					ok: false,
					reason: `Git left this task merge in progress; run git merge --abort in ${root}`,
				};
			}
		}
		const reason = reportsConflict
			? `Merge conflict: ${conflictLines.join(" ")}`
			: gitFailureReason(error, "Git could not merge the branch.");
		return {
			ok: false,
			reason: `${reason}${mergeLeftInProgress ? ` ; this task merge was left in progress; run git merge --abort in ${root}` : ""}`,
		};
	}
}

/** The Git operation an operator left in progress in `gitDir`, or null when none is. */
export function gitOperationInProgress(gitDir: string): string | null {
	for (const [marker, operation] of [
		["MERGE_HEAD", "merge"],
		["CHERRY_PICK_HEAD", "cherry-pick"],
		["REVERT_HEAD", "revert"],
		["rebase-merge", "rebase"],
		["rebase-apply", "rebase"],
		["sequencer", "cherry-pick or revert sequence"],
	] as const) {
		if (existsSync(join(gitDir, marker))) return operation;
	}
	return null;
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
	const sourceBranch = git(canonical, ["branch", "--show-current"]);
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
	// Git config outlives the claim, so a branch kept after its claim is
	// released still names where it was cut and which branch it lands on.
	// `git branch -D` removes the section with the branch.
	try {
		git(canonical, ["config", `branch.${branch}.clio-coder-base`, resolvedBase]);
		if (sourceBranch.length > 0) git(canonical, ["config", `branch.${branch}.clio-coder-source`, sourceBranch]);
	} catch {
		// Only `fleet land` of a claimless branch reads these; the claim carries the same facts.
	}
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
				...(sourceBranch.length > 0 ? { sourceBranch } : {}),
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
	return {
		root: canonical,
		runId,
		path,
		parent,
		branch,
		base: resolvedBase,
		...(sourceBranch.length > 0 ? { sourceBranch } : {}),
		ownerToken,
	};
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

/** Workspace package directories (relative, never "."), from pnpm-workspace.yaml or package.json workspaces. */
function workspacePackageDirs(root: string): string[] {
	const patterns: string[] = [];
	const yaml = dependencyInput(join(root, "pnpm-workspace.yaml"));
	if (yaml !== null) {
		let inPackages = false;
		for (const line of yaml.toString("utf8").split(/\r?\n/)) {
			if (/^packages:\s*$/.test(line)) {
				inPackages = true;
				continue;
			}
			if (!inPackages) continue;
			const item = /^\s+-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(line);
			if (item?.[1] !== undefined) patterns.push(item[1]);
			else if (line.trim().length > 0 && !line.trimStart().startsWith("#")) inPackages = false;
		}
	}
	const manifest = dependencyInput(join(root, "package.json"));
	if (manifest !== null) {
		try {
			const parsed = JSON.parse(manifest.toString("utf8")) as { workspaces?: unknown };
			const workspaces = Array.isArray(parsed.workspaces)
				? parsed.workspaces
				: (parsed.workspaces as { packages?: unknown } | undefined)?.packages;
			if (Array.isArray(workspaces)) {
				for (const entry of workspaces) if (typeof entry === "string") patterns.push(entry);
			}
		} catch {
			// A malformed manifest names no workspace packages.
		}
	}
	const dirs = new Set<string>();
	for (const raw of patterns) {
		const pattern = raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
		if (pattern.length === 0 || pattern === "." || pattern.startsWith("!") || pattern.includes("..")) continue;
		if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
			const parent = pattern.slice(0, -2);
			let entries: string[];
			try {
				entries = readdirSync(join(root, parent));
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (existsSync(join(root, parent, entry, "package.json"))) dirs.add(`${parent}/${entry}`);
			}
		} else if (!pattern.includes("*") && existsSync(join(root, pattern, "package.json"))) {
			dirs.add(pattern);
		}
	}
	return [...dirs].sort();
}

/** Reuse installed environments only when the caller enforces these returned roots as read-only. */
export function shareTaskWorktreeDependencies(worktree: TaskWorktree): string[] {
	if (isCanonicalWorktreePathInside(worktree.root, worktree.path)) return [];
	assertOwnership(worktree);
	const readOnlyRoots = new Set<string>();
	const targets: Array<{ name: string; inputs: string[] }> = Object.entries(DEPENDENCY_INPUTS).map(([name, inputs]) => ({
		name,
		inputs,
	}));
	// A workspace package's node_modules resolves through the root install, so the root inputs gate it too.
	for (const dir of workspacePackageDirs(worktree.root)) {
		targets.push({ name: `${dir}/node_modules`, inputs: [...DEPENDENCY_INPUTS.node_modules, `${dir}/package.json`] });
	}
	for (const { name, inputs } of targets) {
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
			if (!existsSync(dirname(destination))) continue;
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
		return moved(`no readable git checkout (${gitFailureReason(error, "Git could not inspect the checkout.")})`);
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
			detail: `task worktree ${worktree.runId} could not be attested: ${gitFailureReason(error, "Git could not inspect the checkout.")}`,
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
		return execFileSync("git", internalGitArgv(["-C", worktree.path, "diff", "--no-color", "-U0", worktree.base]), {
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
			maxBuffer: BASE_DIFF_MAX_BYTES,
			env: withoutRepositoryEnv(),
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

/**
 * What the host accounted for in a worktree: the pinned commit and the stamp of
 * each untracked file beside it. An operator's preview records it before the
 * card, and an ordinary merge from the post-commit listing behind
 * `leftUncommitted`. Merge lands only the commit, but Discard and the cleanup
 * after Merge remove the worktree with `--force`, so each one refuses once those
 * files are no longer the ones accounted for.
 */
export interface TaskWorktreePreview {
	commit: string;
	untracked: ReadonlyMap<string, string>;
	/** Authored files ignore rules kept out of the commit; the worktree is kept while any of them exists. */
	ignored?: ReadonlyArray<string>;
}

/** What a worktree holds beyond what was accounted for: `detail` finishes "the worktree ...". */
export interface TaskWorktreeDrift {
	detail: string;
	paths: string[];
}

const GONE_STAMP = "gone";

/**
 * Each untracked file's inode stamp. ctime moves on every write, rename and
 * chmod and cannot be set back, so an equal stamp means the file did not change.
 * Directory stamps cannot detect edits to descendants, so directories prevent
 * destructive cleanup. Ignored files stay out, as they do from every host commit.
 */
function untrackedState(
	path: string,
	paths = untrackedPaths(path),
): { stamps: Map<string, string>; directories: string[] } {
	const stamps = new Map<string, string>();
	const directories: string[] = [];
	for (const entry of paths) {
		let stamp = GONE_STAMP;
		try {
			const stat = lstatSync(join(path, entry), { bigint: true });
			if (stat.isDirectory()) directories.push(entry);
			stamp = `${stat.mode}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
		} catch (error) {
			// Only a vanished file is safe to omit from destructive cleanup.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		stamps.set(entry, stamp);
	}
	return { stamps, directories };
}

/** Record what an operator is about to be shown for `commit`, before the card that shows it. */
export function previewTaskWorktree(worktree: TaskWorktree, commit: string): TaskWorktreePreview {
	return { commit, untracked: untrackedState(worktree.path).stamps };
}

/**
 * What the worktree holds that `accounted` does not cover. An accounted file
 * that vanished is not drift here: nothing of it is left for a removal to lose.
 */
function heldDrift(
	worktree: TaskWorktree,
	accounted: TaskWorktreePreview,
	head: string,
	listed: string[],
): TaskWorktreeDrift | null {
	if (head !== accounted.commit) return { detail: `is now at ${head}`, paths: [] };
	const tracked = [
		...nullDelimitedPaths(gitBytes(worktree.path, ["diff", "--name-only", "-z", "HEAD"])),
		...nullDelimitedPaths(gitBytes(worktree.path, ["diff", "--cached", "--name-only", "-z", "HEAD"])),
	];
	const { stamps, directories } = untrackedState(worktree.path, listed);
	const changed = [...stamps]
		.filter(([entry, stamp]) => stamp !== GONE_STAMP && accounted.untracked.get(entry) !== stamp)
		.map(([entry]) => entry);
	const ignored = (accounted.ignored ?? []).filter((entry) => existsSync(join(worktree.path, entry)));
	const paths = [...new Set([...tracked, ...directories, ...changed, ...ignored])].sort();
	if (tracked.length > 0) return { detail: "has uncommitted changes", paths };
	const directory = directories[0];
	if (directory !== undefined)
		return { detail: `has untracked directory ${directory}; destructive cleanup refused`, paths };
	if (changed.length > 0) return { detail: "has new or changed untracked files", paths };
	return ignored.length > 0 ? { detail: "holds authored files the repository ignores", paths } : null;
}

/**
 * How a worktree no longer holds exactly what was previewed, or null when it
 * does. An operator chose on that exact listing, so a vanished file counts.
 */
function previewDrift(
	worktree: TaskWorktree,
	preview: TaskWorktreePreview,
	head: string,
	paths = untrackedPaths(worktree.path),
): string | null {
	const drift = heldDrift(worktree, preview, head, paths);
	if (drift !== null) return drift.detail;
	const listed = new Set(paths);
	return [...preview.untracked.keys()].every((entry) => listed.has(entry)) ? null : "has new or changed untracked files";
}

/**
 * What a forced removal would delete beyond `accounted`, or null when it would
 * delete nothing else. A merge leaves the worktree on the commit it pinned, so
 * this reads clean unless something arrived since. A worktree that cannot be
 * read, or a run with no record, reads as drift: only a positive answer removes.
 */
export function taskWorktreePreviewDrift(
	worktree: TaskWorktree,
	accounted: TaskWorktreePreview | undefined,
): TaskWorktreeDrift | null {
	if (accounted === undefined) return { detail: "has contents no commit accounted for", paths: [] };
	try {
		if (!existsSync(worktree.path)) return null;
		const head = checkTaskWorktreeHead(worktree);
		if (!head.ok) return { detail: head.detail, paths: [] };
		return heldDrift(worktree, accounted, head.commit, untrackedPaths(worktree.path));
	} catch (error) {
		return { detail: `could not be read: ${error instanceof Error ? error.message : String(error)}`, paths: [] };
	}
}

/** Why a worktree outlived its automatic cleanup, naming the bounded paths and how to recover them. */
export function keptTaskWorktreeDetail(worktree: TaskWorktree, commit: string, drift: TaskWorktreeDrift): string {
	const named = drift.paths.slice(0, LEFT_UNCOMMITTED_LIST_LIMIT);
	const more = drift.paths.length - named.length;
	const listing = named.length > 0 ? ` (${named.join(", ")}${more > 0 ? ` and ${more} more` : ""})` : "";
	return `kept worktree ${worktree.path} and branch ${worktree.branch}: it ${drift.detail}${listing} beyond commit ${commit.slice(0, 7)}; inspect them, and \`clio-coder fleet land ${worktree.branch}\` lands what the worktree holds`;
}

/** A merged run's receipt once `drift` kept its worktree. */
export function receiptWithDrift(
	receipt: TaskWorktreeReceipt,
	worktree: TaskWorktree,
	drift: TaskWorktreeDrift,
): TaskWorktreeReceipt {
	const report = leftUncommittedReport(drift.paths);
	const kept = keptTaskWorktreeDetail(worktree, receipt.commit ?? worktree.base, drift);
	return {
		...receipt,
		...(report !== undefined ? { changedAfterCommit: report } : {}),
		detail: receipt.detail !== undefined ? `${receipt.detail}; ${kept}` : kept,
	};
}

/** The branch a merge from this task would land on right now: the source checkout's branch, or `detached HEAD`. */
export function mergeDestination(root: string): string {
	try {
		return git(root, ["branch", "--show-current"]) || "detached HEAD";
	} catch {
		return "an unreadable HEAD";
	}
}

/** Whether `HEAD` of the source checkout has `base` in its history. `unknown` when git could not say. */
function headContainsBase(root: string, base: string): "yes" | "no" | "unknown" {
	try {
		git(root, ["merge-base", "--is-ancestor", base, "HEAD"]);
		return "yes";
	} catch (error) {
		// `--is-ancestor` exits 1 for "not an ancestor"; any other status is git failing.
		return (error as { status?: unknown }).status === 1 ? "no" : "unknown";
	}
}

/** Why the source checkout cannot take this task's merge as it stands, or null when it can. */
export function destinationRefusal(worktree: TaskWorktree, destination: string): string | null {
	const kept = `Nothing was merged; the task branch ${worktree.branch} is preserved.`;
	const dispatched = worktree.sourceBranch;
	if (dispatched !== undefined && destination !== dispatched) {
		return `${WORKTREE_DESTINATION_MOVED}: task worktree ${worktree.runId} was dispatched from branch ${dispatched}, but the checkout is now on ${destination}. ${kept} Switch back to ${dispatched} and merge ${worktree.branch}.`;
	}
	const short = worktree.base.slice(0, 7);
	switch (headContainsBase(worktree.root, worktree.base)) {
		case "yes":
			return null;
		case "no":
			return `${WORKTREE_DESTINATION_MOVED}: ${destination} does not contain base ${short} that task branch ${worktree.branch} was cut from${dispatched !== undefined ? ` on ${dispatched}` : ""}, so merging would also land commits the task was never built on. ${kept}`;
		case "unknown":
			return `${WORKTREE_DESTINATION_MOVED}: git could not confirm that ${destination} contains base ${short} of task branch ${worktree.branch}. ${kept}`;
	}
}

export function applyTaskWorktree(input: {
	worktree: TaskWorktree;
	apply: TaskWorktreeApply;
	protectedPaths?: ReadonlyArray<string>;
	/** The worker's validated `commitMessage`; a merge lands it on the operator's branch. */
	commitMessage?: string | null;
	/**
	 * Absolute paths the run's successful mutation calls wrote, as the host
	 * observed them. The only untracked files the settle commit takes beside
	 * what the worker staged, or null when the run has no complete write record;
	 * see `commitWorktreePath`.
	 */
	authoredPaths: Iterable<string> | null;
	/**
	 * Merge exactly the commit an earlier pass pinned and an operator was shown,
	 * instead of committing the working tree again. Refused unless the branch
	 * still names it and the tree holds nothing newer, so a window between the
	 * preview and the merge cannot land work nobody saw.
	 */
	preview?: TaskWorktreePreview;
	/**
	 * Receives what this pass accounted for: the preview it merged, or the commit
	 * it pinned with the post-commit listing behind `leftUncommitted`. Automatic
	 * cleanup compares the worktree with it. Kept off the receipt, which is sealed.
	 */
	onAccounted?: (accounted: TaskWorktreePreview) => void;
}): TaskWorktreeReceipt {
	const { worktree } = input;
	const before = checkTaskWorktreeHead(worktree);
	if (!before.ok) return headMovedReceipt(worktree, input.apply, before.detail);
	let commit: string;
	let leftUncommitted: string[];
	let ignoredAuthored: string[];
	let accounted: TaskWorktreePreview;
	if (input.preview !== undefined) {
		commit = input.preview.commit;
		// Nothing is committed now, so every untracked file stays out of this merge.
		leftUncommitted = untrackedPaths(worktree.path);
		const found = previewDrift(worktree, input.preview, before.commit, leftUncommitted);
		if (found !== null) {
			const drift = `${WORKTREE_CHANGED_SINCE_PREVIEW}: task worktree ${worktree.runId} ${found} since commit ${commit} was offered for merge. Nothing was merged; the branch ${worktree.branch} is preserved.`;
			return {
				...committedReceipt(worktree, commit, input.apply),
				...leftUncommittedField(leftUncommitted),
				reason: WORKTREE_CHANGED_SINCE_PREVIEW,
				detail: drift,
			};
		}
		ignoredAuthored = ignoredAuthoredPaths(worktree.path, input.authoredPaths);
		accounted = ignoredAuthored.length > 0 ? { ...input.preview, ignored: ignoredAuthored } : input.preview;
	} else {
		const taskLine = `Clio Coder task ${worktree.runId}`;
		// The validated message is already stripped; this is the sink, and only
		// Clio's managed hook may write trailers onto the operator's branch.
		const authored =
			input.commitMessage === undefined || input.commitMessage === null
				? undefined
				: stripAuthoredTrailers(input.commitMessage);
		const committed = commitWorktreePath(
			worktree.path,
			COMMIT_IDENTITY,
			authored !== undefined && authored.length > 0 ? `${authored}\n\n${taskLine}` : taskLine,
			{ authoredPaths: input.authoredPaths },
		);
		leftUncommitted = committed.leftUncommitted;
		ignoredAuthored = committed.ignoredAuthored;
		// Pin the commit the snapshot produced. Everything after this reads and
		// merges that immutable id, so a branch moved later cannot swap it (F5).
		const pinned = checkTaskWorktreeHead(worktree);
		if (!pinned.ok) return headMovedReceipt(worktree, input.apply, pinned.detail);
		if (pinned.commit !== committed.accounted.commit)
			return headMovedReceipt(worktree, input.apply, "HEAD changed after the host commit");
		commit = committed.accounted.commit;
		accounted = committed.accounted;
	}
	input.onAccounted?.(accounted);
	const receipt = {
		...committedReceipt(worktree, commit, input.apply),
		...leftUncommittedField([...new Set([...leftUncommitted, ...ignoredAuthored])].sort()),
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
	const destinationBranch = mergeDestination(worktree.root);
	// The merge lands on whatever the source checkout has checked out now, and
	// a card can wait indefinitely while the operator or the main agent keeps
	// working, so the branch may have changed since dispatch.
	const stranded = destinationRefusal(worktree, destinationBranch);
	if (stranded !== null) return { ...receipt, reason: WORKTREE_DESTINATION_MOVED, detail: stranded };
	const merged = mergeWorktreeBranch(worktree.root, commit, COMMIT_IDENTITY, `Merge branch '${worktree.branch}'`);
	if (!merged.ok) {
		return {
			...receipt,
			reason: merged.code ?? "worktree_merge_conflict",
			detail: `${merged.reason}; its work is committed on the preserved branch ${worktree.branch}, and \`clio-coder fleet land ${worktree.branch}\` lands it once that is resolved`,
		};
	}
	const landedCommit = git(worktree.root, ["rev-parse", "HEAD"]);
	if ((receipt.changedPaths?.length ?? 0) === 0) {
		// Merging a branch at its base moves nothing, so the destination's own head is not this run's landing.
		return { ...receipt, applied: true, detail: "nothing merged: the task branch holds no change beyond its base" };
	}
	const ignoredNote =
		ignoredAuthored.length === 0
			? ""
			: `; ${ignoredAuthored.length} authored ${ignoredAuthored.length === 1 ? "file is" : "files are"} ignored by .gitignore and stay${ignoredAuthored.length === 1 ? "s" : ""} in the worktree`;
	return {
		...receipt,
		applied: true,
		detail: `merged ${landedCommit.slice(0, 7)} onto ${destinationBranch}${ignoredNote}`,
	};
}

/**
 * Only yolo admits a task worker's write outside its worktree, which a local model does when it takes the checkout for
 * its root. That work reaches no branch, so a plain "nothing merged" beside a worker's success would hide edits sitting
 * in the operator's tree.
 */
export function withStrayWrites<Receipt extends { detail?: string }>(
	receipt: Receipt,
	worktree: Pick<TaskWorktree, "path">,
	mutatedPaths: Iterable<string>,
): Receipt {
	const stray = [...mutatedPaths].filter((target) => {
		const inside = relative(worktree.path, target);
		return inside.startsWith("..") || isAbsolute(inside);
	});
	if (stray.length === 0) return receipt;
	const named = `${stray.slice(0, 5).join(", ")}${stray.length > 5 ? ", ..." : ""}`;
	const note = `the worker also wrote outside its task worktree, so these changes are on no branch: ${named}`;
	return { ...receipt, detail: receipt.detail === undefined ? note : `${receipt.detail}; ${note}` };
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

/**
 * The forced removal of a finished worktree, unless it holds more than
 * `accounted`. A kept worktree settles as preserved so restart recovery does not
 * read it as a crash, and the drift that kept it comes back for the receipt.
 * Call before sealing that receipt so the cleanup and its report agree.
 */
export function cleanupAccountedTaskWorktree(
	worktree: TaskWorktree,
	accounted: TaskWorktreePreview | undefined,
): TaskWorktreeDrift | null {
	assertOwnership(worktree);
	const drift = taskWorktreePreviewDrift(worktree, accounted);
	if (drift === null) cleanupTaskWorktree(worktree, true);
	else settleTaskWorktree(worktree, accounted);
	return drift;
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
 * no `git branch -D`. With `preview`, nothing is removed unless the worktree
 * still holds exactly what it recorded. A worktree gone with its branch kept releases the claim,
 * because nothing of Clio's is left to guard and the operator holds the branch.
 */
export function discardTaskWorktree(worktree: TaskWorktree, preview?: TaskWorktreePreview): TaskWorktreeDiscard {
	try {
		assertOwnership(worktree);
		// `worktree remove --force` and `branch -D` delete whatever was added after
		// the preview, so a previewed discard applies the same drift check as Merge.
		if (preview !== undefined) {
			const head = checkTaskWorktreeHead(worktree);
			if (!head.ok) return { outcome: "changed", detail: head.detail };
			const found = previewDrift(worktree, preview, head.commit);
			if (found !== null) {
				return {
					outcome: "changed",
					detail: `task worktree ${worktree.runId} ${found} since commit ${preview.commit} was offered for discard`,
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
export function settleTaskWorktree(worktree: TaskWorktree, accounted?: TaskWorktreePreview): void {
	assertOwnership(worktree);
	const ownerPath = claimPathFor(worktree.root, worktree.runId);
	const marker = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
	if (marker.version !== 2) return;
	replaceMarker(ownerPath, {
		...marker,
		state: "settled" satisfies TaskWorktreeState,
		...(accounted !== undefined ? accountedField(accounted) : {}),
	});
}

function accountedField(accounted: TaskWorktreePreview): {
	accounted: { commit: string; untracked: object; ignored?: ReadonlyArray<string> };
} {
	return {
		accounted: {
			commit: accounted.commit,
			untracked: Object.fromEntries(accounted.untracked),
			...(accounted.ignored !== undefined && accounted.ignored.length > 0 ? { ignored: accounted.ignored } : {}),
		},
	};
}

/**
 * Move a kept worktree's record onto a commit a landing just made. The landing
 * can still be refused or keep the worktree, and a retry against the old commit
 * would read the left-out files as never accounted for and land them.
 */
export function recordTaskWorktreeAccounted(worktree: TaskWorktree, accounted: TaskWorktreePreview): void {
	assertOwnership(worktree);
	const ownerPath = claimPathFor(worktree.root, worktree.runId);
	const marker = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
	if (marker.version !== 2) return;
	replaceMarker(ownerPath, { ...marker, ...accountedField(accounted) });
}

/** The snapshot a settled claim recorded; anything malformed reads as no record, which lands every untracked file. */
function claimAccounted(marker: Record<string, unknown>): TaskWorktreePreview | undefined {
	const accounted = marker.accounted;
	if (typeof accounted !== "object" || accounted === null) return undefined;
	const { commit, untracked, ignored } = accounted as { commit?: unknown; untracked?: unknown; ignored?: unknown };
	if (typeof commit !== "string" || typeof untracked !== "object" || untracked === null) return undefined;
	const entries = Object.entries(untracked);
	if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) return undefined;
	const held = Array.isArray(ignored) ? ignored.filter((entry): entry is string => typeof entry === "string") : [];
	return { commit, untracked: new Map(entries), ...(held.length > 0 ? { ignored: held } : {}) };
}

/**
 * The untracked files a landing leaves behind: those the run's own commit left
 * out and that have not changed since. Its stamps let the landing's cleanup
 * remove them with the worktree, and a file that arrived or changed later is
 * not here, so it lands.
 */
export function leftOutOfLanding(
	path: string,
	head: string,
	accounted: TaskWorktreePreview | undefined,
): Map<string, string> {
	const leftOut = new Map<string, string>();
	if (accounted === undefined || accounted.commit !== head) return leftOut;
	for (const [entry, stamp] of untrackedState(path).stamps) {
		if (stamp !== GONE_STAMP && accounted.untracked.get(entry) === stamp) leftOut.set(entry, stamp);
	}
	return leftOut;
}

/** The untracked files of the worktree at `path` outside `leftOut`, as the absolute paths `commitWorktreePath` takes. */
export function landedUntrackedPaths(path: string, leftOut: ReadonlyMap<string, string>): string[] {
	return untrackedPaths(path)
		.filter((entry) => !leftOut.has(entry))
		.map((entry) => join(path, entry));
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
		return `git could not inspect it: ${gitFailureReason(error, "Git inspection failed.")}`;
	}
}

/**
 * Whether a finished run's worktree holds anything to land: a commit beyond its base, or any modified, staged
 * or untracked file. Fails toward true, so an unreadable tree keeps every gate that would have applied to it.
 */
export function taskWorktreeHoldsWork(worktree: TaskWorktree): boolean {
	return workHeldBy(worktree.root, worktree) !== null;
}

function preservedView(
	claim: TaskClaim,
	state: TaskWorktreeState,
	reason: string,
	canonical: string,
): PreservedTaskWorktree {
	return {
		runId: claim.runId,
		path: claim.path,
		claimPath: claim.ownerPath,
		branch: claim.branch,
		base: claim.base,
		state,
		createdAt: claim.createdAt,
		reason,
		stale: claimIsStale(canonical, claim),
	};
}

/**
 * A claim whose branch and working tree are both gone. Either one surviving
 * may hold the run's only copy of its work, and a git failure is not proof of
 * absence, so both count as not stale.
 */
function claimIsStale(canonical: string, claim: Pick<TaskClaim, "branch" | "path">): boolean {
	if (existsSync(claim.path)) return false;
	try {
		git(canonical, ["rev-parse", "--verify", "--quiet", `refs/heads/${claim.branch}`]);
		return false;
	} catch (error) {
		// `--verify --quiet` exits 1 with no output for a missing ref; any other
		// failure leaves the question open.
		return (error as { status?: unknown }).status === 1;
	}
}

/**
 * Remove a stale claim file for `doctor --fix`, after checking again that its
 * branch and working tree are still gone. Returns whether it was removed.
 */
export function clearStaleTaskClaim(root: string, entry: PreservedTaskWorktree): boolean {
	let canonical: string;
	try {
		canonical = realpathSync(root);
	} catch {
		return false;
	}
	const claim = readTaskClaims(canonical, [dirname(entry.path)]).find((candidate) => candidate.runId === entry.runId);
	if (claim === undefined || claim.ownerPath !== entry.claimPath || !claimIsStale(canonical, claim)) return false;
	rmSync(claim.ownerPath, { force: true });
	return true;
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
				result.preserved.push(preservedView(claim, "abandoned", held, canonical));
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
 * A finished run's task worktree as `fleet land` needs it, ownership token
 * included so landing can release the claim. A claim whose owner is alive is a
 * run in flight whose worker may still write, so it is reported as running.
 */
export function loadKeptTaskWorktree(
	root: string,
	runId: string,
	allowedParents?: ReadonlyArray<string>,
): { kind: "kept"; worktree: TaskWorktree; accounted?: TaskWorktreePreview } | { kind: "running" } | null {
	if (!SAFE_RUN_ID.test(runId)) return null;
	let canonical: string;
	try {
		canonical = realpathSync(root);
	} catch {
		return null;
	}
	const claim = readTaskClaims(canonical, allowedParents ?? [diskWorktreeParent(canonical)]).find(
		(candidate) => candidate.runId === runId,
	);
	if (claim === undefined || typeof claim.marker.ownerToken !== "string") return null;
	if (claim.state === "active" && claim.owner !== null && ownerIsAlive(claim.owner)) return { kind: "running" };
	const sourceBranch = typeof claim.marker.sourceBranch === "string" ? claim.marker.sourceBranch : undefined;
	const accounted = claimAccounted(claim.marker);
	return {
		kind: "kept",
		worktree: {
			root: canonical,
			runId,
			path: claim.path,
			parent: dirname(claim.path),
			branch: claim.branch,
			base: claim.base,
			...(sourceBranch !== undefined && sourceBranch.length > 0 ? { sourceBranch } : {}),
			ownerToken: claim.marker.ownerToken,
		},
		...(accounted !== undefined ? { accounted } : {}),
	};
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
		if (claim.state === "settled") out.push(preservedView(claim, "settled", "kept by its run", canonical));
		else if (claim.state === "abandoned")
			out.push(preservedView(claim, "abandoned", "its owner died holding work", canonical));
		else if (claim.owner === null)
			out.push(preservedView(claim, "active", "its claim predates restart recovery", canonical));
		else if (!ownerIsAlive(claim.owner))
			out.push(preservedView(claim, "active", "its owner is gone; the next start recovers it", canonical));
	}
	return out;
}
