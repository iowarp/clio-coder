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
import type { ModelAdmissionReporter, ResidencyLockHolder } from "../../core/model-admission.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioStatePath } from "../../core/xdg.js";
import { canonicalEndpointKey } from "../../domains/providers/endpoint-capacity.js";

/** Total time one process waits for another's mutation before proceeding unlocked. */
const LOCK_WAIT_MS = 120_000;

function lockTargetFor(targetKey: string): string {
	const key = canonicalEndpointKey(targetKey) ?? targetKey;
	return join(clioStatePath(), "residency-locks", key.replace(/[^a-zA-Z0-9._-]+/g, "_"));
}

/** Run `fn` while holding the per-target residency lock. `wants` is recorded so the next waiter can name what this holds it for. */
export async function withResidencyLock<T>(
	targetKey: string,
	fn: () => Promise<T>,
	signal?: AbortSignal,
	watch?: { wants: string; report?: ModelAdmissionReporter | undefined },
): Promise<T> {
	const report = watch?.report;
	return withStateFileLock(lockTargetFor(targetKey), fn, {
		timeoutMs: LOCK_WAIT_MS,
		onAcquireFailure: "run-unlocked",
		...(signal ? { signal } : {}),
		...(watch ? { note: watch.wants } : {}),
		...(report
			? {
					onContended: (holder) => {
						const named: ResidencyLockHolder | null = holder && {
							pid: holder.pid,
							host: holder.host,
							self: holder.self,
							wants: holder.note,
						};
						report({ stage: "lock", holder: named });
					},
				}
			: {}),
	});
}
