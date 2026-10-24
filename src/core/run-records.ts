import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { canonicalizePath } from "./path-canonical.js";

/**
 * Run records: the durable provenance a `run_script` execution leaves behind.
 *
 * Every run gets its own directory under the project-local `.clio-coder/runs/`
 * tree holding the complete stdout and stderr logs and a `run.json` manifest
 * that names the script (by path and content hash), the interpreter, the exact
 * argv, the working directory, the declared environment keys, the timing, the
 * outcome, and the declared input and output references with their observed
 * state before and after the run. The manifest is what a later reader needs to
 * say what ran and what it produced without trusting the model's summary.
 *
 * Declared inputs and outputs are provenance, not isolation. Recording that a
 * script declared `out/result.csv` does not stop it from writing anywhere else
 * the process may write; the safety policy and the operating system decide
 * that. The record only observes the declared paths so the result can say
 * which of them exist, changed, or never appeared.
 */

export const RUN_RECORDS_RELATIVE_DIR = ".clio-coder/runs";
export const RUN_MANIFEST_FILENAME = "run.json";
export const RUN_STDOUT_FILENAME = "stdout.log";
export const RUN_STDERR_FILENAME = "stderr.log";
export const RUN_MANIFEST_VERSION = 1;
/** Retention reads at most 64 KiB per manifest, in chunks of at most 8 KiB. */
export const RUN_SWEEP_MANIFEST_MAX_BYTES = 64 * 1024;

/** Regular files at or below this size get a content hash; larger ones record size and mtime with an explicit omission. */
export const RUN_FILE_HASH_MAX_BYTES = 64 * 1024 * 1024;
/** Bytes read per hashing step; the event loop turns between steps. */
export const RUN_FILE_HASH_CHUNK_BYTES = 1024 * 1024;

/** How many completed run directories the sweep keeps by default. */
export const RUN_RECORDS_DEFAULT_KEEP = 100;
/**
 * A run directory without a manifest is a run in flight, or one whose process
 * died before writing the manifest. It is left alone until it is this old,
 * which no run can reach while alive, and swept as a dead run after that.
 */
export const RUN_RECORDS_ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * How a run ended. `cleanup-incomplete` is a script that exited 0 while
 * processes it started were still present after SIGKILL and the bounded
 * wait; leaderExit keeps the process outcome and exitCode reports failure.
 */
export type RunOutcome =
	| "succeeded"
	| "failed"
	| "timed-out"
	| "aborted"
	| "spawn-failed"
	| "cleanup-incomplete"
	| "pipe-drain-incomplete";

export type RunOutputStatus = "created" | "modified" | "unchanged" | "absent";

/** Why a regular file's content hash is null. */
export type RunHashOmission = "too-large" | "cancelled" | "unreadable";

export interface RunFileRef {
	/** Workspace-relative path exactly as declared, normalized to forward slashes. */
	path: string;
	exists: boolean;
	bytes?: number;
	/**
	 * Content hash of a regular file, or null when the content was not
	 * observed; `hashOmitted` then says why. Absent for non-regular entries.
	 */
	sha256?: string | null;
	hashOmitted?: RunHashOmission;
	mtimeMs?: number;
}

export interface RunOutputRef extends RunFileRef {
	status: RunOutputStatus;
}

export interface RunManifest {
	version: typeof RUN_MANIFEST_VERSION;
	runId: string;
	tool: "run_script";
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	script: { path: string; realPath: string; sha256: string | null; hashOmitted?: RunHashOmission; bytes: number };
	interpreter: { name: string; resolvedPath: string; args: string[] };
	/** The complete vector that was spawned: interpreter path, interpreter args, script, script args. */
	argv: string[];
	/** Workspace-relative working directory. */
	cwd: string;
	/** Declared environment keys only; values are never written. Secret-shaped keys are listed again under redactedKeys. */
	env: { declaredKeys: string[]; redactedKeys: string[] };
	timeoutMs: number;
	outcome: RunOutcome;
	exitCode: number | null;
	/** Actual leader outcome before any runner-level failure changed the effective exit code. */
	leaderExit?: { code: number | null; signal: NodeJS.Signals | null } | null;
	signal: string | null;
	stdoutBytes: number;
	stderrBytes: number;
	logs: { stdout: string; stderr: string };
	inputs: RunFileRef[];
	outputs: RunOutputRef[];
	/**
	 * What the runner had to do about the script's process group after the
	 * script itself was gone: whether descendants outlived it and were
	 * signalled, and whether the bounded wait after SIGKILL gave up on them.
	 */
	cleanup: { descendantsCleaned: boolean; incomplete: boolean };
	pipeDrainIncomplete?: boolean;
	/** Present when the run ended without a process result: what stopped it. */
	failure?: string;
}

export interface RunRecordPaths {
	runId: string;
	dir: string;
	manifestPath: string;
	stdoutPath: string;
	stderrPath: string;
	/**
	 * The run directory as created: its realpath and inode. Later writes by
	 * path check it first, because the script runs between creation and the
	 * manifest write and can swap the directory for a link to anywhere.
	 */
	identity: { realDir: string; dev: number; ino: number };
}

const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/u;

function compactUtc(now: Date): string {
	return now
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d{3}Z$/u, "Z");
}

/** `<YYYYMMDDTHHMMSSZ>-<6 hex>`: readable and unique; ordering comes from the manifest, not the id. */
export function newRunId(now: Date = new Date()): string {
	return `${compactUtc(now)}-${randomBytes(3).toString("hex")}`;
}

export function isRunId(value: string): boolean {
	return RUN_ID_PATTERN.test(value);
}

export function runRecordsDir(workspaceRoot: string): string {
	return path.join(path.resolve(workspaceRoot), ...RUN_RECORDS_RELATIVE_DIR.split("/"));
}

type RecordsRootLanding = { inside: true; landed: string } | { inside: false; reason: string };

/**
 * Where the records root really lands, or why it may not be used. A
 * `.clio-coder` or `runs` symlink to a sibling directory would otherwise put
 * every log there and let retention delete that directory's oldest entries.
 * A root that cannot be canonicalized counts as outside, and so does a
 * workspace root that cannot be resolved.
 */
function landRunRecordsRoot(workspaceRoot: string): RecordsRootLanding {
	const records = runRecordsDir(workspaceRoot);
	const outside = (landed: string): RecordsRootLanding => ({
		inside: false,
		reason: `${RUN_RECORDS_RELATIVE_DIR} resolves outside the workspace root (${landed})`,
	});
	let realRoot: string;
	try {
		realRoot = path.resolve(realpathSync(workspaceRoot));
	} catch {
		return outside(records);
	}
	const landed = canonicalizePath(records);
	if (landed === null) return outside(records);
	const relative = path.relative(realRoot, landed);
	if (relative === "") {
		return { inside: false, reason: `${RUN_RECORDS_RELATIVE_DIR} resolves to the workspace root itself (${landed})` };
	}
	if (relative.startsWith("..") || path.isAbsolute(relative)) return outside(landed);
	return { inside: true, landed };
}

/**
 * Create the run directory. The id is fresh, so an existing directory is a
 * collision and an error, and so is a records root outside the workspace.
 */
export function createRunRecord(workspaceRoot: string, runId: string = newRunId()): RunRecordPaths {
	const landing = landRunRecordsRoot(workspaceRoot);
	if (!landing.inside) throw new Error(`${landing.reason}; no record written`);
	const dir = path.join(runRecordsDir(workspaceRoot), runId);
	if (existsSync(dir)) throw new Error(`run record already exists: ${dir}`);
	mkdirSync(dir, { recursive: true });
	const realDir = path.resolve(realpathSync(dir));
	const stat = lstatSync(dir);
	if (realDir !== path.join(landing.landed, runId) || !stat.isDirectory()) {
		throw new Error(`run record moved while it was created: ${dir} -> ${realDir}; no record written`);
	}
	return {
		runId,
		dir,
		manifestPath: path.join(dir, RUN_MANIFEST_FILENAME),
		stdoutPath: path.join(dir, RUN_STDOUT_FILENAME),
		stderrPath: path.join(dir, RUN_STDERR_FILENAME),
		identity: { realDir, dev: stat.dev, ino: stat.ino },
	};
}

/**
 * Refuse a write by path into a run directory that is no longer the one
 * createRunRecord made: replaced by a link, moved, or swapped for another
 * directory. A script runs with the same file access as Clio, so it can do
 * any of these between creation and the manifest write.
 */
export function assertRunRecordIntact(paths: RunRecordPaths): void {
	let stat: ReturnType<typeof lstatSync>;
	let realDir: string;
	try {
		stat = lstatSync(paths.dir);
		realDir = path.resolve(realpathSync(paths.dir));
	} catch (error) {
		throw new Error(`run record is gone: ${paths.dir} (${error instanceof Error ? error.message : String(error)})`);
	}
	if (
		!stat.isDirectory() ||
		realDir !== paths.identity.realDir ||
		stat.dev !== paths.identity.dev ||
		stat.ino !== paths.identity.ino
	) {
		throw new Error(`run record was replaced: ${paths.dir} now resolves to ${realDir}; nothing written there`);
	}
}

/** Workspace-relative rendering with forward slashes, or null when the target sits outside the root. */
export function workspaceRelativePath(workspaceRoot: string, target: string): string | null {
	const root = path.resolve(workspaceRoot);
	const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
	const relative = path.relative(root, absolute);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return relative.length === 0 ? "." : relative.split(path.sep).join("/");
}

export interface HashFileOptions {
	/** Checked between reads; an abort stops the scan with an error named `AbortError`. */
	signal?: AbortSignal | undefined;
	chunkBytes?: number | undefined;
}

function abortError(signal: AbortSignal): Error {
	const error = new Error("file hashing cancelled", { cause: signal.reason });
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/**
 * Streaming sha256 of one regular file with bounded asynchronous reads: one
 * chunk lives in memory, the event loop turns between chunks, and the abort
 * signal is honored between them.
 */
export async function hashFile(filePath: string, options: HashFileOptions = {}): Promise<string> {
	const signal = options.signal;
	if (signal?.aborted) throw abortError(signal);
	const chunkBytes = Math.max(4096, Math.floor(options.chunkBytes ?? RUN_FILE_HASH_CHUNK_BYTES));
	const hash = createHash("sha256");
	const handle = await open(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(chunkBytes);
		for (;;) {
			if (signal?.aborted) throw abortError(signal);
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
		}
	} finally {
		await handle.close();
	}
	return hash.digest("hex");
}

export interface HashObservation {
	sha256: string | null;
	hashOmitted?: RunHashOmission;
}

/**
 * Hash a regular file of known size for a manifest, or say why not: files
 * above the ceiling are not read at all, a cancelled scan stops where it is,
 * and a file that vanished or became unreadable keeps its stat facts.
 */
export async function observeFileHash(filePath: string, bytes: number, signal?: AbortSignal): Promise<HashObservation> {
	if (bytes > RUN_FILE_HASH_MAX_BYTES) return { sha256: null, hashOmitted: "too-large" };
	if (signal?.aborted) return { sha256: null, hashOmitted: "cancelled" };
	try {
		return { sha256: await hashFile(filePath, { signal }) };
	} catch (error) {
		return { sha256: null, hashOmitted: isAbortError(error) ? "cancelled" : "unreadable" };
	}
}

export interface CaptureOptions {
	signal?: AbortSignal | undefined;
}

/**
 * Observe one declared path. A missing path is a fact (`exists: false`), not
 * an error: a declared output that never appeared is exactly what the record
 * exists to report. Directories and other non-regular entries record
 * existence and mtime without a size or hash.
 */
export async function captureFileRef(
	workspaceRoot: string,
	declaredPath: string,
	options: CaptureOptions = {},
): Promise<RunFileRef> {
	const relative = workspaceRelativePath(workspaceRoot, declaredPath);
	const rendered = relative ?? declaredPath.split(path.sep).join("/");
	const absolute = path.resolve(workspaceRoot, declaredPath);
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(absolute);
	} catch {
		return { path: rendered, exists: false };
	}
	if (!stat.isFile()) return { path: rendered, exists: true, mtimeMs: stat.mtimeMs };
	const observation = await observeFileHash(absolute, stat.size, options.signal);
	return { path: rendered, exists: true, bytes: stat.size, mtimeMs: stat.mtimeMs, ...observation };
}

/**
 * Observe a declared output after the run and classify it against the
 * pre-run observation. Content hashes decide when both sides have one;
 * otherwise size and mtime do. A path that existed before and is gone now is
 * `absent`, which the caller reports as such rather than as a success.
 */
export async function captureOutputRef(
	workspaceRoot: string,
	declaredPath: string,
	before: RunFileRef,
	options: CaptureOptions = {},
): Promise<RunOutputRef> {
	const after = await captureFileRef(workspaceRoot, declaredPath, options);
	if (!after.exists) return { ...after, status: "absent" };
	if (!before.exists) return { ...after, status: "created" };
	const unchanged =
		typeof before.sha256 === "string" && typeof after.sha256 === "string"
			? before.sha256 === after.sha256
			: before.bytes === after.bytes && before.mtimeMs === after.mtimeMs;
	return { ...after, status: unchanged ? "unchanged" : "modified" };
}

/** Write the manifest atomically: a temp file in the run directory, then a rename over the final name. */
export function writeRunManifest(paths: RunRecordPaths, manifest: RunManifest): void {
	assertRunRecordIntact(paths);
	const temp = path.join(paths.dir, `${RUN_MANIFEST_FILENAME}.${process.pid}.tmp`);
	writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	renameSync(temp, paths.manifestPath);
}

export interface RunRecordSweepResult {
	/** Completed run directories removed, oldest first. */
	removed: number;
	/** Completed run directories left in place. */
	kept: number;
	/** Run directories without a manifest that are young enough to be in flight; never touched. */
	active: number;
	/** Entries that could not be removed or were not run directories. */
	skipped: number;
}

/**
 * Completion time, null for a missing manifest, or undefined for an unsafe
 * entry to skip. Oversized, changed, or malformed regular files use mtime.
 * O_NONBLOCK prevents a swapped-in FIFO from blocking open; O_NOFOLLOW
 * rejects final-component symlinks where supported. fstat checks the actual
 * opened object before any bounded read, including its identity.
 */
function manifestCompletionMs(manifestPath: string): number | null | undefined {
	let before: ReturnType<typeof lstatSync>;
	try {
		before = lstatSync(manifestPath);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
	}
	if (!before.isFile()) return undefined;
	let fd: number | undefined;
	try {
		fd = openSync(manifestPath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) return undefined;
		if (stat.size > RUN_SWEEP_MANIFEST_MAX_BYTES) return stat.mtimeMs;
		const buffer = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < buffer.length) {
			const count = readSync(fd, buffer, offset, Math.min(8192, buffer.length - offset), offset);
			if (count === 0) break;
			offset += count;
		}
		const after = fstatSync(fd);
		if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || offset !== stat.size) return stat.mtimeMs;
		try {
			const parsed: unknown = JSON.parse(buffer.toString("utf8"));
			if (
				parsed !== null &&
				typeof parsed === "object" &&
				"finishedAt" in parsed &&
				typeof parsed.finishedAt === "string"
			) {
				const finished = Date.parse(parsed.finishedAt);
				if (Number.isFinite(finished)) return finished;
			}
		} catch {
			// Malformed metadata uses the opened regular file's mtime.
		}
		return stat.mtimeMs;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * Keep the newest `keep` completed run directories and remove the rest,
 * oldest first by the completion time their manifests record. A directory
 * without a manifest is a run in flight and is never removed while it could
 * still be one; entries that are not run directories are never touched.
 * A records root that resolves outside the workspace is never read or swept.
 */
export function sweepRunRecords(workspaceRoot: string, options: { keep?: number } = {}): RunRecordSweepResult {
	const keep = Math.max(0, Math.floor(options.keep ?? RUN_RECORDS_DEFAULT_KEEP));
	const landing = landRunRecordsRoot(workspaceRoot);
	if (!landing.inside) return { removed: 0, kept: 0, active: 0, skipped: 0 };
	const root = runRecordsDir(workspaceRoot);
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return { removed: 0, kept: 0, active: 0, skipped: 0 };
	}
	const now = Date.now();
	let skipped = 0;
	let active = 0;
	const completed: Array<{ entry: string; finishedMs: number }> = [];
	for (const entry of entries) {
		if (!isRunId(entry)) {
			skipped += 1;
			continue;
		}
		const dir = path.join(root, entry);
		let dirStat: ReturnType<typeof statSync>;
		try {
			dirStat = lstatSync(dir);
		} catch {
			skipped += 1;
			continue;
		}
		if (!dirStat.isDirectory()) {
			skipped += 1;
			continue;
		}
		const finishedMs = manifestCompletionMs(path.join(dir, RUN_MANIFEST_FILENAME));
		if (finishedMs === undefined) {
			skipped += 1;
			continue;
		}
		if (finishedMs !== null) {
			completed.push({ entry, finishedMs });
			continue;
		}
		if (now - dirStat.mtimeMs < RUN_RECORDS_ORPHAN_AFTER_MS) {
			active += 1;
			continue;
		}
		// Older than any run can be while alive: a dead run, ordered by when it started.
		completed.push({ entry, finishedMs: dirStat.mtimeMs });
	}
	completed.sort((a, b) => a.finishedMs - b.finishedMs || a.entry.localeCompare(b.entry));
	const excess = Math.max(0, completed.length - keep);
	// The scan took time and removal reopens by path: a root relinked since
	// the check is left alone rather than swept wherever it points now.
	if (excess > 0 && canonicalizePath(root) !== landing.landed) {
		return { removed: 0, kept: completed.length, active, skipped: skipped + excess };
	}
	let removed = 0;
	for (const { entry } of completed.slice(0, excess)) {
		try {
			rmSync(path.join(root, entry), { recursive: true, force: true });
			removed += 1;
		} catch {
			skipped += 1;
		}
	}
	return { removed, kept: completed.length - removed, active, skipped };
}
