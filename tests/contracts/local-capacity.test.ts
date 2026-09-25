import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import { createSchedulingBundle } from "../../src/domains/scheduling/extension.js";
import {
	AUTO_MAX_WORKERS,
	createLocalCapacitySampler,
	type HostCapacityFacts,
	resolveGlobalConcurrency,
	resolveLocalConcurrency,
	WORKER_MEMORY_ESTIMATE_BYTES,
} from "../../src/domains/scheduling/local-capacity.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { renderDashboardPage } from "../../src/interactive/footer/pages.js";
import { fleetNodeRows } from "../../src/interactive/overlays/settings.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { footerState } from "../harness/footer-fixture.js";

const GiB = 1024 * 1024 * 1024;

/** A roomy host: 32 CPUs, 64 GiB available, no cgroup limit. */
function host(overrides: Partial<HostCapacityFacts> = {}): HostCapacityFacts {
	return { cpus: 32, availableMemoryBytes: 64 * GiB, cgroupAvailableBytes: null, ...overrides };
}

describe("fleet.concurrency default", () => {
	it("resolves a settings file without the key to auto and keeps an explicit value as written", () => {
		const absent = validateSettings({ version: 2, fleet: { retry: { maxRetries: 2 } } });
		deepStrictEqual(absent.issues, []);
		strictEqual(absent.settings.fleet.concurrency, "auto");
		strictEqual(resolveGlobalConcurrency(absent.settings.fleet.concurrency), AUTO_MAX_WORKERS);
		for (const explicit of [1, "auto"] as const) {
			const result = validateSettings({ version: 2, fleet: { concurrency: explicit } });
			deepStrictEqual(result.issues, []);
			strictEqual(result.settings.fleet.concurrency, explicit);
		}
		strictEqual(resolveGlobalConcurrency(1), 1);
		deepStrictEqual(resolveLocalConcurrency(1, host()), { limit: 1, bound: "configured" });
	});
});

describe("fleet.concurrency auto resolution", () => {
	it("clamps a low-memory host to one local worker", () => {
		const capacity = resolveLocalConcurrency("auto", host({ availableMemoryBytes: 2.5 * GiB }));
		strictEqual(capacity.limit, 1);
		strictEqual(capacity.bound, "memory");
	});

	it("sizes from a cgroup limit before host memory", () => {
		const capacity = resolveLocalConcurrency("auto", host({ cgroupAvailableBytes: 5 * GiB }));
		strictEqual(capacity.limit, 3);
		strictEqual(capacity.bound, "cgroup");
	});

	it("clamps to a CPU affinity of two", () => {
		const capacity = resolveLocalConcurrency("auto", host({ cpus: 2 }));
		strictEqual(capacity.limit, 2);
		strictEqual(capacity.bound, "cpu");
	});

	it("reports the cap on a host that fits it", () => {
		const capacity = resolveLocalConcurrency("auto", host());
		strictEqual(capacity.limit, AUTO_MAX_WORKERS);
		strictEqual(capacity.bound, "cap");
	});

	it("keeps a numeric setting exact regardless of host facts", () => {
		const tiny = host({ cpus: 1, availableMemoryBytes: 1 * GiB, cgroupAvailableBytes: 1 * GiB });
		strictEqual(resolveLocalConcurrency(3, tiny).limit, 3);
		strictEqual(resolveLocalConcurrency(3, tiny).bound, "configured");
		strictEqual(resolveLocalConcurrency(20, tiny).limit, 20);
		strictEqual(resolveGlobalConcurrency(20), 20);
		const sampler = createLocalCapacitySampler({
			observe: () => tiny,
			activeLocalWorkers: () => 0,
		});
		strictEqual(sampler.resolve(12).limit, 12);
	});

	it("does not lower the limit as Clio's own workers start", () => {
		let clock = 0;
		let active = 0;
		let facts = host({ availableMemoryBytes: 8 * GiB });
		let samples = 0;
		const sampler = createLocalCapacitySampler({
			observe: () => {
				samples += 1;
				return facts;
			},
			activeLocalWorkers: () => active,
			monotonicNow: () => clock,
			intervalMs: 1000,
		});
		strictEqual(sampler.resolve("auto").limit, 6);
		// Five workers start and each takes about a worker estimate of memory.
		active = 5;
		facts = host({ availableMemoryBytes: 8 * GiB - 5 * WORKER_MEMORY_ESTIMATE_BYTES });
		clock = 500;
		strictEqual(sampler.resolve("auto").limit, 6);
		strictEqual(samples, 1, "a resolve inside the interval reuses the sample");
		clock = 5000;
		strictEqual(sampler.resolve("auto").limit, 6, "worker memory add-back preserves the limit after resampling");
		strictEqual(samples, 2, "busy hosts are resampled with the matching worker add-back");
		// Once idle again the host is resampled.
		active = 0;
		facts = host({ availableMemoryBytes: 4 * GiB });
		clock = 10_000;
		strictEqual(sampler.resolve("auto").limit, 2);
		strictEqual(samples, 3);
	});

	it("adds back running workers when the first sample is taken busy", () => {
		const sampler = createLocalCapacitySampler({
			observe: () => host({ availableMemoryBytes: 8 * GiB - 4 * WORKER_MEMORY_ESTIMATE_BYTES }),
			activeLocalWorkers: () => 4,
			monotonicNow: () => 0,
		});
		strictEqual(sampler.resolve("auto").limit, 6);
	});
});

describe("fleet.concurrency auto placement surfaces", () => {
	function schedulingFor(settings: typeof DEFAULT_SETTINGS) {
		const config = { get: () => settings } as unknown as ConfigContract;
		return createSchedulingBundle(
			{
				bus: createSafeEventBus(),
				getContract: (<T>(name: string) => (name === "config" ? config : undefined) as T | undefined) as never,
			},
			{ localCapacity: { observe: () => host({ cpus: 2 }), monotonicNow: () => 0 } },
		).contract;
	}

	it("clamps only the local node; SSH nodes and the global pool keep their limits", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.concurrency = "auto";
		settings.fleet.nodes = [{ id: "blade", host: "blade.lan", maxWorkers: 6 }];
		const scheduling = schedulingFor(settings);
		strictEqual(scheduling.maxWorkers(), AUTO_MAX_WORKERS);
		const local = scheduling.fleet?.get("local");
		strictEqual(local?.maxWorkers, 2);
		strictEqual(local?.capacityBound, "cpu");
		const blade = scheduling.fleet?.get("blade");
		strictEqual(blade?.maxWorkers, 6);
		strictEqual(blade?.capacityBound, null);
		const rows = fleetNodeRows(scheduling.fleet?.list() ?? []);
		const text = (index: number) => (rows[index]?.valueSegments ?? []).map((segment) => segment.text).join("");
		match(text(0), /0\/2 busy · cpu-bound at 2/u);
		strictEqual(text(1).includes("bound"), false);
	});

	it("keeps a numeric setting for both the local node and the global pool", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.concurrency = 5;
		const scheduling = schedulingFor(settings);
		strictEqual(scheduling.maxWorkers(), 5);
		strictEqual(scheduling.fleet?.get("local")?.maxWorkers, 5);
		strictEqual(scheduling.fleet?.get("local")?.capacityBound, "configured");
	});

	it("names the local worker limit and its binding input in the live Status page", () => {
		const snapshot = footerState();
		snapshot.agent.localCapacity = { limit: 2, bound: "memory" };
		const text = renderDashboardPage(snapshot, "Status", 120, 240, "Alt+U").map(stripTerminalSequences).join("\n");
		match(text, /Worker cap\s+2 · memory/u);
	});
});

describe("dispatch capacity under auto", () => {
	beforeEach(async () => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("admits SSH work past a clamped local node without shrinking the global pool", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.safety.autonomy = "yolo";
		settings.fleet.concurrency = "auto";
		settings.fleet.nodes = [{ id: "blade", host: "blade.lan", maxWorkers: 3 }];
		const bundle = makeDispatchBundle(
			dispatchStubContext({
				settings,
				scheduling: {
					maxWorkers: () => AUTO_MAX_WORKERS,
					localCapacity: () => ({ limit: 1, bound: "memory" }),
				},
			}),
			{
				spawnWorker: () => {
					throw new Error("preparation must not spawn a worker");
				},
			},
		);
		await bundle.extension.start();
		try {
			const reservations = bundle.contract.reservations;
			ok(reservations);
			const preview = bundle.contract.preview?.({
				agentId: "scout",
				task: "Inspect the fixture input.",
				executionRole: "researcher",
			});
			ok(preview);
			const { endpoint: _endpoint, ...resolution } = preview;
			const on = (nodeId: string, kind: "local" | "ssh") => ({ ...resolution, node: { id: nodeId, kind } });
			throws(
				() =>
					reservations.prepare({
						topology: "parallel",
						tasks: [
							{ memberId: "a", wave: 0, resolution: on("local", "local") },
							{ memberId: "b", wave: 0, resolution: on("local", "local") },
						],
					}),
				/node 'local' capacity exceeded \(2\/1\)/u,
			);
			const remote = reservations.prepare({
				topology: "parallel",
				tasks: [
					{ memberId: "a", wave: 0, resolution: on("blade", "ssh") },
					{ memberId: "b", wave: 0, resolution: on("blade", "ssh") },
					{ memberId: "c", wave: 0, resolution: on("blade", "ssh") },
				],
			});
			ok(remote.ownerId);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
