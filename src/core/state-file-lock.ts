import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Cross-process mutex for state-file read/merge/write sections. The lock is
 * keyed by target path (`<target>.lock`) so callers that update JSON ledgers can
 * reuse one protocol instead of each inventing a partial process-local queue.
 */
const STALE_LOCK_MS = 30_000;
const ACQUIRE_DEADLINE_MS = 60_000;

function isProcessAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		// EPERM means the PID exists but belongs to another user, so it is still alive.
		if (e.code === "EPERM") return true;
		return false;
	}
}

function readLockPid(lockPath: string): number | null {
	try {
		const raw = readFileSync(lockPath, "utf8").trim();
		if (raw.length === 0) return null;
		const parsed = Number.parseInt(raw, 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	} catch {
		return null;
	}
}

function lockfileAgeMs(lockPath: string): number | null {
	try {
		const st = statSync(lockPath);
		return Date.now() - st.mtimeMs;
	} catch {
		return null;
	}
}

export async function withStateFileLock<T>(targetPath: string, fn: () => T | Promise<T>): Promise<T> {
	const lockPath = `${targetPath}.lock`;
	const dir = dirname(lockPath);
	mkdirSync(dir, { recursive: true });
	const deadlineMs = Date.now() + ACQUIRE_DEADLINE_MS;
	let attempt = 0;
	let held = false;
	while (!held) {
		try {
			const fd = openSync(lockPath, "wx", 0o600);
			try {
				writeSync(fd, String(process.pid));
			} finally {
				closeSync(fd);
			}
			held = true;
			break;
		} catch (err) {
			const e = err as NodeJS.ErrnoException;
			if (e.code !== "EEXIST") throw err;

			// Existing lock: inspect ownership before touching it.
			const ownerPid = readLockPid(lockPath);
			const ageMs = lockfileAgeMs(lockPath);
			const ownerDead = ownerPid !== null && !isProcessAlive(ownerPid);
			const expired = ageMs !== null && ageMs > STALE_LOCK_MS;
			const unreadable = ownerPid === null && ageMs !== null && ageMs > STALE_LOCK_MS;

			if (ownerDead || expired || unreadable) {
				// Safe to reclaim. A concurrent waiter may win the race; the next
				// openSync attempt will retry.
				try {
					unlinkSync(lockPath);
				} catch {
					// Another waiter cleaned it first; fall through to retry.
				}
			}

			if (Date.now() > deadlineMs) {
				throw new Error(
					`state file lock timeout after ${ACQUIRE_DEADLINE_MS}ms at ${lockPath} (owner pid=${ownerPid ?? "?"}, age=${ageMs ?? "?"}ms)`,
				);
			}

			attempt += 1;
			const base = Math.min(500, 10 * 2 ** Math.min(attempt, 6));
			const delay = base + Math.floor(Math.random() * base);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
	try {
		return await fn();
	} finally {
		// Only unlink if we still own the lock. If ours was reclaimed as stale by
		// a sibling and they now hold a fresh one, deleting here would corrupt
		// their critical section.
		const ownerPid = readLockPid(lockPath);
		if (ownerPid === process.pid) {
			try {
				unlinkSync(lockPath);
			} catch {
				// already gone; fine.
			}
		}
	}
}
