import { match, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { DispatchNodePlacement } from "../../src/domains/dispatch/extension.js";
import {
	consumeDispatchReservation,
	createDispatchReservation,
	getDispatchReservation,
	listDispatchReservations,
	releaseDispatchReservationMember,
	rollbackDispatchReservation,
} from "../../src/domains/dispatch/reservation-store.js";
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
				{ agentId: "coder", task: "one" },
				{ agentId: "coder", task: "two" },
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
			const resolution = bundle.contract.preview?.({ agentId: "coder", task: "one" });
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
		const task = {
			memberId: "task-1",
			wave: 0,
			agentId: "coder",
			targetId: "primary",
			wireModelId: "batch-model",
			nodeId: "local",
			costUpperBoundUsd: 1,
		};
		const record = createDispatchReservation({
			topology: "parallel",
			tasks: [task],
			capacity: {
				global: { active: 0, limit: 1 },
				nodes: { local: { active: 0, limit: 1 } },
				budget: { currentUsd: 0, ceilingUsd: 5 },
			},
		});
		consumeDispatchReservation(record.ownerId, task.memberId, {
			agentId: task.agentId,
			target: task.targetId,
			model: task.wireModelId,
			node: task.nodeId,
		});
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
});
