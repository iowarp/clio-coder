/**
 * The one resolver for `fleet.concurrency`.
 *
 * A numeric setting is the exact worker limit for both the global pool and the
 * local node. `auto` sizes only the local node from host facts: usable CPUs
 * (capped by a cgroup CPU quota), available memory, and a cgroup memory limit
 * when one is set, so a job inside a batch allocation or container is not sized
 * from the whole machine. Cgroup headroom counts
 * the working set, not reclaimable page cache. The global pool under
 * `auto` resolves to the upper cap, because SSH nodes carry their own
 * `maxWorkers` and a small orchestrator host must not shrink remote work.
 *
 * Memory held by Clio's own running local workers is added back so the limit
 * does not collapse as the fleet it admits starts, and host facts are sampled
 * at most once per interval.
 */

import { readFileSync } from "node:fs";
import { availableParallelism, freemem, totalmem } from "node:os";
import { dirname, join, relative } from "node:path";

/** Which input decided the worker limit. */
export type LocalCapacityBound = "configured" | "cpu" | "memory" | "cgroup" | "cap";

export interface LocalCapacity {
	limit: number;
	bound: LocalCapacityBound;
}

export interface HostCapacityFacts {
	/**
	 * Usable CPUs for this process; respects affinity masks such as a Slurm cpuset, and a cgroup v2 `cpu.max` quota.
	 */
	cpus: number;
	/** Host memory available to new processes (Linux MemAvailable). */
	availableMemoryBytes: number;
	/**
	 * Memory still available inside the cgroup limit, not counting reclaimable page cache; null when no limit is set.
	 */
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

/**
 * Reserve inside a cgroup limit. The host kernel is not charged to the cgroup,
 * and the orchestrator's own memory is already in its working set.
 */
export const CGROUP_MEMORY_RESERVE_BYTES = 512 * 1024 * 1024;

/** Minimum spacing between host samples. */
export const HOST_SAMPLE_INTERVAL_MS = 30_000;

/** Global worker pool for a `fleet.concurrency` setting. */
export function resolveGlobalConcurrency(configured: "auto" | number | undefined): number {
	if (configured === undefined || configured === "auto") return AUTO_MAX_WORKERS;
	return Math.max(1, Math.floor(configured));
}

function workersFor(bytes: number, reserveBytes = OS_MEMORY_RESERVE_BYTES): number {
	return Math.max(1, Math.floor((bytes - reserveBytes) / WORKER_MEMORY_ESTIMATE_BYTES));
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
		candidates.push({
			limit: workersFor(facts.cgroupAvailableBytes + clioHeldBytes, CGROUP_MEMORY_RESERVE_BYTES),
			bound: "cgroup",
		});
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

const REFUSAL_SOURCES: Partial<Record<LocalCapacityBound, string>> = {
	cpu: "cpu-bound at {n} from usable CPUs",
	memory: "memory-bound at {n} from host available memory",
	cgroup: "memory-bound at {n} from cgroup headroom",
};

/**
 * The limit that binds an `auto` local node, for a capacity refusal, so the model
 * dispatches fewer at once instead of retrying the same fan-out; null when the
 * limit is the configured number or the cap.
 */
export function describeLocalCapacityRefusal(capacity: LocalCapacity): string | null {
	const source = REFUSAL_SOURCES[capacity.bound];
	if (source === undefined) return null;
	return `${source.replace("{n}", String(capacity.limit))}; set fleet.concurrency to pin it`;
}

function gibibytes(bytes: number): string {
	return (Math.max(0, bytes) / 1024 ** 3).toFixed(1);
}

/**
 * User-facing account of automatic local worker sizing.
 *
 * CPU and currently available memory are facts Node can read reliably. GPU
 * inventory, VRAM pressure, and whether a particular model fits are separate
 * runtime concerns and are deliberately named as unobserved instead of being
 * implied by a worker-count recommendation.
 */
export function describeHostCapacity(facts: HostCapacityFacts, capacity: LocalCapacity): string {
	const bound =
		capacity.bound === "configured"
			? "configured limit"
			: capacity.bound === "cap"
				? "built-in safety cap"
				: `${capacity.bound} limit`;
	const cgroup =
		facts.cgroupAvailableBytes === null ? "" : `, ${gibibytes(facts.cgroupAvailableBytes)} GiB available to this process`;
	return `${facts.cpus} usable CPUs, ${gibibytes(facts.availableMemoryBytes)} GiB available memory${cgroup}; ${capacity.limit} local workers (${bound}). GPU/VRAM and model fit are not checked.`;
}

/** The host reads behind `observeHostCapacityFacts`; tests replace them. */
export interface HostCapacityProbe {
	cpus?: () => number;
	freeMemory?: () => number;
	totalMemory?: () => number;
	constrainedMemory?: () => number;
	availableMemory?: () => number;
	/** This process's cgroup v2 directory, or null when it cannot be read. */
	cgroupDir?: () => string | null;
	/** The cgroup v2 mount; quotas are read from `cgroupDir` up to and including it. */
	cgroupRoot?: string;
}

const CGROUP_ROOT = "/sys/fs/cgroup";

function ownCgroupDir(): string | null {
	try {
		const line = readFileSync("/proc/self/cgroup", "utf8")
			.split("\n")
			.find((entry) => entry.startsWith("0::"));
		return line === undefined ? null : join(CGROUP_ROOT, line.slice(3).trim());
	} catch {
		return null;
	}
}

function readCgroupFile(dir: string, name: string): string | null {
	try {
		return readFileSync(join(dir, name), "utf8");
	} catch {
		return null;
	}
}

/**
 * Headroom inside a cgroup v2 limit counting only the working set:
 * memory.max - (anon + shmem + kernel). memory.current also counts file pages,
 * active ones included, that the kernel reclaims under pressure, so a container
 * whose main session reads large files would otherwise lose workers to its own
 * page cache. `kernel` counts only where the kernel reports it. Null when
 * memory.stat has no `anon`; `limitBytes` stands in for a memory.max of `max`,
 * where the binding limit sits on an ancestor cgroup.
 */
function cgroupWorkingSetHeadroom(dir: string, limitBytes: number): number | null {
	const stat = readCgroupFile(dir, "memory.stat");
	const counter = (name: string): number | undefined => {
		const value = stat?.match(new RegExp(`^${name} (\\d+)$`, "mu"))?.[1];
		return value === undefined ? undefined : Number(value);
	};
	const anon = counter("anon");
	if (anon === undefined) return null;
	const workingSet = anon + (counter("shmem") ?? 0) + (counter("kernel") ?? 0);
	const max = Number(readCgroupFile(dir, "memory.max")?.trim());
	const limit = Number.isFinite(max) && max > 0 ? max : limitBytes;
	return Math.max(0, limit - workingSet);
}

/**
 * CPUs a cgroup v2 quota grants: the tightest `cpu.max` quota/period from `dir`
 * up to `root`, rounded up as the Go and Java runtimes do, since a quota of 1.5
 * CPUs still runs two workers at three-quarter speed. Null when no cgroup on the
 * way sets a quota (`max`). The affinity mask still applies on top.
 */
function cgroupCpuQuota(dir: string, root: string): number | null {
	let quota: number | null = null;
	for (let current = dir; ; current = dirname(current)) {
		const fields = readCgroupFile(current, "cpu.max")?.trim().split(/\s+/u);
		const max = Number(fields?.[0]);
		const period = Number(fields?.[1]);
		if (Number.isFinite(max) && max > 0 && Number.isFinite(period) && period > 0)
			quota = Math.min(quota ?? Number.POSITIVE_INFINITY, Math.max(1, Math.ceil(max / period)));
		const rest = relative(root, current);
		if (rest === "" || rest.startsWith("..") || current === dirname(current)) break;
	}
	return quota;
}

/** Read this process's host facts. Tests inject facts instead of calling this. */
export function observeHostCapacityFacts(probe: HostCapacityProbe = {}): HostCapacityFacts {
	const total = (probe.totalMemory ?? totalmem)();
	// constrainedMemory() reports an unbounded sentinel (or 0) when no cgroup
	// limit applies; only a limit below physical memory constrains anything.
	const constrained = (probe.constrainedMemory ?? (() => process.constrainedMemory()))();
	const limited = Number.isFinite(constrained) && constrained > 0 && constrained < total;
	let cgroupAvailableBytes: number | null = null;
	const dir = (probe.cgroupDir ?? ownCgroupDir)();
	if (limited) {
		cgroupAvailableBytes =
			(dir === null ? null : cgroupWorkingSetHeadroom(dir, constrained)) ??
			(probe.availableMemory ?? (() => process.availableMemory()))();
	}
	const affinity = (probe.cpus ?? availableParallelism)();
	const quota = dir === null ? null : cgroupCpuQuota(dir, probe.cgroupRoot ?? CGROUP_ROOT);
	return {
		cpus: quota === null ? affinity : Math.min(affinity, quota),
		availableMemoryBytes: (probe.freeMemory ?? freemem)(),
		cgroupAvailableBytes,
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
	/** Last time host facts and the active-worker count were sampled together. */
	checkedAtMs: number;
}

/**
 * Rate-limited host sampling for `auto`, including while workers run. Each
 * sample captures its active-worker count so the add-back accounts for workers
 * included in those memory facts, not workers admitted after the sample.
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
		sample = { facts: observe(), activeWorkers, checkedAtMs: atMs };
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
