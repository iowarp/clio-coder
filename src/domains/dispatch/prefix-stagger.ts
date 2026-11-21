import { claimLeaseCacheLane } from "./capacity-lease.js";
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
	options: {
		signal?: AbortSignal;
		/** Monotonic; the hold is a span in this process. */
		now?: () => number;
	} = {},
): Promise<PrefixHold> {
	if (group.isReleased()) return null;
	const now = options.now ?? (() => performance.now());
	const startedAt = now();
	const signal = options.signal;
	if (signal?.aborted) return null;
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

const liveCacheLanes = new Map<string, Set<number>>();

/**
 * Workers with one stable head share a provider session id on a session-routed backend, so a later one reads the
 * head an earlier one wrote. The id is a routing affinity, and live conversations that share one get routed away
 * from their own history more often than conversations with an id each. Measured on gpt-6-luna, 2026-11-20, later
 * calls that read the worker's whole previous prompt, shared against separate ids: four live workers per id 0.45
 * against 0.62 in a batch of twelve and 0.47 against 0.52 in a batch of six. So each live worker of a head takes a
 * lane of its own, the lowest free one, and the lane rides its spec into that id (FL-17). Workers started one after
 * another all take lane 0, and a batch's lanes are warm for the next batch. Lanes are per process.
 */
export function claimCacheLane(key: string): { lane: number; release: () => void } {
	const live = liveCacheLanes.get(key) ?? new Set<number>();
	liveCacheLanes.set(key, live);
	let lane = 0;
	while (live.has(lane)) lane += 1;
	live.add(lane);
	let released = false;
	return {
		lane,
		release: () => {
			// A second release must not free a lane another worker has taken since.
			if (released) return;
			released = true;
			live.delete(lane);
			if (live.size === 0 && liveCacheLanes.get(key) === live) liveCacheLanes.delete(key);
		},
	};
}

/**
 * A worker's cache lane, held on its capacity lease so every Clio process sharing this state dir sees it, and freed
 * with the lease (FL-17, M-11). Only when the lease store cannot take it (the lease is gone, the store unreadable or
 * locked past the timeout) does the worker fall back to this process's own lanes, which `release` frees.
 */
export function claimWorkerCacheLane(leaseId: string, key: string): { lane: number; release: () => void } {
	try {
		const lane = claimLeaseCacheLane(leaseId, key);
		if (lane !== null) return { lane, release: () => {} };
	} catch {
		// Fall through to the in-process lanes.
	}
	return claimCacheLane(key);
}

/** The result a follower reports when it was aborted before its worker existed. */
const ABORTED_BEFORE_START: SpawnedWorkerResult = { exitCode: null, signal: "SIGTERM" };

/**
 * A worker handle that exists at once and starts its real worker only after `wait` resolves, so a batch returns a
 * follower's handle before the shared-prefix hold ends. `abort()` during the wait ends it and no worker starts; `start`
 * returning null means the run was cancelled meanwhile. The heartbeat reads as live while held, and `pid` reads as
 * `heldPid` (the process that vouches for the run) until the worker exists. `send` returns false until then;
 * `onStarted` runs once it forwards to the worker.
 */
export function startAfterPrefixHold(
	wait: (signal: AbortSignal) => Promise<void>,
	start: () => SpawnedWorker | null,
	clock: { now: () => number; monotonicNow: () => number },
	heldPid: number | null = null,
	onStarted?: (worker: SpawnedWorker) => void,
): SpawnedWorker {
	const local = new AbortController();
	let real: SpawnedWorker | null = null;
	const started = (async (): Promise<SpawnedWorker | null> => {
		await wait(local.signal);
		if (local.signal.aborted) return null;
		real = start();
		if (real !== null) onStarted?.(real);
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
			return real === null ? heldPid : real.pid;
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
