/**
 * Cross-process serialization for residency mutations. Workers run as
 * separate processes (dist/worker/entry.js), so the reconciler's in-process
 * state cannot stop a worker and the orchestrator from interleaving
 * unload/load calls against the same server. Each target gets an advisory
 * lock file in the state dir, mirroring the settings.yaml lock: exclusive
 * create wins, a stale file older than the load wait is stolen, and every
 * failure mode degrades to running unlocked, because serialization is an
 * optimization and must never fail or stall a turn beyond the documented
 * load wait.
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clioStatePath } from "../../core/xdg.js";

/** A holder that has not released within the router load wait is presumed dead. */
const LOCK_STALE_MS = 130_000;
/** Total time one process waits for another's mutation before proceeding unlocked. */
const LOCK_WAIT_MS = 120_000;
const LOCK_POLL_MS = 200;

function lockPathFor(targetKey: string): string {
	const name = targetKey.replace(/[^a-zA-Z0-9._-]+/g, "_");
	return join(clioStatePath(), "residency-locks", `${name}.lock`);
}

function tryAcquire(lockPath: string): boolean {
	try {
		writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o644,
		});
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	try {
		if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { force: true });
	} catch {
		// Lock vanished between the failed create and the stat: the holder
		// released it. The next attempt races for it normally.
	}
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding the per-target residency lock. Acquisition failures
 * (unwritable state dir, timeout waiting on a live holder) run `fn` unlocked
 * rather than failing the turn.
 */
export async function withResidencyLock<T>(targetKey: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = lockPathFor(targetKey);
	let held = false;
	try {
		mkdirSync(join(clioStatePath(), "residency-locks"), { recursive: true });
		const deadline = Date.now() + LOCK_WAIT_MS;
		held = tryAcquire(lockPath);
		while (!held && Date.now() < deadline) {
			await sleep(LOCK_POLL_MS);
			held = tryAcquire(lockPath);
		}
	} catch {
		held = false;
	}
	try {
		return await fn();
	} finally {
		if (held) {
			try {
				rmSync(lockPath, { force: true });
			} catch {
				// Stale-lock stealing reclaims an unremovable lock after the wait.
			}
		}
	}
}
