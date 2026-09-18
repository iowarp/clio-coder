/**
 * The one resolver for `fleet.concurrency`.
 *
 * A numeric setting is the exact worker limit for both the global pool and the
 * local node. `auto` sizes only the local node from host facts: usable CPUs,
 * available memory, and a cgroup memory limit when one is set, so a job inside
 * a batch allocation is not sized from the whole machine. The global pool under
 * `auto` resolves to the upper cap, because SSH nodes carry their own
 * `maxWorkers` and a small orchestrator host must not shrink remote work.
 *
 * Memory held by Clio's own running local workers is added back so the limit
 * does not collapse as the fleet it admits starts, and host facts are sampled
 * at most once per interval.
 */

import { availableParallelism, freemem, totalmem } from "node:os";

/** Which input decided the worker limit. */
export type LocalCapacityBound = "configured" | "cpu" | "memory" | "cgroup" | "cap";

export interface LocalCapacity {
	limit: number;
	bound: LocalCapacityBound;
}

export interface HostCapacityFacts {
	/** Usable CPUs for this process; respects affinity masks such as a Slurm cpuset. */
	cpus: number;
	/** Host memory available to new processes (Linux MemAvailable). */
	availableMemoryBytes: number;
	/** Memory still available inside the cgroup limit; null when no limit is set. */
	cgroupAvailableBytes: number | null;
}

/**
 * Upper bound for `auto`, and the global pool under `auto`. Inference is bounded
 * separately by per-endpoint slot limits, so this caps process fan-out only.
 */
export const AUTO_MAX_WORKERS = 8;

/**
 * Planning estimate per worker process. Observed worker RSS is 160 to 270 MB,
 * but workers run compilers, type checkers, and test suites whose children
 * routinely take several hundred MB more, so the estimate sits near four times
 * the observed worker alone.
 */
export const WORKER_MEMORY_ESTIMATE_BYTES = 1024 * 1024 * 1024;

/** Memory left for the OS, the orchestrator, and local inference servers. */
export const OS_MEMORY_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;

/** Minimum spacing between host samples. */
export const HOST_SAMPLE_INTERVAL_MS = 30_000;

/** Global worker pool for a `fleet.concurrency` setting. */
export function resolveGlobalConcurrency(configured: "auto" | number | undefined): number {
	if (configured === undefined || configured === "auto") return AUTO_MAX_WORKERS;
	return Math.max(1, Math.floor(configured));
}

function workersFor(bytes: number): number {
	return Math.max(1, Math.floor((bytes - OS_MEMORY_RESERVE_BYTES) / WORKER_MEMORY_ESTIMATE_BYTES));
}

/**
 * Local node limit for a `fleet.concurrency` setting. `clioHeldBytes` is memory
 * Clio's running local workers held when the facts were sampled; it is added
 * back so admitted workers do not count against their own fleet.
 */
export function resolveLocalConcurrency(
	configured: "auto" | number | undefined,
	facts: HostCapacityFacts,
	clioHeldBytes = 0,
): LocalCapacity {
	if (configured !== undefined && configured !== "auto")
		return { limit: resolveGlobalConcurrency(configured), bound: "configured" };
	// Ties report the earlier input, so a host that fits the cap reports the cap.
	const candidates: LocalCapacity[] = [
		{ limit: AUTO_MAX_WORKERS, bound: "cap" },
		{ limit: Math.max(1, Math.floor(facts.cpus)), bound: "cpu" },
		{ limit: workersFor(facts.availableMemoryBytes + clioHeldBytes), bound: "memory" },
	];
	if (facts.cgroupAvailableBytes !== null)
		candidates.push({ limit: workersFor(facts.cgroupAvailableBytes + clioHeldBytes), bound: "cgroup" });
	let best = candidates[0] as LocalCapacity;
	for (const candidate of candidates) if (candidate.limit < best.limit) best = candidate;
	return best;
}

/**
 * One short phrase naming what binds an `auto` limit, or null when the limit is
 * the configured number or the cap.
 */
export function describeLocalCapacity(capacity: LocalCapacity): string | null {
	if (capacity.bound === "configured" || capacity.bound === "cap") return null;
	return `${capacity.bound}-bound at ${capacity.limit}`;
}

/** Read this process's host facts. Tests inject facts instead of calling this. */
export function observeHostCapacityFacts(): HostCapacityFacts {
	const available = freemem();
	// constrainedMemory() reports an unbounded sentinel (or 0) when no cgroup
	// limit applies; only a limit below physical memory constrains anything.
	// availableMemory() is then the headroom left inside that limit.
	const constrained = process.constrainedMemory();
	const limited = Number.isFinite(constrained) && constrained > 0 && constrained < totalmem();
	return {
		cpus: availableParallelism(),
		availableMemoryBytes: available,
		cgroupAvailableBytes: limited ? process.availableMemory() : null,
	};
}

export interface LocalCapacitySamplerOptions {
	observe?: () => HostCapacityFacts;
	/** Clio workers currently leased on the local node. */
	activeLocalWorkers: () => number;
	monotonicNow?: () => number;
	intervalMs?: number;
}

export interface LocalCapacitySampler {
	resolve(configured: "auto" | number | undefined): LocalCapacity;
}

interface HostSample {
	facts: HostCapacityFacts;
	activeWorkers: number;
	/** Last time this sample was taken or confirmed as the baseline to keep. */
	checkedAtMs: number;
}

/**
 * Rate-limited host sampling for `auto`. A sample taken while no local worker
 * runs is kept until a later idle moment replaces it, so Clio's own workers
 * never lower the limit; a sample taken while workers run adds back the
 * per-worker estimate for each of them.
 */
export function createLocalCapacitySampler(options: LocalCapacitySamplerOptions): LocalCapacitySampler {
	const observe = options.observe ?? observeHostCapacityFacts;
	const monotonicNow = options.monotonicNow ?? (() => performance.now());
	const intervalMs = options.intervalMs ?? HOST_SAMPLE_INTERVAL_MS;
	let sample: HostSample | null = null;

	function current(): HostSample {
		const atMs = monotonicNow();
		if (sample !== null && atMs - sample.checkedAtMs < intervalMs) return sample;
		const activeWorkers = options.activeLocalWorkers();
		// An idle sample is the better baseline; keep it while workers run.
		if (sample !== null && sample.activeWorkers === 0 && activeWorkers > 0) sample.checkedAtMs = atMs;
		else sample = { facts: observe(), activeWorkers, checkedAtMs: atMs };
		return sample;
	}

	return {
		resolve(configured) {
			if (configured !== undefined && configured !== "auto")
				return { limit: resolveGlobalConcurrency(configured), bound: "configured" };
			const { facts, activeWorkers } = current();
			return resolveLocalConcurrency("auto", facts, activeWorkers * WORKER_MEMORY_ESTIMATE_BYTES);
		},
	};
}
