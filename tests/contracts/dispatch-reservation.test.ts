import { match, ok, strictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type { DispatchNodePlacement } from "../../src/domains/dispatch/extension.js";
import {
	consumeDispatchReservation,
	createDispatchReservation,
	getDispatchReservation,
	listDispatchReservations,
	rebindDispatchReservationMember,
	releaseDispatchReservationMember,
	reservedCapacity,
	rollbackDispatchReservation,
} from "../../src/domains/dispatch/reservation-store.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import { createFleetRegistry } from "../../src/domains/scheduling/cluster.js";
import { createConcurrencyGate } from "../../src/domains/scheduling/concurrency.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import {
	DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT,
	resolvedDispatchPlanFromArgs,
} from "../../src/tools/dispatch-plan.js";
import { createRegistry } from "../../src/tools/registry.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

function settingsWithNode(maxWorkers = 1): typeof DEFAULT_SETTINGS {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{ id: "primary", runtime: "openai", defaultModel: "batch-model", pricing: { input: 0, output: 70 } },
	];
	settings.workers.default.target = "primary";
	settings.workers.default.model = "batch-model";
	settings.fleet.nodes = [{ id: "mini", host: "mini.test", maxWorkers }];
	return settings;
}

function schedulingFor(settings: typeof DEFAULT_SETTINGS, maxWorkers: number, currentUsd = 0, ceilingUsd = 5) {
	const gate = createConcurrencyGate(maxWorkers);
	const fleet = createFleetRegistry(() => settings.fleet.nodes, { localMaxWorkers: () => maxWorkers });
	return {
		fleet,
		ceilingUsd: () => ceilingUsd,
		checkCeiling: (usd: number) =>
			usd < ceilingUsd ? ("under" as const) : usd === ceilingUsd ? ("at" as const) : ("over" as const),
		preflight: () => ({
			verdict: currentUsd < ceilingUsd ? ("under" as const) : ("at" as const),
			currentUsd,
			ceilingUsd,
		}),
		activeWorkers: () => gate.activeWorkers(),
		maxWorkers: () => gate.maxWorkers,
		tryAcquireWorker: () => gate.tryAcquire(),
		releaseWorker: () => gate.release(),
	};
}

function remotePlacement(): DispatchNodePlacement {
	return { node: { id: "mini", kind: "ssh", host: "mini.test" }, release: () => {} };
}

function retryWorker(result: SpawnedWorkerResult, text?: string): SpawnedWorker {
	return {
		pid: 300,
		promise: Promise.resolve(result),
		events: (async function* () {
			if (text !== undefined) {
				yield { type: "message_end", message: { role: "assistant", content: text, usage: { input: 1, output: 1 } } };
			}
		})(),
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

function twoTargetSettings(): typeof DEFAULT_SETTINGS {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{ id: "primary", runtime: "openai", defaultModel: "batch-model" },
		{ id: "secondary", runtime: "openai", defaultModel: "batch-model" },
	];
	settings.workers.default.target = "primary";
	settings.workers.default.model = "batch-model";
	settings.workers.maxRetries = 1;
	return settings;
}

const CAPACITY_ONE_LOCAL = {
	global: { active: 0, limit: 1 },
	nodes: { local: { active: 0, limit: 1 } },
	budget: { currentUsd: 0, ceilingUsd: 5 },
} as const;

describe("dispatch batch reservations", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("denies two parallel capacity-one pins as a unit but admits their explicit sequence", async () => {
		const settings = settingsWithNode(1);
		const scheduling = schedulingFor(settings, 4);
		const bundle = makeDispatchBundle(dispatchStubContext({ settings, scheduling }), {
			previewNode: () => ({ node: { id: "mini", kind: "ssh", host: "mini.test" } }),
			resolveNode: remotePlacement,
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const parallel = tool.prepareAdmissionArguments?.({ tasks: ["one", "two"], mode: "parallel", node: "mini" });
			ok(parallel);
			match(String(parallel[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT]), /node 'mini' capacity exceeded \(2\/1\)/);
			const sequential = tool.prepareAdmissionArguments?.({ tasks: ["one", "two"], mode: "sequential", node: "mini" });
			ok(sequential);
			strictEqual(sequential[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT], undefined);
			strictEqual(resolvedDispatchPlanFromArgs(sequential)?.tasks.length, 2);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("checks the aggregate conservative budget instead of approving siblings independently", async () => {
		const settings = settingsWithNode(2);
		const scheduling = schedulingFor(settings, 4, 1, 5);
		const bundle = makeDispatchBundle(dispatchStubContext({ settings, scheduling }), {
			previewNode: () => ({ node: { id: "mini", kind: "ssh", host: "mini.test" } }),
			resolveNode: remotePlacement,
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const one = tool.prepareAdmissionArguments?.({ tasks: ["one"], node: "mini" });
			ok(one);
			strictEqual(one[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT], undefined, "either task alone fits the remainder");
			tool.disposeAdmissionArguments?.(one);
			const two = tool.prepareAdmissionArguments?.({ tasks: ["one", "two"], node: "mini" });
			ok(two);
			match(String(two[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT]), /aggregate budget exceeded/);
			match(String(two[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT]), /batch upper bound/);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("consumes every admitted member exactly once and releases the unit on completion", async () => {
		const settings = settingsWithNode(2);
		const scheduling = schedulingFor(settings, 2);
		let nextPid = 100;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings, scheduling }), {
			previewNode: () => ({ node: { id: "local", kind: "local" } }),
			spawnWorker: () => ({
				pid: nextPid++,
				promise: Promise.resolve({ exitCode: 0, signal: null }),
				events: (async function* () {
					yield { type: "message_end", message: { role: "assistant", content: "done", usage: { input: 1, output: 1 } } };
				})(),
				abort: () => {},
				heartbeatAt: { current: Date.now() },
			}),
		});
		await bundle.extension.start();
		try {
			const requests = [
				{ agentId: "coder", executionRole: "builder", task: "one" },
				{ agentId: "coder", executionRole: "builder", task: "two" },
			] as const;
			const firstResolution = bundle.contract.preview?.(requests[0]);
			const secondResolution = bundle.contract.preview?.(requests[1]);
			ok(firstResolution && secondResolution);
			const reservation = bundle.contract.reservations?.prepare({
				topology: "parallel",
				tasks: [firstResolution, secondResolution].map((resolution, index) => ({
					memberId: `task-${index + 1}`,
					wave: 0,
					resolution,
				})),
			});
			ok(reservation);
			const handle = await bundle.contract.dispatchBatch(
				requests.map((request, index) => ({
					...request,
					reservation: { ownerId: reservation.ownerId, memberId: `task-${index + 1}` },
				})),
			);
			strictEqual(getDispatchReservation(reservation.ownerId)?.members.filter((member) => member.consumedAt).length, 2);
			await handle.finalPromise;
			const settled = getDispatchReservation(reservation.ownerId);
			strictEqual(settled?.status, "released");
			strictEqual(
				settled?.members.every((member) => member.status === "released"),
				true,
			);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("rolls back the whole unit after partial admission failure", async () => {
		const settings = settingsWithNode(2);
		const scheduling = schedulingFor(settings, 2);
		let spawnCount = 0;
		let resolveFirst: ((result: { exitCode: number; signal: null }) => void) | undefined;
		const firstDone = new Promise<{ exitCode: number; signal: null }>((resolve) => {
			resolveFirst = resolve;
		});
		const bundle = makeDispatchBundle(dispatchStubContext({ settings, scheduling }), {
			previewNode: () => ({ node: { id: "local", kind: "local" } }),
			spawnWorker: () => {
				spawnCount += 1;
				if (spawnCount === 2) throw new Error("second admission failed");
				return {
					pid: 200,
					promise: firstDone,
					events: (async function* () {
						yield { type: "message_end", message: { role: "assistant", content: "aborted", usage: { input: 1, output: 1 } } };
					})(),
					abort: () => resolveFirst?.({ exitCode: 1, signal: null }),
					heartbeatAt: { current: Date.now() },
				};
			},
		});
		await bundle.extension.start();
		try {
			const resolution = bundle.contract.preview?.({ agentId: "coder", executionRole: "builder", task: "one" });
			ok(resolution);
			const reservation = bundle.contract.reservations?.prepare({
				topology: "parallel",
				tasks: [1, 2].map((position) => ({ memberId: `task-${position}`, wave: 0, resolution })),
			});
			ok(reservation);
			await bundle.contract
				.dispatchBatch(
					[1, 2].map((position) => ({
						agentId: "coder",
						executionRole: "builder",
						task: `task ${position}`,
						reservation: { ownerId: reservation.ownerId, memberId: `task-${position}` },
					})),
				)
				.then(
					() => {
						throw new Error("batch unexpectedly admitted");
					},
					(error: unknown) => match(String(error), /second admission failed/),
				);
			strictEqual(getDispatchReservation(reservation.ownerId)?.status, "rolled_back");
		} finally {
			resolveFirst?.({ exitCode: 1, signal: null });
			await bundle.extension.stop?.();
		}
	});

	it("rolls back a parked plan when the operator cancels approval", async () => {
		const settings = settingsWithNode(1);
		const scheduling = schedulingFor(settings, 4);
		const bundle = makeDispatchBundle(dispatchStubContext({ settings, scheduling }), {
			previewNode: () => ({ node: { id: "mini", kind: "ssh", host: "mini.test" } }),
			resolveNode: remotePlacement,
		});
		await bundle.extension.start();
		try {
			const registry = createRegistry({
				safety: createWorkerSafety({ cwd: process.cwd() }),
				autonomy: () => "auto-edit",
			});
			registry.register(createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "auto-edit" }));
			let requestId = "";
			registry.onPermissionRequired((_call, _decision, meta) => {
				requestId = meta.requestId;
			});
			const pending = registry.invoke({
				tool: ToolNames.Dispatch,
				args: { tasks: ["one", "two"], mode: "sequential", node: "mini" },
			});
			await Promise.resolve();
			ok(requestId.length > 0);
			strictEqual(listDispatchReservations().filter((record) => record.status === "active").length, 1);
			registry.cancelParkedCall(requestId, "operator canceled plan");
			strictEqual((await pending).kind, "blocked");
			strictEqual(listDispatchReservations().filter((record) => record.status === "active").length, 0);
			strictEqual(listDispatchReservations()[0]?.status, "rolled_back");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("expires orphaned reservations on restart and makes release idempotent", async () => {
		const task = { memberId: "task-1", wave: 0, nodeId: "local", costUpperBoundUsd: 1 };
		const record = createDispatchReservation({
			topology: "parallel",
			tasks: [task],
			capacity: {
				global: { active: 0, limit: 1 },
				nodes: { local: { active: 0, limit: 1 } },
				budget: { currentUsd: 0, ceilingUsd: 5 },
			},
		});
		consumeDispatchReservation(record.ownerId, task.memberId);
		releaseDispatchReservationMember(record.ownerId, task.memberId);
		releaseDispatchReservationMember(record.ownerId, task.memberId);
		rollbackDispatchReservation(record.ownerId);
		strictEqual(
			getDispatchReservation(record.ownerId)?.status,
			"released",
			"settled release cannot be doubled or rolled back",
		);

		const orphan = createDispatchReservation({
			topology: "parallel",
			tasks: [{ ...task, memberId: "orphan" }],
			capacity: {
				global: { active: 0, limit: 1 },
				nodes: { local: { active: 0, limit: 1 } },
				budget: { currentUsd: 0, ceilingUsd: 5 },
			},
		});
		const bundle = makeDispatchBundle(dispatchStubContext());
		await bundle.extension.start();
		try {
			strictEqual(getDispatchReservation(orphan.ownerId)?.status, "expired");
			const second = createDispatchReservation({
				topology: "parallel",
				tasks: [{ ...task, memberId: "replacement" }],
				capacity: {
					global: { active: 0, limit: 1 },
					nodes: { local: { active: 0, limit: 1 } },
					budget: { currentUsd: 0, ceilingUsd: 5 },
				},
			});
			strictEqual(second.status, "active", "restart cleanup leaves capacity reusable");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("reserves sequential topologies per wave instead of holding every step at once", () => {
		// Three sequential steps on a capacity-one node: each runs in its own wave,
		// so the unit holds one slot, not three.
		const sequential = createDispatchReservation({
			topology: "sequential",
			tasks: [0, 1, 2].map((wave) => ({
				memberId: `task-${wave + 1}`,
				wave,
				nodeId: "local",
				costUpperBoundUsd: 0.5,
			})),
			capacity: CAPACITY_ONE_LOCAL,
		});
		strictEqual(sequential.status, "active");
		strictEqual(reservedCapacity().nodeSlots.local, 1);
		strictEqual(reservedCapacity().globalSlots, 1);
		rollbackDispatchReservation(sequential.ownerId);

		// The same three tasks in one parallel wave need three slots and are denied.
		let denial = "";
		try {
			createDispatchReservation({
				topology: "parallel",
				tasks: [0, 1, 2].map((index) => ({
					memberId: `task-${index + 1}`,
					wave: 0,
					nodeId: "local",
					costUpperBoundUsd: 0.5,
				})),
				capacity: CAPACITY_ONE_LOCAL,
			});
		} catch (error) {
			denial = error instanceof Error ? error.message : String(error);
		}
		// Denied as a unit, naming the aggregate (3) against the limit (1).
		match(denial, /capacity exceeded \(3\/1\)/);
	});

	it("reclaims a dead owner's reservation at startup while preserving a live sibling's", async () => {
		const capacity = {
			global: { active: 0, limit: 8 },
			nodes: { local: { active: 0, limit: 8 } },
			budget: { currentUsd: 0, ceilingUsd: 50 },
		};
		const dead = createDispatchReservation({
			topology: "parallel",
			tasks: [{ memberId: "dead-1", wave: 0, nodeId: "local", costUpperBoundUsd: 1 }],
			capacity,
		});
		const sibling = createDispatchReservation({
			topology: "parallel",
			tasks: [{ memberId: "live-1", wave: 0, nodeId: "local", costUpperBoundUsd: 1 }],
			capacity,
		});
		// Rewrite the owning pids: one process that cannot exist, one that does.
		const path = join(clioStateDir(), "dispatch-reservations.json");
		const store = JSON.parse(readFileSync(path, "utf8")) as {
			reservations: Array<{ ownerId: string; ownerPid: number }>;
		};
		for (const record of store.reservations) {
			// pid 1 is init: always alive, never this process.
			record.ownerPid = record.ownerId === dead.ownerId ? 0x7ffffffe : 1;
		}
		writeFileSync(path, JSON.stringify({ version: 1, reservations: store.reservations }, null, 2));

		const bundle = makeDispatchBundle(dispatchStubContext());
		await bundle.extension.start();
		try {
			strictEqual(getDispatchReservation(dead.ownerId)?.status, "expired", "a dead owner's capacity is reclaimed");
			strictEqual(getDispatchReservation(sibling.ownerId)?.status, "active", "a live sibling's capacity is preserved");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("admits a retry that changes target on the same node without re-consuming the member", async () => {
		const settings = twoTargetSettings();
		const scheduling = schedulingFor(settings, 4, 0, 50);
		let spawns = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings, scheduling }), {
			resilienceCooldownMs: 0,
			previewNode: () => ({ node: { id: "local", kind: "local" } }),
			spawnWorker: () => {
				spawns += 1;
				return spawns === 1
					? retryWorker({ exitCode: 1, signal: null, stderrTail: "HTTP 503 Service Unavailable" })
					: retryWorker({ exitCode: 0, signal: null }, "recovered on secondary");
			},
		});
		await bundle.extension.start();
		try {
			const request = { agentId: "coder", executionRole: "builder" as const, task: "target failover under reservation" };
			const resolution = bundle.contract.preview?.(request);
			ok(resolution);
			const reservation = bundle.contract.reservations?.prepare({
				topology: "parallel",
				tasks: [{ memberId: "task-1", wave: 0, resolution }],
			});
			ok(reservation);
			const handle = await bundle.contract.dispatch({
				...request,
				failover: "automatic",
				target: "primary",
				reservation: { ownerId: reservation.ownerId, memberId: "task-1" },
			});
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "succeeded");
			strictEqual(terminal.targetId, "secondary");
			strictEqual(spawns, 2);
			const settled = getDispatchReservation(reservation.ownerId);
			const member = settled?.members[0];
			ok(member);
			// Consumed once by the assignment, then released once when it settled.
			strictEqual(settled?.members.filter((entry) => entry.consumedAt !== null).length, 1);
			strictEqual(member.status, "released");
			strictEqual(settled?.status, "released");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("rebinds the member's node when a retry lands on a different node", async () => {
		const settings = twoTargetSettings();
		settings.fleet.nodes = [
			{ id: "mini", host: "mini.test", maxWorkers: 1 },
			{ id: "blade", host: "blade.test", maxWorkers: 1 },
		];
		const scheduling = schedulingFor(settings, 4, 0, 50);
		let placements = 0;
		let spawns = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings, scheduling }), {
			resilienceCooldownMs: 0,
			previewNode: () => ({ node: { id: "mini", kind: "ssh", host: "mini.test" } }),
			resolveNode: (): DispatchNodePlacement => {
				placements += 1;
				return placements === 1
					? { node: { id: "mini", kind: "ssh", host: "mini.test" }, release: () => {} }
					: { node: { id: "blade", kind: "ssh", host: "blade.test" }, release: () => {} };
			},
			spawnWorker: () => {
				spawns += 1;
				return spawns === 1
					? retryWorker({ exitCode: 255, signal: null, stderrTail: "ssh channel failed" })
					: retryWorker({ exitCode: 0, signal: null }, "recovered on blade");
			},
		});
		await bundle.extension.start();
		try {
			const request = { agentId: "coder", executionRole: "builder" as const, task: "node failover under reservation" };
			const resolution = bundle.contract.preview?.(request);
			ok(resolution);
			const reservation = bundle.contract.reservations?.prepare({
				topology: "parallel",
				tasks: [{ memberId: "task-1", wave: 0, resolution }],
			});
			ok(reservation);
			strictEqual(getDispatchReservation(reservation.ownerId)?.members[0]?.nodeId, "mini");
			const handle = await bundle.contract.dispatch({
				...request,
				failover: "automatic",
				node: "mini",
				reservation: { ownerId: reservation.ownerId, memberId: "task-1" },
			});
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "succeeded");
			strictEqual(terminal.node?.id, "blade");
			// The member's slot moved with the retry: mini is free, blade is held.
			strictEqual(getDispatchReservation(reservation.ownerId)?.members[0]?.nodeId, "blade");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("fails a rebind closed when the new node has no free slot", () => {
		const record = createDispatchReservation({
			topology: "parallel",
			tasks: [{ memberId: "task-1", wave: 0, nodeId: "local", costUpperBoundUsd: 1 }],
			capacity: CAPACITY_ONE_LOCAL,
		});
		const capacity = {
			global: { active: 0, limit: 4 },
			nodes: { local: { active: 0, limit: 1 }, blade: { active: 1, limit: 1 } },
			budget: { currentUsd: 0, ceilingUsd: 50 },
		};
		let denial = "";
		try {
			rebindDispatchReservationMember({
				ownerId: record.ownerId,
				memberId: "task-1",
				nodeId: "blade",
				costUpperBoundUsd: 1,
				capacity,
			});
		} catch (error) {
			denial = error instanceof Error ? error.message : String(error);
		}
		match(denial, /node 'blade' capacity exceeded \(2\/1\)/);
		// The member kept its original slot rather than escaping the reservation.
		strictEqual(getDispatchReservation(record.ownerId)?.members[0]?.nodeId, "local");
		strictEqual(reservedCapacity().nodeSlots.local, 1);
	});

	it("fails a rebind closed when the retry's estimate breaches the ceiling", () => {
		const record = createDispatchReservation({
			topology: "parallel",
			tasks: [{ memberId: "task-1", wave: 0, nodeId: "local", costUpperBoundUsd: 1 }],
			capacity: CAPACITY_ONE_LOCAL,
		});
		let denial = "";
		try {
			rebindDispatchReservationMember({
				ownerId: record.ownerId,
				memberId: "task-1",
				nodeId: "local",
				costUpperBoundUsd: 9,
				capacity: { global: { active: 0, limit: 4 }, nodes: {}, budget: { currentUsd: 1, ceilingUsd: 5 } },
			});
		} catch (error) {
			denial = error instanceof Error ? error.message : String(error);
		}
		match(denial, /aggregate budget exceeded/);
		strictEqual(getDispatchReservation(record.ownerId)?.members[0]?.costUpperBoundUsd, 1);
	});

	it("settles the assignment failed when a retry's rebind is denied", async () => {
		const settings = twoTargetSettings();
		settings.fleet.nodes = [
			{ id: "mini", host: "mini.test", maxWorkers: 1 },
			{ id: "blade", host: "blade.test", maxWorkers: 0 },
		];
		const scheduling = schedulingFor(settings, 4, 0, 50);
		let placements = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings, scheduling }), {
			resilienceCooldownMs: 0,
			previewNode: () => ({ node: { id: "mini", kind: "ssh", host: "mini.test" } }),
			resolveNode: (): DispatchNodePlacement => {
				placements += 1;
				return placements === 1
					? { node: { id: "mini", kind: "ssh", host: "mini.test" }, release: () => {} }
					: { node: { id: "blade", kind: "ssh", host: "blade.test" }, release: () => {} };
			},
			spawnWorker: () => retryWorker({ exitCode: 255, signal: null, stderrTail: "ssh channel failed" }),
		});
		await bundle.extension.start();
		try {
			const request = { agentId: "coder", executionRole: "builder" as const, task: "rebind denied" };
			const resolution = bundle.contract.preview?.(request);
			ok(resolution);
			const reservation = bundle.contract.reservations?.prepare({
				topology: "parallel",
				tasks: [{ memberId: "task-1", wave: 0, resolution }],
			});
			ok(reservation);
			const handle = await bundle.contract.dispatch({
				...request,
				failover: "automatic",
				node: "mini",
				reservation: { ownerId: reservation.ownerId, memberId: "task-1" },
			});
			strictEqual((await handle.finalPromise).outcome, "failed");
			const assignment = bundle.contract.assignments?.get(handle.runId);
			match(String(assignment?.outcomeDetail), /rebind denied/);
			// The member never escaped its reservation and is released exactly once.
			const settled = getDispatchReservation(reservation.ownerId);
			strictEqual(settled?.members[0]?.nodeId, "mini");
			strictEqual(settled?.members[0]?.status, "released");
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
