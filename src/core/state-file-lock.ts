import {
	closeSync,
	type Dirent,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { ownerIdentity, ownerIsThisProcess, ownerState } from "./process-identity.js";

/**
 * The one cross-process advisory file lock. Every durable lock in the tree runs
 * through it (settings.yaml, the dispatch admission state file,
 * credentials.yaml, residency mutations) so there is a single staleness policy
 * instead of four that disagreed by a factor of 26.
 *
 * The lock is keyed by target path (`<target>.lock`) and records the owner's
 * host, pid, birth token, pid namespace and boot id. A holder is presumed gone
 * only when its pid is gone on this host; a record from another host is never
 * adjudicated here, and one from another pid namespace (an Apptainer container,
 * or the host seen from inside one) is never judged by a local pid. The age of
 * the lockfile decides only for a record whose owner cannot be read or probed, so
 * staleness is a backstop rather than a cap on how long a critical section may
 * legitimately take: the settings lock used to steal itself back from a healthy
 * writer after five seconds. Async holders additionally refresh the lockfile mtime while
 * they work, so even the backstop does not fire under a live holder. The sync
 * path blocks the event loop by construction and cannot run that timer; pid
 * liveness is what protects it.
 */

/** Consulted only when the owner cannot be identified. */
const STALE_LOCK_MS = 30_000;
/** Well under STALE_LOCK_MS, so a slow holder never reads as an abandoned one. */
const REFRESH_LOCK_MS = 5_000;
/**
 * Default acquisition budget. Deliberately under DEFAULT_CAPACITY_LEASE_TTL_MS:
 * the sync path blocks the event loop, so a process waiting here also stalls its
 * own lease heartbeat, and a wait longer than a lease lives would let a live
 * holder's lease expire under it. capacity-lease.ts asserts the relation.
 */
export const FILE_LOCK_ACQUIRE_TIMEOUT_MS = 20_000;

export interface StateFileLockOptions {
	/** Acquisition budget. Default `FILE_LOCK_ACQUIRE_TIMEOUT_MS`. */
	timeoutMs?: number;
	/** Cancel an asynchronous lock wait and never enter or commit its critical section. */
	signal?: AbortSignal;
	/**
	 * `run-unlocked` runs `fn` anyway when the lock cannot be taken. Residency
	 * mutations need it: serializing them is an optimization and must never fail
	 * or stall a turn. Everything else fails closed.
	 */
	onAcquireFailure?: "throw" | "run-unlocked";
	/**
	 * Reclaim a lock held on another host once its mtime is this old. Only for locks every holder takes through the
	 * asynchronous path, which refreshes the mtime every few seconds, so the age is the holder's lease expiry. Without
	 * it a foreign holder is never adjudicated.
	 */
	foreignExpiresMs?: number;
	/** What this holder is doing, recorded in the lock so a waiter can say who it waits for. */
	note?: string;
	/** An asynchronous wait found another holder, or the holder changed; null when its record cannot be read. */
	onContended?: (holder: StateFileLockHolder | null) => void;
}

interface LockOwner {
	/** Null on a record written before the field existed; read as this host. */
	host: string | null;
	pid: number;
	birthToken: string | null;
	pidNs: string | null;
	bootId: string | null;
	note?: string;
}

/** Who holds a lock, as its record states. A null `host` is this machine. */
export interface StateFileLockHolder {
	pid: number;
	host: string | null;
	self: boolean;
	note: string | null;
}

function lockHolder(lockPath: string): StateFileLockHolder | null {
	const owner = readLockOwner(lockPath);
	if (owner === null) return null;
	const foreign = owner.host !== null && owner.host !== hostname();
	return {
		pid: owner.pid,
		host: foreign ? owner.host : null,
		self: ownerIsThisProcess(owner),
		note: owner.note ?? null,
	};
}

function readLockOwner(lockPath: string): LockOwner | null {
	try {
		const raw = readFileSync(lockPath, "utf8").trim();
		const record = raw.startsWith("{") ? (JSON.parse(raw) as Record<string, unknown>) : { pid: Number.parseInt(raw, 10) };
		const { host, pid, birthToken, pidNs, bootId, note } = record;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
		return {
			host: typeof host === "string" ? host : null,
			pid,
			birthToken: typeof birthToken === "string" ? birthToken : null,
			pidNs: typeof pidNs === "string" ? pidNs : null,
			bootId: typeof bootId === "string" ? bootId : null,
			...(typeof note === "string" ? { note } : {}),
		};
	} catch {
		return null;
	}
}

function lockfileAgeMs(lockPath: string): number | null {
	try {
		return Date.now() - statSync(lockPath).mtimeMs;
	} catch {
		return null;
	}
}

/** Create the lock file exclusively; false when it already exists. */
function createLock(lockPath: string, note?: string): boolean {
	try {
		const fd = openSync(lockPath, "wx", 0o600);
		try {
			writeSync(
				fd,
				`${JSON.stringify({ ...ownerIdentity(), at: new Date().toISOString(), ...(note !== undefined ? { note } : {}) })}\n`,
			);
		} catch (err) {
			// A failed write (ENOSPC, EDQUOT) would leave an ownerless empty lock that blocks every waiter until it ages out.
			closeSync(fd);
			removeLockFile(lockPath);
			throw err;
		}
		closeSync(fd);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		return false;
	}
}

function lockIsAbandoned(lockPath: string, foreignExpiresMs?: number): boolean {
	const owner = readLockOwner(lockPath);
	if (owner !== null && foreignExpiresMs !== undefined && owner.host !== null && owner.host !== hostname()) {
		const ageMs = lockfileAgeMs(lockPath);
		return ageMs !== null && ageMs > foreignExpiresMs;
	}
	const state = owner === null ? "unknown" : ownerState(owner);
	if (state !== "unknown") return state === "gone";
	// Another host without an opted-in lease is never adjudicated.
	if (owner !== null && owner.host !== null && owner.host !== hostname()) return false;
	// An unreadable record, or this host's record from a pid namespace not visible here (a container that has exited,
	// or the host seen from inside one): the age backstop, which an async holder's refresh keeps from firing.
	const ageMs = lockfileAgeMs(lockPath);
	return ageMs !== null && ageMs > (owner === null ? STALE_LOCK_MS : (foreignExpiresMs ?? STALE_LOCK_MS));
}

/** Whether a lock's recorded owner is provably gone, the same test a stale takeover uses. */
export function stateLockIsAbandoned(lockPath: string): boolean {
	return lockIsAbandoned(lockPath);
}

/** Remove a lock whose owner is provably gone, under the same reclaim guard a waiter uses. */
export function clearAbandonedStateLock(lockPath: string): void {
	if (lockIsAbandoned(lockPath)) reclaimAbandonedLock(lockPath);
}

function removeLockFile(lockPath: string): void {
	try {
		unlinkSync(lockPath);
	} catch {
		// Already gone, which is the state the caller wanted.
	}
}

/**
 * Remove an abandoned lock under an exclusive reclaim guard. POSIX has no conditional unlink, so a waiter acting on an
 * earlier read of the dead owner would delete the fresh lock another waiter just took. Inside the guard the only other
 * deleter of this file is its owner, and the re-read proves that owner gone, so the file cannot change before the
 * unlink. The guard is held for a few synchronous syscalls. A guard left by a holder that died in that window is itself
 * reclaimed by owner, and two waiters racing that recovery in the same instant is an accepted double fault.
 */
function reclaimAbandonedLock(lockPath: string, foreignExpiresMs?: number): boolean {
	// Ends in .lock so a forced release of a dead owner's locks also clears a guard it left (#439).
	const guardPath = `${lockPath}.reclaim.lock`;
	if (!createLock(guardPath)) {
		if (!lockIsAbandoned(guardPath)) return false;
		removeLockFile(guardPath);
		if (!createLock(guardPath)) return false;
	}
	try {
		if (lockIsAbandoned(lockPath, foreignExpiresMs)) removeLockFile(lockPath);
	} finally {
		removeLockFile(guardPath);
	}
	return true;
}

/** True once the lock is ours. Steals only from an owner that is provably gone. */
function tryAcquire(lockPath: string, note?: string, foreignExpiresMs?: number): boolean {
	if (createLock(lockPath, note)) return true;
	if (!lockIsAbandoned(lockPath, foreignExpiresMs) || !reclaimAbandonedLock(lockPath, foreignExpiresMs)) return false;
	// Acquire in the same attempt as the reclaim: a caller with no wait budget, such as a recovery writer, would
	// otherwise reclaim a dead owner's lock and still give up (#434).
	return createLock(lockPath, note);
}

/** The acquisition budget ran out while another holder kept the lock. Callers that refuse on it can tell it from a failure. */
export class StateFileLockTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StateFileLockTimeoutError";
	}
}

function timeoutError(lockPath: string, timeoutMs: number): Error {
	return new StateFileLockTimeoutError(
		`timed out after ${timeoutMs}ms waiting for ${lockPath} (owner pid=${readLockOwner(lockPath)?.pid ?? "?"}); delete it if no other clio-coder process is running`,
	);
}

function backoffMs(attempt: number): number {
	return Math.min(100, 5 * 2 ** Math.min(attempt, 5));
}

function release(lockPath: string): void {
	// Only unlink a lock we still own. If ours was reclaimed as abandoned and a
	// sibling now holds a fresh one, deleting here would open their section.
	const owner = readLockOwner(lockPath);
	if (owner === null || !ownerIsThisProcess(owner)) return;
	try {
		unlinkSync(lockPath);
	} catch {
		// Already gone; fine.
	}
}

/**
 * Keep a held lock's mtime current so the staleness backstop cannot fire under
 * a live holder. Only the async path can do this; see the module comment.
 */
function startRefresh(lockPath: string): () => void {
	const timer = setInterval(() => {
		const at = new Date();
		try {
			utimesSync(lockPath, at, at);
		} catch {
			// Released or stolen; `release` re-checks ownership either way.
		}
	}, REFRESH_LOCK_MS);
	timer.unref();
	return () => clearInterval(timer);
}

/** Synchronous variant for admission planners whose host API cannot yield. */
export function withStateFileLockSync<T>(targetPath: string, fn: () => T, options: StateFileLockOptions = {}): T {
	const lockPath = `${targetPath}.lock`;
	const timeoutMs = options.timeoutMs ?? FILE_LOCK_ACQUIRE_TIMEOUT_MS;
	let held = false;
	try {
		options.signal?.throwIfAborted();
		mkdirSync(dirname(lockPath), { recursive: true });
		const deadlineMs = performance.now() + timeoutMs;
		for (let attempt = 1; !tryAcquire(lockPath); attempt += 1) {
			options.signal?.throwIfAborted();
			if (performance.now() > deadlineMs) throw timeoutError(lockPath, timeoutMs);
			// Atomics.wait rather than a timer: the callers of this variant are
			// inside host APIs that cannot yield.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs(attempt));
		}
		held = true;
	} catch (err) {
		options.signal?.throwIfAborted();
		if (options.onAcquireFailure !== "run-unlocked") throw err;
	}
	try {
		return fn();
	} finally {
		if (held) release(lockPath);
	}
}

/**
 * Run `fn` under the lock only if the lock is free right now; never waits and
 * never blocks. A caller with an asynchronous fallback keeps its uncontended
 * path synchronous with this, and waits through `withStateFileLockSection`
 * only when another holder is present.
 */
export function tryWithStateFileLockSync<T>(
	targetPath: string,
	fn: () => T,
): { held: true; value: T } | { held: false } {
	const lockPath = `${targetPath}.lock`;
	mkdirSync(dirname(lockPath), { recursive: true });
	if (!tryAcquire(lockPath)) return { held: false };
	try {
		return { held: true, value: fn() };
	} finally {
		release(lockPath);
	}
}

/**
 * The asynchronous acquisition loop shared by both yielding variants. `enter`
 * runs in the same synchronous step that took the lock, so nothing else in
 * this process runs between acquisition and the critical section.
 */
async function acquireAsync<T>(
	lockPath: string,
	options: StateFileLockOptions,
	enter: (held: boolean) => T | Promise<T>,
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? FILE_LOCK_ACQUIRE_TIMEOUT_MS;
	let held = false;
	try {
		options.signal?.throwIfAborted();
		mkdirSync(dirname(lockPath), { recursive: true });
		const deadlineMs = performance.now() + timeoutMs;
		let reported: number | null | undefined;
		for (let attempt = 1; !tryAcquire(lockPath, options.note, options.foreignExpiresMs); attempt += 1) {
			options.signal?.throwIfAborted();
			if (performance.now() > deadlineMs) throw timeoutError(lockPath, timeoutMs);
			if (options.onContended) {
				const holder = lockHolder(lockPath);
				if ((holder?.pid ?? null) !== reported) {
					reported = holder?.pid ?? null;
					options.onContended(holder);
				}
			}
			const base = backoffMs(attempt);
			const delayMs = base + Math.floor(Math.random() * base);
			if (options.signal) await sleep(delayMs, undefined, { signal: options.signal });
			else await sleep(delayMs);
		}
		held = true;
		options.signal?.throwIfAborted();
	} catch (err) {
		// An abort that lands after a successful acquisition must hand the lock
		// back: the rethrow below skips the caller's release, and a live pid
		// keeps every other waiter out until this process exits.
		if (held) {
			release(lockPath);
			held = false;
		}
		options.signal?.throwIfAborted();
		if (options.onAcquireFailure !== "run-unlocked") throw err;
	}
	return enter(held);
}

export async function withStateFileLock<T>(
	targetPath: string,
	fn: () => T | Promise<T>,
	options: StateFileLockOptions = {},
): Promise<T> {
	const lockPath = `${targetPath}.lock`;
	return acquireAsync(lockPath, options, async (held) => {
		const stopRefresh = held ? startRefresh(lockPath) : null;
		try {
			return await fn();
		} finally {
			stopRefresh?.();
			if (held) release(lockPath);
		}
	});
}

/**
 * Wait for the lock without blocking the event loop, then run a synchronous
 * critical section and release before returning. `withStateFileLock` holds the
 * lock across at least one microtask after `fn` returns; a same-process
 * `withStateFileLockSync` caller reached in that gap would spin on its own pid
 * until the acquisition budget runs out. Admission paths that mix both
 * variants on one lock use this one.
 */
export function withStateFileLockSection<T>(
	targetPath: string,
	fn: () => T,
	options: StateFileLockOptions = {},
): Promise<T> {
	const lockPath = `${targetPath}.lock`;
	return acquireAsync(lockPath, options, (held) => {
		try {
			return fn();
		} finally {
			if (held) release(lockPath);
		}
	});
}

/** The owner triple a forced release matches; see `releaseStateLocksOwnedBy`. */
export interface StateLockOwner {
	host: string;
	pid: number;
	birth: string | null;
}

function lockFilesUnder(root: string, depth: number): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const found: string[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isFile() && entry.name.endsWith(".lock")) found.push(path);
		else if (entry.isDirectory() && depth > 0) found.push(...lockFilesUnder(path, depth - 1));
	}
	return found;
}

/**
 * Remove every `*.lock` under `root` (two directory levels deep) whose recorded
 * owner is exactly `owner`. `tryAcquire` never adjudicates a foreign host, so
 * a lock left by a dead owner on another node blocks forever; this is the
 * release `clio-coder session terminate --force` runs once that owner's session
 * heartbeat is stale (#439). A record without a host or birth token is never
 * matched: only the full triple identifies the dead process.
 */
export function releaseStateLocksOwnedBy(root: string, owner: StateLockOwner): string[] {
	if (owner.birth === null) return [];
	const released: string[] = [];
	for (const lockPath of lockFilesUnder(root, 2)) {
		const held = readLockOwner(lockPath);
		if (held?.host !== owner.host || held.pid !== owner.pid || held.birthToken !== owner.birth) continue;
		try {
			unlinkSync(lockPath);
			released.push(lockPath);
		} catch {
			// Already gone.
		}
	}
	return released;
}
