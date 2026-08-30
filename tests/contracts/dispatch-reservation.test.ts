import { match, ok, strictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { capacityStatePath, listCapacityLeases } from "../../src/domains/dispatch/capacity-lease.js";
import type { DispatchNodePlacement } from "../../src/domains/dispatch/extension.js";
import {
	createDispatchReservation,
	getDispatchReservation,
	listDispatchReservations,
	rebindDispatchReservationMember,
	releaseDispatchReservationMember,
	reservedCapacity,
	rollbackDispatchReservation,
	transferDispatchReservationToLease,
} from "../../src/domains/dispatch/reservation-store.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { createFleetRegistry } from "../../src/domains/scheduling/cluster.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import {
	DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT,
	resolvedDispatchPlanFromArgs,
} from "../../src/tools/dispatch-plan.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { mutationReport } from "../harness/gate-fabric.js";

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
		maxWorkers: () => maxWorkers,
	};
}

function remotePlacement(): DispatchNodePlacement {
	return { node: { id: "mini", kind: "ssh", host: "mini.test" } };
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
	endpoints: {},
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
			const tool = createDispatchTool({
				getAgentSpecs: () => [],
				dispatch: bundle.contract,
				getAutonomy: () => "full-auto",
			});
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
			const tool = createDispatchTool({
				getAgentSpecs: () => [],
				dispatch: bundle.contract,
				getAutonomy: () => "full-auto",
			});
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
					yield {
						type: "message_end",
						message: { role: "assistant", content: mutationReport("done"), usage: { input: 1, output: 1 } },
					};
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
			registry.register(
				createDispatchTool({ getAgentSpecs: () => [], dispatch: bundle.contract, getAutonomy: () => "auto-edit" }),
			);
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

	it("rolls back a prepared reservation exactly once when before_tool blocks dispatch", async () => {
		const settings = settingsWithNode(1);
		const scheduling = schedulingFor(settings, 4);
		const bundle = makeDispatchBundle(dispatchStubContext({ settings, scheduling }), {
			previewNode: () => ({ node: { id: "mini", kind: "ssh", host: "mini.test" } }),
			resolveNode: remotePlacement,
		});
		await bundle.extension.start();
		try {
			const dispatch = createDispatchTool({
				getAgentSpecs: () => [],
				dispatch: bundle.contract,
				getAutonomy: () => "full-auto",
			});
			const dispose = dispatch.disposeAdmissionArguments;
			let disposalCount = 0;
			dispatch.disposeAdmissionArguments = (args) => {
				disposalCount += 1;
				dispose?.(args);
			};
			const middleware = createMiddlewareBundle({
				ruleDefinitions: [
					{
						rule: {
							id: "test.block-prepared-dispatch",
							source: "builtin",
							description: "block dispatch after reservation preparation",
							enabled: true,
							hooks: ["before_tool"],
							effectKinds: ["block_tool"],
						},
						toolNames: [ToolNames.Dispatch],
						effects: [{ kind: "block_tool", reason: "test dispatch guard", severity: "hard-block" }],
					},
				],
			});
			const registry = createRegistry({
				safety: createWorkerSafety({ cwd: process.cwd() }),
				autonomy: () => "full-auto",
				middleware: middleware.contract,
			});
			registry.register(dispatch);

			const verdict = await registry.invoke({
				tool: ToolNames.Dispatch,
				args: { tasks: ["one", "two"], mode: "sequential", node: "mini" },
			});

			strictEqual(verdict.kind, "blocked");
			strictEqual(disposalCount, 1, "the prepared admission is disposed exactly once");
			strictEqual(listDispatchReservations().filter((record) => record.status === "active").length, 0);
			strictEqual(listDispatchReservations()[0]?.status, "rolled_back");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("disposes each prepared admission exactly once on blocked, successful, and throwing paths", async () => {
		const preparedArgs: Record<string, unknown>[] = [];
		const disposalCounts = new Map<Record<string, unknown>, number>();
		let runCount = 0;
		const spec: ToolSpec = {
			name: ToolNames.Read,
			description: "prepared admission cleanup probe",
			parameters: Type.Object({ mode: Type.String() }),
			baseActionClass: "read",
			prepareAdmissionArguments(args) {
				const prepared = { ...args, prepared: true };
				preparedArgs.push(prepared);
				return prepared;
			},
			disposeAdmissionArguments(args) {
				disposalCounts.set(args, (disposalCounts.get(args) ?? 0) + 1);
			},
			async run(args) {
				runCount += 1;
				if (args.mode === "throw") throw new Error("injected tool failure");
				return { kind: "ok", output: "done" };
			},
		};
		const middleware = createMiddlewareBundle({
			ruleDefinitions: [
				{
					rule: {
						id: "test.block-prepared-read",
						source: "builtin",
						description: "block one prepared cleanup probe",
						enabled: true,
						hooks: ["before_tool"],
						effectKinds: ["block_tool"],
					},
					toolNames: [ToolNames.Read],
					predicate: (input) => input.toolArgs?.mode === "block",
					effects: [{ kind: "block_tool", reason: "test cleanup guard", severity: "hard-block" }],
				},
			],
		});
		const registry = createRegistry({
			safety: createWorkerSafety({ cwd: process.cwd() }),
			middleware: middleware.contract,
		});
		registry.register(spec);

		strictEqual((await registry.invoke({ tool: ToolNames.Read, args: { mode: "block" } })).kind, "blocked");
		const success = await registry.invoke({ tool: ToolNames.Read, args: { mode: "success" } });
		strictEqual(success.kind, "ok");
		const failure = await registry.invoke({ tool: ToolNames.Read, args: { mode: "throw" } });
		strictEqual(failure.kind, "ok");
		ok(failure.kind === "ok" && failure.result.kind === "error");
		strictEqual(runCount, 2, "the blocked tool body never runs");
		strictEqual(preparedArgs.length, 3);
		for (const prepared of preparedArgs) {
			strictEqual(disposalCounts.get(prepared), 1, "each prepared object is disposed exactly once");
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
				endpoints: {},
				budget: { currentUsd: 0, ceilingUsd: 5 },
			},
		});
		transferDispatchReservationToLease({
			ownerId: record.ownerId,
			memberId: task.memberId,
			assignmentId: "assignment-1",
			nodeId: task.nodeId,
			limits: { global: 1, nodes: { local: 1 }, endpoints: {} },
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
				endpoints: {},
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
					endpoints: {},
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

	it("surfaces endpoint reservation saturation with the admission remedy", () => {
		const endpointKey = "http://mini:8080";
		let denial = "";
		try {
			createDispatchReservation({
				topology: "parallel",
				tasks: ["a", "b", "c"].map((memberId) => ({
					memberId,
					wave: 0,
					nodeId: "local",
					endpointKey,
					costUpperBoundUsd: 0,
				})),
				capacity: {
					global: { active: 0, limit: 4 },
					nodes: { local: { active: 0, limit: 4 } },
					endpoints: { [endpointKey]: { active: 1, limit: 1 } },
					budget: { currentUsd: 0, ceilingUsd: 5 },
				},
			});
		} catch (error) {
			denial = error instanceof Error ? error.message : String(error);
		}
		strictEqual(
			denial,
			"dispatch: admission denied: endpoint 'mini:8080' capacity reached (1/1 slots): the orchestrator's own turn holds one; collect in-flight runs or point workers at a second server",
		);
	});

	it("reclaims a dead owner's reservation at startup while preserving a live sibling's", async () => {
		const capacity = {
			global: { active: 0, limit: 8 },
			nodes: { local: { active: 0, limit: 8 } },
			endpoints: {},
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
		const path = capacityStatePath();
		const store = JSON.parse(readFileSync(path, "utf8")) as {
			version: 1;
			draining: boolean;
			leases: unknown[];
			reservations: Array<{ ownerId: string; ownerPid: number }>;
		};
		for (const record of store.reservations) {
			// pid 1 is init: always alive, never this process.
			record.ownerPid = record.ownerId === dead.ownerId ? 0x7ffffffe : 1;
		}
		writeFileSync(path, JSON.stringify(store, null, 2));

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
					: retryWorker({ exitCode: 0, signal: null }, mutationReport("recovered on secondary"));
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
					? { node: { id: "mini", kind: "ssh", host: "mini.test" } }
					: { node: { id: "blade", kind: "ssh", host: "blade.test" } };
			},
			spawnWorker: () => {
				spawns += 1;
				return spawns === 1
					? retryWorker({ exitCode: 255, signal: null, stderrTail: "ssh channel failed" })
					: retryWorker({ exitCode: 0, signal: null }, mutationReport("recovered on blade"));
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
			strictEqual(getDispatchReservation(reservation.ownerId)?.members[0]?.status, "released");
			strictEqual(
				listCapacityLeases().some((lease) => lease.assignmentId === handle.runId),
				false,
			);
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
			endpoints: {},
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
				capacity: {
					global: { active: 0, limit: 4 },
					nodes: {},
					endpoints: {},
					budget: { currentUsd: 1, ceilingUsd: 5 },
				},
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
					? { node: { id: "mini", kind: "ssh", host: "mini.test" } }
					: { node: { id: "blade", kind: "ssh", host: "blade.test" } };
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
