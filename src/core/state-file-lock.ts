import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { processAlive, processBirthToken } from "./process-identity.js";

/**
 * The one cross-process advisory file lock. Every durable lock in the tree runs
 * through it (settings.yaml, the dispatch admission state file,
 * credentials.yaml, residency mutations) so there is a single staleness policy
 * instead of four that disagreed by a factor of 26.
 *
 * The lock is keyed by target path (`<target>.lock`) and records the owner's
 * host, pid and birth token. A holder is presumed gone only when its pid is
 * gone on this host; a record from another host is never adjudicated here. The
 * age of the lockfile decides only for a record whose owner cannot be read, so
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
}

interface LockOwner {
	/** Null on a record written before the field existed; read as this host. */
	host: string | null;
	pid: number;
	birthToken: string | null;
}

function readLockOwner(lockPath: string): LockOwner | null {
	try {
		const raw = readFileSync(lockPath, "utf8").trim();
		const record = raw.startsWith("{") ? (JSON.parse(raw) as Record<string, unknown>) : { pid: Number.parseInt(raw, 10) };
		const { host, pid, birthToken } = record;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
		return {
			host: typeof host === "string" ? host : null,
			pid,
			birthToken: typeof birthToken === "string" ? birthToken : null,
		};
	} catch {
		return null;
	}
}

/** Mirrors compete-worktrees' ownerIsAlive: foreign hosts are never adjudicated, a null token cannot rule out pid reuse. */
function ownerIsAlive(owner: LockOwner): boolean {
	if (owner.host !== null && owner.host !== hostname()) return true;
	if (!processAlive(owner.pid)) return false;
	if (owner.birthToken === null) return true;
	const current = processBirthToken(owner.pid);
	return current === null || current === owner.birthToken;
}

function lockfileAgeMs(lockPath: string): number | null {
	try {
		return Date.now() - statSync(lockPath).mtimeMs;
	} catch {
		return null;
	}
}

/** True once the lock is ours. Steals only from an owner that is provably gone. */
function tryAcquire(lockPath: string): boolean {
	try {
		const fd = openSync(lockPath, "wx", 0o600);
		try {
			writeSync(
				fd,
				`${JSON.stringify({ host: hostname(), pid: process.pid, birthToken: processBirthToken(), at: new Date().toISOString() })}\n`,
			);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	const owner = readLockOwner(lockPath);
	const ageMs = lockfileAgeMs(lockPath);
	const abandoned = owner !== null ? !ownerIsAlive(owner) : ageMs !== null && ageMs > STALE_LOCK_MS;
	if (abandoned) {
		try {
			unlinkSync(lockPath);
		} catch {
			// Another waiter reclaimed it first; the next attempt races normally.
		}
	}
	return false;
}

function timeoutError(lockPath: string, timeoutMs: number): Error {
	return new Error(
		`timed out after ${timeoutMs}ms waiting for ${lockPath} (owner pid=${readLockOwner(lockPath)?.pid ?? "?"}); delete it if no other clio process is running`,
	);
}

function backoffMs(attempt: number): number {
	return Math.min(100, 5 * 2 ** Math.min(attempt, 5));
}

function release(lockPath: string): void {
	// Only unlink a lock we still own. If ours was reclaimed as abandoned and a
	// sibling now holds a fresh one, deleting here would open their section.
	const owner = readLockOwner(lockPath);
	if (owner?.pid !== process.pid || (owner.host !== null && owner.host !== hostname())) return;
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
		const deadlineMs = Date.now() + timeoutMs;
		for (let attempt = 1; !tryAcquire(lockPath); attempt += 1) {
			options.signal?.throwIfAborted();
			if (Date.now() > deadlineMs) throw timeoutError(lockPath, timeoutMs);
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

export async function withStateFileLock<T>(
	targetPath: string,
	fn: () => T | Promise<T>,
	options: StateFileLockOptions = {},
): Promise<T> {
	const lockPath = `${targetPath}.lock`;
	const timeoutMs = options.timeoutMs ?? FILE_LOCK_ACQUIRE_TIMEOUT_MS;
	let held = false;
	try {
		options.signal?.throwIfAborted();
		mkdirSync(dirname(lockPath), { recursive: true });
		const deadlineMs = Date.now() + timeoutMs;
		for (let attempt = 1; !tryAcquire(lockPath); attempt += 1) {
			options.signal?.throwIfAborted();
			if (Date.now() > deadlineMs) throw timeoutError(lockPath, timeoutMs);
			const base = backoffMs(attempt);
			const delayMs = base + Math.floor(Math.random() * base);
			if (options.signal) await sleep(delayMs, undefined, { signal: options.signal });
			else await sleep(delayMs);
		}
		held = true;
		options.signal?.throwIfAborted();
	} catch (err) {
		options.signal?.throwIfAborted();
		if (options.onAcquireFailure !== "run-unlocked") throw err;
	}
	const stopRefresh = held ? startRefresh(lockPath) : null;
	try {
		return await fn();
	} finally {
		stopRefresh?.();
		if (held) release(lockPath);
	}
}
