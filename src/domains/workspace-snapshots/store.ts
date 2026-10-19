import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { GITLINK_MODE, parseRawDiff, runGit, SnapshotUnavailableError, splitNul } from "./git.js";

/**
 * Workspace snapshots: the recoverability layer under autonomy. A snapshot is
 * a Git commit of the worktree as it stands (tracked files plus untracked files
 * that are not ignored), built in a private per-session index so the operator's
 * index, HEAD, branches and worktree are never touched. Refs live under
 * `refs/clio-coder/snapshots/<session>/<n>`, which Git keeps in the common
 * directory of a linked worktree. Only a Git work tree can be snapshotted;
 * everything else reports the snapshot unavailable and the caller proceeds.
 */

export const SNAPSHOT_REF_PREFIX = "refs/clio-coder/snapshots";
/** Untracked files above this are left out of a snapshot and listed as skipped. */
export const SNAPSHOT_MAX_UNTRACKED_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_TIMEOUT_MS = 20_000;
const SNAPSHOT_KEEP = 50;
const SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const LOG_FILE = "log.json";
/** A fixed identity, so a snapshot needs no Git identity from the operator. */
const SNAPSHOT_IDENTITY: Readonly<Record<string, string>> = {
	GIT_AUTHOR_NAME: "Clio Coder snapshot",
	GIT_AUTHOR_EMAIL: "snapshot@clio-coder.invalid",
	GIT_COMMITTER_NAME: "Clio Coder snapshot",
	GIT_COMMITTER_EMAIL: "snapshot@clio-coder.invalid",
};

export interface SnapshotSkip {
	path: string;
	why: "too-large" | "nested-repository";
	bytes?: number;
}

export interface WorkspaceSnapshotRecord {
	n: number;
	/** ISO time the snapshot was taken. */
	at: string;
	reason: string;
	tool?: string;
	toolCallId?: string;
	turnId?: string;
	tree: string;
	commit: string;
	ref: string;
	skipped: SnapshotSkip[];
}

export interface WorkspaceSnapshotRequest {
	reason: string;
	tool?: string;
	toolCallId?: string;
	turnId?: string;
}

export type WorkspaceSnapshotOutcome =
	| { kind: "taken"; record: WorkspaceSnapshotRecord; reused: boolean; durationMs: number }
	| { kind: "unavailable"; reason: string; durationMs: number };

export interface RewindKept {
	path: string;
	why: string;
}

export interface RewindPlan {
	n: number;
	/** Files written from the snapshot: overwritten when they differ, recreated when missing. */
	restore: string[];
	/** Files that exist now (tracked, or untracked and not ignored) but are absent from the snapshot. */
	remove: string[];
	/** Differences a rewind leaves alone, with the reason. */
	kept: RewindKept[];
}

export type RewindPreview = { kind: "plan"; plan: RewindPlan } | { kind: "unavailable"; reason: string };

export type RewindOutcome =
	| {
			kind: "restored";
			n: number;
			/** Taken just before the restore, so the rewind itself can be rewound. */
			preRewind: WorkspaceSnapshotRecord;
			restored: string[];
			removed: string[];
			kept: RewindKept[];
			failed: RewindKept[];
	  }
	| { kind: "unavailable"; reason: string }
	| { kind: "failed"; reason: string; preRewind: WorkspaceSnapshotRecord };

export type SnapshotDifferences =
	| { kind: "counts"; counts: ReadonlyMap<number, number> }
	| { kind: "unavailable"; reason: string };

export interface WorkspaceSnapshots {
	readonly sessionId: string;
	snapshot(request: WorkspaceSnapshotRequest): Promise<WorkspaceSnapshotOutcome>;
	/** This session's snapshots, newest first. */
	list(): WorkspaceSnapshotRecord[];
	/** How many files each snapshot differs from the workspace by, keyed by snapshot number. */
	differences(): Promise<SnapshotDifferences>;
	preview(n: number): Promise<RewindPreview>;
	restore(n: number): Promise<RewindOutcome>;
}

export interface WorkspaceSnapshotsOptions {
	stateDir: string;
	sessionId: string;
	/** Any directory inside the work tree; the snapshot covers the whole tree. */
	cwd: string;
	timeoutMs?: number;
	maxUntrackedBytes?: number;
	keep?: number;
}

interface SnapshotLog {
	version: 1;
	sessionId: string;
	workspace: string;
	commonDir: string;
	updatedAt: string;
	next: number;
	/** Oldest first. */
	snapshots: WorkspaceSnapshotRecord[];
}

interface Repository {
	root: string;
	commonDir: string;
	/** The operator's own index, read only to seed the private one. */
	realIndex: string;
}

/**
 * Automatic preservation runs no repository-configured command: no hooks, no
 * fsmonitor, and no clean, smudge or process filter (the same stance as the
 * dispatch workspace checkpoint). A filtered file is stored and restored as
 * the bytes in the work tree. Read once a minute per repository.
 */
const PLUMBING_CONFIG_TTL_MS = 60_000;
const plumbingConfigCache = new Map<string, { at: number; config: string[] }>();

async function plumbingConfig(repo: Repository, deadline: number): Promise<string[]> {
	const cached = plumbingConfigCache.get(repo.commonDir);
	const now = performance.now();
	if (cached !== undefined && now - cached.at < PLUMBING_CONFIG_TTL_MS && now >= cached.at) return cached.config;
	const keys = splitNul(
		(
			await runGit(["config", "--null", "--name-only", "--list"], {
				cwd: repo.root,
				deadline,
				allowExit: [1],
			})
		).stdout,
	);
	const config = ["core.hooksPath=/dev/null", "core.fsmonitor=false"];
	for (const key of keys) {
		if (/^filter\..*\.(?:clean|smudge|process|required)$/u.test(key))
			config.push(`${key}=${key.endsWith(".required") ? "false" : ""}`);
	}
	plumbingConfigCache.set(repo.commonDir, { at: now, config });
	return config;
}

function snapshotsRoot(stateDir: string): string {
	return path.join(stateDir, "snapshots");
}

/** Session ids become a directory name and a ref component, so both rules apply. */
function sessionIdProblem(id: string): string | null {
	const shaped = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/u.test(id);
	return shaped && id.length <= 128 && !id.endsWith(".lock")
		? null
		: `session id ${JSON.stringify(id)} cannot name a snapshot ref`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * One queue per session directory. The private index and the log are shared by
 * the tool registry and `/rewind`, and Git's own index lock would turn a race
 * into a failed snapshot rather than a wait.
 */
const sessionQueues = new Map<string, Promise<void>>();

function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prior = sessionQueues.get(key) ?? Promise.resolve();
	const run = prior.then(fn);
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	sessionQueues.set(key, tail);
	void tail.then(() => {
		if (sessionQueues.get(key) === tail) sessionQueues.delete(key);
	});
	return run;
}

function readLog(dir: string): SnapshotLog | null {
	try {
		const parsed = JSON.parse(readFileSync(path.join(dir, LOG_FILE), "utf8")) as Partial<SnapshotLog>;
		if (
			parsed.version !== 1 ||
			!Array.isArray(parsed.snapshots) ||
			typeof parsed.next !== "number" ||
			typeof parsed.workspace !== "string" ||
			typeof parsed.commonDir !== "string" ||
			typeof parsed.updatedAt !== "string"
		)
			return null;
		return parsed as SnapshotLog;
	} catch {
		// A missing or unreadable log is a session with no snapshots yet.
		return null;
	}
}

function writeLog(dir: string, log: SnapshotLog): void {
	safeResourceWrite(path.join(dir, LOG_FILE), `${JSON.stringify(log, null, 2)}\n`);
}

function lines(text: string): string[] {
	return text
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Cheap and synchronous: whether a snapshot of `cwd` has a Git work tree to
 * capture, judged by a `.git` entry at or above it. Admission reads it on
 * every call of the operator's default to decide whether a destructive call a
 * snapshot would undo may run unasked; the snapshot itself still checks with
 * Git and the call is refused when that fails.
 */
export function workspaceSnapshotRepositoryPresent(cwd: string): boolean {
	for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
		try {
			if (statSync(path.join(current, ".git"), { throwIfNoEntry: false }) !== undefined) return true;
		} catch {
			// An unreadable level cannot vouch for a repository; keep walking up.
		}
		if (path.dirname(current) === current) return false;
	}
}

async function resolveRepository(cwd: string, deadline: number): Promise<Repository> {
	if (!existsSync(cwd)) throw new SnapshotUnavailableError(`workspace ${cwd} does not exist`);
	// One call answers every case: a bare repository and a .git directory print
	// their two booleans before --show-toplevel fails, and outside a repository
	// nothing prints at all.
	const out = await runGit(
		[
			"rev-parse",
			"--is-bare-repository",
			"--is-inside-work-tree",
			"--show-toplevel",
			"--git-common-dir",
			"--git-path",
			"index",
		],
		{ cwd, deadline, allowExit: [128] },
	);
	const [bare, inside, root, commonDir, realIndex] = lines(out.stdout);
	if (bare === undefined) {
		const detail = lines(out.stderr)[0] ?? "";
		throw new SnapshotUnavailableError(
			/not a git repository/iu.test(detail) ? "not a git repository" : `git rev-parse failed: ${detail}`,
		);
	}
	if (bare === "true") throw new SnapshotUnavailableError("bare repository");
	if (inside !== "true" || root === undefined || commonDir === undefined || realIndex === undefined)
		throw new SnapshotUnavailableError("not inside a git work tree");
	return { root: path.resolve(root), commonDir: path.resolve(cwd, commonDir), realIndex: path.resolve(cwd, realIndex) };
}

/** True when anything, of any type, is at `rel` under `root`. */
function occupied(root: string, rel: string): boolean {
	try {
		lstatSync(path.join(root, rel));
		return true;
	} catch {
		return false;
	}
}

/** A path Git reported, held to the work tree it came from. */
function insideRoot(root: string, rel: string): string {
	const abs = path.resolve(root, rel);
	const back = path.relative(root, abs);
	if (back.length === 0 || back.startsWith("..") || path.isAbsolute(back))
		throw new SnapshotUnavailableError(`path ${rel} is outside the work tree`);
	return abs;
}

async function deleteRefs(cwd: string, refs: ReadonlyArray<string>, deadline: number, gitDir?: string): Promise<void> {
	if (refs.length === 0) return;
	await runGit([...(gitDir !== undefined ? [`--git-dir=${gitDir}`] : []), "update-ref", "--stdin"], {
		cwd,
		deadline,
		input: refs.map((ref) => `delete ${ref}\n`).join(""),
	});
}

async function sessionRefs(cwd: string, sessionId: string, deadline: number, gitDir?: string): Promise<string[]> {
	const out = await runGit(
		[
			...(gitDir !== undefined ? [`--git-dir=${gitDir}`] : []),
			"for-each-ref",
			"--format=%(refname)",
			`${SNAPSHOT_REF_PREFIX}/${sessionId}/`,
		],
		{ cwd, deadline },
	);
	return lines(out.stdout);
}

export function createWorkspaceSnapshots(options: WorkspaceSnapshotsOptions): WorkspaceSnapshots {
	const { stateDir, sessionId, cwd } = options;
	const timeoutMs = options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
	const maxUntrackedBytes = options.maxUntrackedBytes ?? SNAPSHOT_MAX_UNTRACKED_BYTES;
	const keep = Math.max(1, options.keep ?? SNAPSHOT_KEEP);
	const idProblem = sessionIdProblem(sessionId);
	const dir = path.join(snapshotsRoot(stateDir), idProblem === null ? sessionId : "invalid");
	const indexFile = path.join(dir, "index");

	/** Copy the operator's index so the first snapshot inherits its stat cache instead of rehashing every file. */
	const seedIndex = async (repo: Repository, deadline: number): Promise<"copy" | "head" | "empty"> => {
		try {
			copyFileSync(repo.realIndex, indexFile);
			return "copy";
		} catch {
			// No index yet (a fresh repository): fall back to HEAD's tree.
		}
		return seedFromHead(repo, deadline);
	};

	const seedFromHead = async (repo: Repository, deadline: number): Promise<"head" | "empty"> => {
		rmSync(indexFile, { force: true });
		const head = await runGit(["rev-parse", "--verify", "-q", "HEAD^{tree}"], {
			cwd: repo.root,
			deadline,
			allowExit: [1, 128],
		});
		const tree = head.stdout.trim();
		if (head.exitCode !== 0 || tree.length === 0) return "empty";
		await runGit(["read-tree", tree], { cwd: repo.root, deadline, indexFile });
		return "head";
	};

	/**
	 * Bring the private index level with the work tree and write its tree. The
	 * untracked listing reads the operator's index, so "untracked" means what
	 * the operator sees as untracked; `.gitignore` is respected by both Git
	 * passes. Oversized untracked files and nested repositories are excluded
	 * before Git reads them, then dropped from the private index in case an
	 * earlier snapshot carried them.
	 */
	const stageWorkspace = async (
		repo: Repository,
		deadline: number,
	): Promise<{ tree: string; skipped: SnapshotSkip[] }> => {
		mkdirSync(dir, { recursive: true });
		// Only this session writes its private index, under the session lock, so
		// a lock file is what a killed Git left behind.
		rmSync(`${indexFile}.lock`, { force: true });
		const seed = existsSync(indexFile) ? "existing" : await seedIndex(repo, deadline);
		const config = await plumbingConfig(repo, deadline);
		const others = splitNul(
			(await runGit(["ls-files", "-z", "--others", "--exclude-standard"], { cwd: repo.root, deadline, config })).stdout,
		);
		const skipped: SnapshotSkip[] = [];
		for (const rel of others) {
			if (rel.endsWith("/")) {
				skipped.push({ path: rel.slice(0, -1), why: "nested-repository" });
				continue;
			}
			try {
				const stat = lstatSync(path.join(repo.root, rel));
				if (stat.isFile() && stat.size > maxUntrackedBytes) skipped.push({ path: rel, why: "too-large", bytes: stat.size });
			} catch {
				// Deleted since the listing; `git add -A` sees the same absence.
			}
		}
		const addSpecs = [".", ...skipped.map((skip) => `:(exclude,literal)${skip.path}`)].join("\0");
		const add = () =>
			runGit(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
				cwd: repo.root,
				deadline,
				indexFile,
				config,
				input: `${addSpecs}\0`,
			});
		try {
			await add();
		} catch (error) {
			// A copied index Git cannot use here (a split index, an extension this
			// Git does not know) is replaced by HEAD's tree and tried once more.
			if (seed !== "copy") throw error;
			await seedFromHead(repo, deadline);
			await add();
		}
		if (skipped.length > 0) {
			await runGit(["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], {
				cwd: repo.root,
				deadline,
				indexFile,
				config,
				input: `${skipped.map((skip) => `:(literal)${skip.path}`).join("\0")}\0`,
			});
		}
		const tree = (await runGit(["write-tree"], { cwd: repo.root, deadline, indexFile })).stdout.trim();
		if (!/^[0-9a-f]{40,64}$/u.test(tree)) throw new SnapshotUnavailableError("git write-tree returned no tree");
		return { tree, skipped };
	};

	const snapshotLocked = async (
		request: WorkspaceSnapshotRequest,
		deadline: number,
	): Promise<{ record: WorkspaceSnapshotRecord; reused: boolean }> => {
		const repo = await resolveRepository(cwd, deadline);
		const log = readLog(dir);
		if (log !== null && log.workspace !== repo.root)
			throw new SnapshotUnavailableError(`this session's snapshots belong to ${log.workspace}`);
		const staged = await stageWorkspace(repo, deadline);
		const last = log?.snapshots.at(-1);
		if (last !== undefined && last.tree === staged.tree) return { record: last, reused: true };
		// A lost log must not reuse a number whose ref still exists.
		const n =
			log?.next ??
			(await sessionRefs(repo.root, sessionId, deadline)).reduce(
				(max, ref) => Math.max(max, Number(ref.split("/").at(-1)) + 1 || max),
				1,
			);
		const message = [
			`Clio Coder snapshot ${n} (${request.reason})`,
			"",
			`Session: ${sessionId}`,
			...(request.tool !== undefined ? [`Tool: ${request.tool}`] : []),
			"",
		].join("\n");
		const commit = (
			await runGit(["commit-tree", "--no-gpg-sign", staged.tree], {
				cwd: repo.root,
				deadline,
				input: message,
				env: SNAPSHOT_IDENTITY,
			})
		).stdout.trim();
		const ref = `${SNAPSHOT_REF_PREFIX}/${sessionId}/${n}`;
		await runGit(["update-ref", ref, commit], { cwd: repo.root, deadline });
		const record: WorkspaceSnapshotRecord = {
			n,
			at: new Date().toISOString(),
			reason: request.reason,
			...(request.tool !== undefined ? { tool: request.tool } : {}),
			...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
			...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
			tree: staged.tree,
			commit,
			ref,
			skipped: staged.skipped,
		};
		const snapshots = [...(log?.snapshots ?? []), record];
		const dropped = snapshots.length > keep ? snapshots.splice(0, snapshots.length - keep) : [];
		writeLog(dir, {
			version: 1,
			sessionId,
			workspace: repo.root,
			commonDir: repo.commonDir,
			updatedAt: record.at,
			next: n + 1,
			snapshots,
		});
		try {
			await deleteRefs(
				repo.root,
				dropped.map((old) => old.ref),
				deadline,
			);
		} catch {
			// Retention is best effort; the age prune removes what is left.
		}
		return { record, reused: false };
	};

	/**
	 * What a rewind to `target` changes in a work tree whose current content is
	 * `current`. Both trees come from the same staging, so a path in neither is
	 * something staging leaves out: an ignored file, an oversized untracked file
	 * or a nested repository, and a rewind never touches those.
	 */
	const planRewind = async (repo: Repository, target: WorkspaceSnapshotRecord, current: string, deadline: number) => {
		const diff = parseRawDiff(
			(await runGit(["diff-tree", "-r", "-z", "--no-renames", target.tree, current], { cwd: repo.root, deadline })).stdout,
		);
		const restore: string[] = [];
		const remove: string[] = [];
		const kept: RewindKept[] = [];
		for (const entry of diff) {
			if (entry.fromMode === GITLINK_MODE || entry.toMode === GITLINK_MODE) {
				kept.push({ path: entry.path, why: "nested repository" });
			} else if (entry.status === "A") {
				remove.push(entry.path);
			} else if (entry.status === "D" && occupied(repo.root, entry.path)) {
				kept.push({ path: entry.path, why: "an ignored or untracked file is in the way" });
			} else {
				restore.push(entry.path);
			}
		}
		// The private index can still carry a file an earlier snapshot took before
		// it was ignored. Git answers for the operator's view: tracked files are
		// never reported, so only ignored untracked files are held back.
		const candidates = [...remove, ...restore.filter((rel) => occupied(repo.root, rel))];
		if (candidates.length > 0) {
			const ignored = new Set(
				splitNul(
					(
						await runGit(["check-ignore", "-z", "--stdin"], {
							cwd: repo.root,
							deadline,
							input: `${candidates.join("\0")}\0`,
							allowExit: [1],
						})
					).stdout,
				),
			);
			const keepIgnored = (rel: string): boolean => {
				if (!ignored.has(rel) || !occupied(repo.root, rel)) return true;
				kept.push({ path: rel, why: "ignored by .gitignore" });
				return false;
			};
			return {
				n: target.n,
				restore: restore.filter(keepIgnored),
				remove: remove.filter(keepIgnored),
				kept,
			};
		}
		return { n: target.n, restore, remove, kept };
	};

	const findRecord = (n: number): WorkspaceSnapshotRecord => {
		const record = readLog(dir)?.snapshots.find((candidate) => candidate.n === n);
		if (record === undefined) throw new SnapshotUnavailableError(`snapshot ${n} is not in this session`);
		return record;
	};

	/** Why `rel` cannot be written without destroying something the snapshot does not hold, or null. */
	const writeBlocker = (root: string, rel: string): string | null => {
		let cursor = root;
		for (const part of rel.split("/").slice(0, -1)) {
			cursor = path.join(cursor, part);
			let stat: ReturnType<typeof lstatSync>;
			try {
				stat = lstatSync(cursor);
			} catch {
				return null;
			}
			if (stat.isSymbolicLink()) return "a parent directory is a symbolic link";
			if (!stat.isDirectory()) return "a file outside the snapshot is in the way";
		}
		try {
			if (lstatSync(path.join(root, rel)).isDirectory()) return "a directory is in the way";
		} catch {
			// Nothing there: Git creates it.
		}
		return null;
	};

	const removeFile = (root: string, rel: string): void => {
		const abs = insideRoot(root, rel);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(abs);
		} catch {
			return;
		}
		if (stat.isDirectory()) throw new Error("is a directory");
		unlinkSync(abs);
		let parent = path.dirname(abs);
		while (parent !== root && parent.startsWith(`${root}${path.sep}`)) {
			try {
				rmdirSync(parent);
			} catch {
				// Not empty, or not ours to remove: stop pruning here.
				break;
			}
			parent = path.dirname(parent);
		}
	};

	const restoreLocked = async (n: number): Promise<RewindOutcome> => {
		const target = findRecord(n);
		let pre: WorkspaceSnapshotRecord;
		try {
			pre = (await snapshotLocked({ reason: "pre-rewind" }, performance.now() + timeoutMs)).record;
		} catch (error) {
			return { kind: "unavailable", reason: `no pre-rewind snapshot, so nothing was changed: ${errorText(error)}` };
		}
		try {
			const deadline = performance.now() + timeoutMs;
			const repo = await resolveRepository(cwd, deadline);
			const plan = await planRewind(repo, target, pre.tree, deadline);
			for (const rel of [...plan.remove, ...plan.restore]) insideRoot(repo.root, rel);
			const removed: string[] = [];
			const failed: RewindKept[] = [];
			// Removals first, so a file the snapshot holds as a directory (or the
			// reverse) has its place cleared before Git writes.
			for (const rel of plan.remove) {
				try {
					removeFile(repo.root, rel);
					removed.push(rel);
				} catch (error) {
					failed.push({ path: rel, why: errorText(error) });
				}
			}
			const writable: string[] = [];
			for (const rel of plan.restore) {
				const blocker = writeBlocker(repo.root, rel);
				if (blocker === null) writable.push(rel);
				else plan.kept.push({ path: rel, why: blocker });
			}
			if (writable.length > 0) {
				// A throwaway index holding the snapshot tree lets checkout-index write
				// exactly these paths with their modes, links and filters.
				const scratchIndex = path.join(dir, "rewind-index");
				rmSync(scratchIndex, { force: true });
				rmSync(`${scratchIndex}.lock`, { force: true });
				try {
					const config = await plumbingConfig(repo, deadline);
					await runGit(["read-tree", target.tree], { cwd: repo.root, deadline, indexFile: scratchIndex, config });
					await runGit(["checkout-index", "-f", "-z", "--stdin"], {
						cwd: repo.root,
						deadline,
						indexFile: scratchIndex,
						config,
						input: `${writable.join("\0")}\0`,
					});
				} finally {
					rmSync(scratchIndex, { force: true });
				}
			}
			return { kind: "restored", n, preRewind: pre, restored: writable, removed, kept: plan.kept, failed };
		} catch (error) {
			return { kind: "failed", reason: errorText(error), preRewind: pre };
		}
	};

	const locked = <T>(fn: () => Promise<T>): Promise<T> => withSessionLock(dir, fn);

	return {
		sessionId,
		async snapshot(request) {
			const started = performance.now();
			const elapsed = (): number => Math.round(performance.now() - started);
			if (idProblem !== null) return { kind: "unavailable", reason: idProblem, durationMs: 0 };
			try {
				const { record, reused } = await locked(() => snapshotLocked(request, performance.now() + timeoutMs));
				return { kind: "taken", record, reused, durationMs: elapsed() };
			} catch (error) {
				return { kind: "unavailable", reason: errorText(error), durationMs: elapsed() };
			}
		},
		list() {
			if (idProblem !== null) return [];
			return [...(readLog(dir)?.snapshots ?? [])].reverse();
		},
		async differences() {
			if (idProblem !== null) return { kind: "unavailable", reason: idProblem };
			try {
				return await locked(async () => {
					const records = readLog(dir)?.snapshots ?? [];
					if (records.length === 0) return { kind: "counts" as const, counts: new Map<number, number>() };
					const deadline = performance.now() + timeoutMs;
					const repo = await resolveRepository(cwd, deadline);
					const current = (await stageWorkspace(repo, deadline)).tree;
					const out = await runGit(["diff-tree", "--stdin", "-r", "-z", "--no-renames"], {
						cwd: repo.root,
						deadline,
						input: records.map((record) => `${record.tree} ${current}\n`).join(""),
					});
					const counts = new Map<number, number>(records.map((record) => [record.n, 0]));
					for (const entry of parseRawDiff(out.stdout)) {
						const record = records[entry.pair];
						if (record === undefined || entry.fromMode === GITLINK_MODE || entry.toMode === GITLINK_MODE) continue;
						counts.set(record.n, (counts.get(record.n) ?? 0) + 1);
					}
					return { kind: "counts" as const, counts };
				});
			} catch (error) {
				return { kind: "unavailable", reason: errorText(error) };
			}
		},
		async preview(n) {
			if (idProblem !== null) return { kind: "unavailable", reason: idProblem };
			try {
				return await locked(async () => {
					const target = findRecord(n);
					const deadline = performance.now() + timeoutMs;
					const repo = await resolveRepository(cwd, deadline);
					const current = (await stageWorkspace(repo, deadline)).tree;
					return { kind: "plan" as const, plan: await planRewind(repo, target, current, deadline) };
				});
			} catch (error) {
				return { kind: "unavailable", reason: errorText(error) };
			}
		},
		async restore(n) {
			if (idProblem !== null) return { kind: "unavailable", reason: idProblem };
			try {
				return await locked(() => restoreLocked(n));
			} catch (error) {
				return { kind: "unavailable", reason: errorText(error) };
			}
		},
	};
}

export interface PruneWorkspaceSnapshotsOptions {
	stateDir: string;
	/** The current workspace; orphaned snapshot refs in its repository are pruned too. */
	cwd: string;
	/** Never pruned, whatever its age: the session that is starting. */
	keepSessionId?: string;
	now?: number;
	maxAgeMs?: number;
}

/**
 * Drop snapshot refs and state of sessions idle longer than 14 days. Refs are
 * removed from the repository each session recorded; refs in the current
 * repository whose session state is already gone go by their commit date.
 * Unreferenced objects are left for `git gc`. Best effort throughout.
 */
export async function pruneWorkspaceSnapshots(
	options: PruneWorkspaceSnapshotsOptions,
): Promise<{ sessions: number; refs: number }> {
	const now = options.now ?? Date.now();
	const cutoff = now - (options.maxAgeMs ?? SNAPSHOT_MAX_AGE_MS);
	const deadline = performance.now() + SNAPSHOT_TIMEOUT_MS;
	const root = snapshotsRoot(options.stateDir);
	let sessions = 0;
	let refs = 0;
	let entries: string[] = [];
	try {
		entries = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		// No snapshot state yet.
	}
	for (const name of entries) {
		if (name === options.keepSessionId) continue;
		const dir = path.join(root, name);
		const log = readLog(dir);
		let touched = log === null ? Number.NaN : Date.parse(log.updatedAt);
		if (Number.isNaN(touched)) {
			try {
				touched = statSync(dir).mtimeMs;
			} catch {
				continue;
			}
		}
		if (touched >= cutoff) continue;
		await withSessionLock(dir, async () => {
			if (log !== null && sessionIdProblem(name) === null && existsSync(log.commonDir)) {
				try {
					const stale = await sessionRefs(log.commonDir, name, deadline, log.commonDir);
					await deleteRefs(log.commonDir, stale, deadline, log.commonDir);
					refs += stale.length;
				} catch {
					// The repository moved or Git failed; the state still goes.
				}
			}
			rmSync(dir, { recursive: true, force: true });
			sessions += 1;
		});
	}
	try {
		const repo = await resolveRepository(options.cwd, deadline);
		const out = await runGit(["for-each-ref", "--format=%(refname) %(committerdate:unix)", `${SNAPSHOT_REF_PREFIX}/`], {
			cwd: repo.root,
			deadline,
		});
		const stale: string[] = [];
		for (const line of lines(out.stdout)) {
			const [ref = "", epoch = ""] = line.split(" ");
			const session = ref.slice(SNAPSHOT_REF_PREFIX.length + 1).split("/")[0] ?? "";
			if (session.length === 0 || session === options.keepSessionId) continue;
			if (existsSync(path.join(root, session))) continue;
			if (Number(epoch) * 1000 < cutoff) stale.push(ref);
		}
		await deleteRefs(repo.root, stale, deadline);
		refs += stale.length;
	} catch {
		// Not a repository, or Git failed: nothing to prune there.
	}
	return { sessions, refs };
}
