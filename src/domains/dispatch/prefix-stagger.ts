import type { DispatchPrefixGroup } from "./contract.js";
import type { HeartbeatStamp } from "./heartbeat.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "./worker-spawn.js";

/** The longest a batch holds the rest of a shared-prefix group for its leader's first token. */
export const PREFIX_HOLD_CAP_MS = 15_000;

export type PrefixHold =
	| { role: "leader"; group: DispatchPrefixGroup }
	| { role: "follower"; leaderRunId: string; heldMs: number }
	| null;

export type PrefixClaim = { role: "leader" | "follower"; group: DispatchPrefixGroup } | null;

/**
 * Within one batch, the first native run of a prefix key leads and starts at once; a later run of the same key
 * follows. Claiming is synchronous, so a follower's place is fixed at admission even though it waits afterwards.
 */
export function claimSharedPrefix(
	groups: Map<string, DispatchPrefixGroup> | undefined,
	key: string | null,
	runId: string,
): PrefixClaim {
	if (groups === undefined || key === null) return null;
	const existing = groups.get(key);
	if (existing !== undefined) return existing.isReleased() ? null : { role: "follower", group: existing };
	let release!: () => void;
	let isReleased = false;
	const released = new Promise<void>((resolve) => {
		release = () => {
			isReleased = true;
			clearTimeout(timer);
			resolve();
		};
	});
	// Kept referenced: a waiting follower is live work, and its batch releases every group when it settles.
	const timer = setTimeout(release, PREFIX_HOLD_CAP_MS);
	const group: DispatchPrefixGroup = { leaderRunId: runId, released, release, isReleased: () => isReleased };
	groups.set(key, group);
	return { role: "leader", group };
}

/**
 * A follower waits until its leader streams its first token, settles, or the group's cap runs out, so it reads the
 * prefix the leader wrote instead of prefilling it again. Abort ends the wait; the caller rechecks its cancel state.
 */
export async function waitForPrefixLeader(
	group: DispatchPrefixGroup,
	options: { signal?: AbortSignal; now?: () => number; onHold?: () => void } = {},
): Promise<PrefixHold> {
	if (group.isReleased()) return null;
	const now = options.now ?? Date.now;
	const startedAt = now();
	const signal = options.signal;
	if (signal?.aborted) return null;
	options.onHold?.();
	let onAbort: (() => void) | undefined;
	await Promise.race([
		group.released,
		new Promise<void>((resolve) => {
			onAbort = resolve;
			signal?.addEventListener("abort", onAbort, { once: true });
		}),
	]);
	if (onAbort) signal?.removeEventListener("abort", onAbort);
	return { role: "follower", leaderRunId: group.leaderRunId, heldMs: Math.max(0, now() - startedAt) };
}

/** Claims a place in the key's group and, for a follower, waits for the leader. */
export async function holdForSharedPrefix(
	groups: Map<string, DispatchPrefixGroup> | undefined,
	key: string | null,
	runId: string,
	options: { signal?: AbortSignal; now?: () => number; onHold?: () => void } = {},
): Promise<PrefixHold> {
	const claim = claimSharedPrefix(groups, key, runId);
	if (claim === null) return null;
	if (claim.role === "leader") return { role: "leader", group: claim.group };
	return waitForPrefixLeader(claim.group, options);
}

/** The result a follower reports when it was aborted before its worker existed. */
const ABORTED_BEFORE_START: SpawnedWorkerResult = { exitCode: null, signal: "SIGTERM" };

/**
 * A worker handle that exists at once and starts its real worker only after `wait` resolves, so a batch returns a
 * follower's handle before the shared-prefix hold ends. `abort()` during the wait ends it and no worker starts; `start`
 * returning null means the run was cancelled meanwhile. The heartbeat reads as live while held.
 */
export function startAfterPrefixHold(
	wait: (signal: AbortSignal) => Promise<void>,
	start: () => SpawnedWorker | null,
	clock: { now: () => number; monotonicNow: () => number },
): SpawnedWorker {
	const local = new AbortController();
	let real: SpawnedWorker | null = null;
	const started = (async (): Promise<SpawnedWorker | null> => {
		await wait(local.signal);
		if (local.signal.aborted) return null;
		real = start();
		return real;
	})();
	const heartbeatAt: HeartbeatStamp = {
		get current() {
			return real?.heartbeatAt.current ?? clock.now();
		},
		get monotonic() {
			return real === null ? clock.monotonicNow() : (real.heartbeatAt.monotonic ?? real.heartbeatAt.current);
		},
	};
	const events = (async function* (): AsyncGenerator<unknown> {
		let worker: SpawnedWorker | null;
		try {
			worker = await started;
		} catch {
			return; // the failure settles through the promise
		}
		if (worker !== null) yield* worker.events;
	})();
	return {
		get pid() {
			return real?.pid ?? null;
		},
		promise: started.then((worker) => (worker === null ? ABORTED_BEFORE_START : worker.promise)),
		events,
		abort() {
			local.abort();
			real?.abort();
		},
		heartbeatAt,
		send: (value) => real?.send?.(value) ?? false,
		lastChannelFailure: () => real?.lastChannelFailure?.() ?? null,
		attestation: () => real?.attestation?.() ?? null,
	};
}
