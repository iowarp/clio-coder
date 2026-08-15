/**
 * Cross-process serialization for residency mutations. Workers run as
 * separate processes (dist/worker/entry.js), so the reconciler's in-process
 * state cannot stop a worker and the orchestrator from interleaving
 * unload/load calls against the same server. Each target gets an advisory lock
 * file in the state dir, taken through the shared state-file lock, and every
 * failure mode degrades to running unlocked, because serialization is an
 * optimization and must never fail or stall a turn beyond the documented load
 * wait.
 */

import { join } from "node:path";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioStatePath } from "../../core/xdg.js";

/** Total time one process waits for another's mutation before proceeding unlocked. */
const LOCK_WAIT_MS = 120_000;

function lockTargetFor(targetKey: string): string {
	return join(clioStatePath(), "residency-locks", targetKey.replace(/[^a-zA-Z0-9._-]+/g, "_"));
}

/** Run `fn` while holding the per-target residency lock. */
export async function withResidencyLock<T>(targetKey: string, fn: () => Promise<T>): Promise<T> {
	return withStateFileLock(lockTargetFor(targetKey), fn, {
		timeoutMs: LOCK_WAIT_MS,
		onAcquireFailure: "run-unlocked",
	});
}
