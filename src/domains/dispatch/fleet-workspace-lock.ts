/**
 * One running fleet per workspace checkout, across every process.
 *
 * The TUI and ACP single-run guards are per process, so two GUI sessions, a
 * terminal beside `clio-coder fleet run`, or two terminals could each drive a
 * fleet in the same checkout, and a crashed root could be resumed while an
 * earlier resume of it still ran. Two executors then wrote steps into one tree.
 * `executeFleetRun` takes this lock first, so every entry point shares it.
 *
 * The record names its holder with the same pid and birth token the assignment
 * ledger uses, and liveness is `assignmentProcessOwnerAlive`, so a holder that
 * crashed or was killed is reclaimed instead of blocking the workspace forever.
 * Another host's process cannot be probed, so a held lease refreshes the
 * record's mtime and a foreign record left unrefreshed for the stale window is
 * reclaimed as a crash on a shared home. The record lives in this user's state
 * directory, so a lock never crosses user accounts.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, rmSync, statSync, utimesSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { processBirthToken } from "../../core/process-identity.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { StateFileLockTimeoutError, withStateFileLock, withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import { gitCheckoutRoot } from "../../tools/task-worktree.js";
import {
	type AssignmentProcessOwner,
	type AssignmentProcessOwnerProbe,
	assignmentProcessOwnerAlive,
} from "./assignment-store.js";

interface FleetWorkspaceLockRecord {
	version: 1;
	workspaceRoot: string;
	rootId: string;
	host: string;
	processOwner: AssignmentProcessOwner;
}

export interface FleetWorkspaceLockHolder {
	rootId: string;
	workspaceRoot: string;
	host: string;
	pid: number;
	acquiredAt: string;
}

/** How often a held lease refreshes its record's mtime. */
const FLEET_LOCK_REFRESH_MS = 30_000;
/** A foreign host's record unrefreshed this long belongs to a fleet that is gone. */
const FLEET_LOCK_STALE_MS = 5 * FLEET_LOCK_REFRESH_MS;
/**
 * Release retries and the exit hook wait this long per path for the state-file
 * lock instead of the 20 s default, so a stuck lock cannot stall process exit or
 * the next acquisition; a missed retry is picked up by the next one.
 */
const FLEET_LOCK_CLEANUP_TIMEOUT_MS = 1_000;

/** A second fleet refused because a live one holds the workspace. */
export class FleetWorkspaceBusyError extends Error {
	readonly holder: FleetWorkspaceLockHolder;
	readonly lockPath: string;
	constructor(holder: FleetWorkspaceLockHolder, lockPath: string) {
		const local = holder.host === hostname();
		const owner = local ? `pid ${holder.pid}` : `pid ${holder.pid} on ${holder.host}`;
		const remedy = local
			? "wait for it to finish"
			: `wait for it to finish; if it is gone, the lock is reclaimed ${FLEET_LOCK_STALE_MS / 1000} s after its last refresh, or remove ${lockPath} once ${holder.host} runs no fleet there`;
		super(
			`fleet root=${holder.rootId} (${owner}, since ${holder.acquiredAt}) is still running in ${holder.workspaceRoot}; this run was refused and nothing was dispatched. Lock: ${lockPath}; ${remedy}`,
		);
		this.name = "FleetWorkspaceBusyError";
		this.holder = holder;
		this.lockPath = lockPath;
	}
}

/**
 * A run refused because the workspace lock could not be judged: its record is
 * unreadable or its state-file lock stayed held. Either may hide a live fleet,
 * so the run is refused rather than failed.
 */
export class FleetWorkspaceLockUnavailableError extends Error {
	constructor(message: string) {
		super(`${message}; this run was refused and nothing was dispatched`);
		this.name = "FleetWorkspaceLockUnavailableError";
	}
}

export interface FleetWorkspaceLease {
	release(): Promise<void>;
}

/**
 * The checkout a fleet runs in, keyed the way the checkout writer lease keys it.
 * A TUI started in `repo/apps/gui` and a CLI started in `repo/` drive the same
 * tree, so both resolve to the git top level; each linked worktree keeps its own.
 */
function canonicalRoot(path: string): string {
	const checkout = gitCheckoutRoot(path);
	if (checkout !== null) return checkout;
	try {
		return realpathSync(path);
	} catch {
		// A root that cannot be resolved still keys honestly by its absolute spelling.
		return resolve(path);
	}
}

function lockPathForRoot(root: string): string {
	const digest = createHash("sha256").update(root).digest("hex").slice(0, 32);
	return join(clioStateDir(), "fleet-locks", `${digest}.json`);
}

export function fleetWorkspaceLockPath(workspaceRoot: string): string {
	return lockPathForRoot(canonicalRoot(workspaceRoot));
}

function validRecord(value: unknown): value is FleetWorkspaceLockRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<FleetWorkspaceLockRecord>;
	const owner = record.processOwner;
	return (
		record.version === 1 &&
		typeof record.rootId === "string" &&
		typeof record.workspaceRoot === "string" &&
		typeof record.host === "string" &&
		typeof owner?.pid === "number" &&
		typeof owner.processBirthToken === "string" &&
		typeof owner.acquiredAt === "string"
	);
}

/**
 * Only a missing file means the workspace is free. A record this build cannot
 * read may name a live fleet from a newer build, so it refuses instead of
 * being overwritten.
 */
function readRecord(path: string): FleetWorkspaceLockRecord | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new FleetWorkspaceLockUnavailableError(
			`fleet workspace lock is unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		const value = JSON.parse(raw) as unknown;
		if (!validRecord(value)) throw new Error("invalid schema");
		return value;
	} catch (error) {
		throw new FleetWorkspaceLockUnavailableError(
			`fleet workspace lock is unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}; remove it once no fleet runs in that checkout`,
		);
	}
}

/** Lock path to the rootId this process holds there through a lease that has not been released. */
const liveLeases = new Map<string, string>();
/** Lock path to the rootId whose release failed, retried on a timer, at the next acquisition and at exit. */
const failedReleases = new Map<string, string>();
let releaseRetryTimer: NodeJS.Timeout | null = null;
let exitHookInstalled = false;

/**
 * Pid and birth token, plus this host or a rootId this process holds at that
 * path. The host name can change under a running process (macOS renames on
 * network switches), and a refresh gated on it alone would stop, so another
 * local process would read the record as foreign and reclaim it. Pid and token
 * alone are not enough either: another host sharing this home can carry the
 * same pair (macOS falls back to `pid-<n>`), and its live record must never be
 * reclaimed or deleted as ours.
 */
function ownedByThisProcess(record: FleetWorkspaceLockRecord, path: string, token: string): boolean {
	if (record.processOwner.pid !== process.pid || record.processOwner.processBirthToken !== token) return false;
	return (
		record.host === hostname() || liveLeases.get(path) === record.rootId || failedReleases.get(path) === record.rootId
	);
}

function holderAlive(
	record: FleetWorkspaceLockRecord,
	path: string,
	token: string,
	probe: AssignmentProcessOwnerProbe | undefined,
): boolean {
	// Our own record with no live lease behind it is a release that failed. A
	// long-lived TUI would otherwise refuse every fleet here until it exits.
	if (ownedByThisProcess(record, path, token)) return liveLeases.has(path);
	// Another host's process cannot be probed from here, so only the holder's
	// refresh of the record's mtime shows it still runs.
	if (record.host !== hostname()) return Date.now() - statSync(path).mtimeMs < FLEET_LOCK_STALE_MS;
	return probe === undefined ? assignmentProcessOwnerAlive(record) : assignmentProcessOwnerAlive(record, probe);
}

function removeOwnRecord(path: string, rootId: string): void {
	const current = readRecord(path);
	// Only our own claim is removed. A reclaim by another process after ours
	// was judged dead must never be deleted from under it.
	if (current?.rootId !== rootId || current.processOwner.pid !== process.pid) return;
	rmSync(path, { force: true });
}

/** Show other hosts this lease is still held. A record another process reclaimed is left alone. */
function refreshOwnRecord(path: string, rootId: string, token: string): void {
	try {
		const current = readRecord(path);
		if (current?.rootId !== rootId || !ownedByThisProcess(current, path, token)) return;
		const now = new Date();
		utimesSync(path, now, now);
	} catch {
		// A missed refresh is retried next period; the stale window spans several.
	}
}

async function retryFailedReleases(token: string): Promise<void> {
	for (const [path, rootId] of [...failedReleases]) {
		// The entry stays until the attempt ends, because ownership of a record
		// another host may have written is judged against it.
		try {
			await withStateFileLock(
				path,
				() => {
					const current = readRecord(path);
					if (current !== null && ownedByThisProcess(current, path, token) && !liveLeases.has(path)) {
						removeOwnRecord(path, current.rootId);
					}
				},
				{ timeoutMs: FLEET_LOCK_CLEANUP_TIMEOUT_MS },
			);
			if (failedReleases.get(path) === rootId) failedReleases.delete(path);
		} catch {
			// The entry is kept; the next retry, acquisition or the exit hook tries again.
			scheduleReleaseRetry(token);
		}
	}
}

/** Unref'd, so a stuck record never keeps the process alive; the exit hook gets the last try. */
function scheduleReleaseRetry(token: string): void {
	if (releaseRetryTimer !== null) return;
	releaseRetryTimer = setTimeout(() => {
		releaseRetryTimer = null;
		void retryFailedReleases(token);
	}, FLEET_LOCK_REFRESH_MS);
	releaseRetryTimer.unref();
}

function releaseAllOnExit(token: string): void {
	for (const path of new Set([...liveLeases.keys(), ...failedReleases.keys()])) {
		try {
			withStateFileLockSync(
				path,
				() => {
					const current = readRecord(path);
					if (current !== null && ownedByThisProcess(current, path, token)) rmSync(path, { force: true });
				},
				{ timeoutMs: FLEET_LOCK_CLEANUP_TIMEOUT_MS },
			);
		} catch {
			// Process exit is best effort. A record naming this dead process is reclaimed by the next fleet.
		}
	}
	liveLeases.clear();
	failedReleases.clear();
}

function installExitHook(token: string): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => releaseAllOnExit(token));
}

/**
 * Claim the workspace for `rootId`, or throw `FleetWorkspaceBusyError` naming
 * the live holder. A record whose owner is gone is overwritten.
 */
export async function acquireFleetWorkspaceLock(
	input: { workspaceRoot: string; rootId: string },
	probe?: AssignmentProcessOwnerProbe,
): Promise<FleetWorkspaceLease> {
	const workspaceRoot = canonicalRoot(input.workspaceRoot);
	const path = lockPathForRoot(workspaceRoot);
	const token = processBirthToken();
	if (token === null) throw new Error("fleet: cannot establish this process's birth token for the workspace lock");
	const record: FleetWorkspaceLockRecord = {
		version: 1,
		workspaceRoot,
		rootId: input.rootId,
		host: hostname(),
		processOwner: { pid: process.pid, processBirthToken: token, acquiredAt: new Date().toISOString() },
	};
	await retryFailedReleases(token);
	await withStateFileLock(path, () => {
		const current = readRecord(path);
		if (current !== null && holderAlive(current, path, token, probe)) {
			throw new FleetWorkspaceBusyError(
				{
					rootId: current.rootId,
					workspaceRoot: current.workspaceRoot,
					host: current.host,
					pid: current.processOwner.pid,
					acquiredAt: current.processOwner.acquiredAt,
				},
				path,
			);
		}
		safeResourceWrite(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
		liveLeases.set(path, input.rootId);
	}).catch((error: unknown) => {
		if (error instanceof StateFileLockTimeoutError) {
			throw new FleetWorkspaceLockUnavailableError(`fleet workspace lock is held by another process: ${error.message}`);
		}
		throw error;
	});
	installExitHook(token);
	const refresh = setInterval(() => refreshOwnRecord(path, record.rootId, token), FLEET_LOCK_REFRESH_MS);
	refresh.unref();
	return {
		release: async () => {
			clearInterval(refresh);
			liveLeases.delete(path);
			try {
				await withStateFileLock(path, () => removeOwnRecord(path, record.rootId));
			} catch (error) {
				failedReleases.set(path, record.rootId);
				scheduleReleaseRetry(token);
				throw error;
			}
		},
	};
}
