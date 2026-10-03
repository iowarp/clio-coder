import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { runCommandVector } from "../../src/core/safe-exec.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import { readAgentLedger } from "../../src/domains/dispatch/agent-ledger-store.js";
import { capacityLeaseUsage } from "../../src/domains/dispatch/capacity-lease.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { compileExecutionPlan } from "../../src/domains/dispatch/execution-plan.js";
import { executeFleetRun } from "../../src/domains/dispatch/fleet-run.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { getDispatchReservation } from "../../src/domains/dispatch/reservation-store.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import type { SchedulingContract } from "../../src/domains/scheduling/contract.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import type { IsolatedClioEnv } from "../harness/scratch-env.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
function controlledWorker() {
	const done = deferred<SpawnedWorkerResult>();
	let aborts = 0;
	const messages: unknown[] = [];
	const worker: SpawnedWorker = {
		pid: null,
		promise: done.promise,
		heartbeatAt: { current: Date.now(), monotonic: performance.now() },
		abort() {
			aborts += 1;
			done.resolve({ exitCode: null, signal: "SIGTERM" });
		},
		send(message) {
			messages.push(message);
			return true;
		},
		events: (async function* () {
			const outcome = await done.promise;
			if (outcome.exitCode === 0)
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: JSON.stringify({ confirmedFacts: [], missingEvidence: [], nextInspections: [] }),
					},
				};
		})(),
	};
	return {
		worker,
		messages,
		aborts: () => aborts,
		finish: (outcome: SpawnedWorkerResult = { exitCode: 0, signal: null }) => done.resolve(outcome),
	};
}
function isProgressEvent(value: unknown): value is { type: string; runId?: unknown } {
	return value !== null && typeof value === "object" && "type" in value && typeof value.type === "string";
}
function holdRetries(context: TestContext) {
	const set = globalThis.setTimeout;
	const clear = globalThis.clearTimeout;
	const callbacks = new Map<ReturnType<typeof setTimeout>, () => void>();
	context.mock.method(
		globalThis,
		"setTimeout",
		(callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
			if (delay !== 500 && delay !== 1000) return set(() => callback(...args), delay);
			const timer = set(() => {}, 0);
			clear(timer);
			callbacks.set(timer, () => callback(...args));
			return timer;
		},
	);
	context.mock.method(globalThis, "clearTimeout", (timer: ReturnType<typeof setTimeout>) => {
		if (!callbacks.delete(timer)) clear(timer);
	});
	return {
		callbacks,
		runNext() {
			const next = callbacks.entries().next().value;
			ok(next);
			callbacks.delete(next[0]);
			next[1]();
		},
	};
}

describe("dispatch member controls", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-member-controls-");
	});
	afterEach(() => scratch.restore());
	async function fixture(
		maxRetries = 0,
		onSpawn?: (worker: ReturnType<typeof controlledWorker>, count: number) => void,
	) {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = maxRetries;
		const workers: ReturnType<typeof controlledWorker>[] = [];
		const spawned = deferred<void>();
		const ctx = dispatchStubContext({ settings });
		const bundle = makeDispatchBundle(ctx, {
			spawnWorker: () => {
				const worker = controlledWorker();
				workers.push(worker);
				onSpawn?.(worker, workers.length);
				if (workers.length === 3) spawned.resolve();
				return worker.worker;
			},
		});
		await bundle.extension.start();
		const resolveWorkerPermission = bundle.contract.resolveWorkerPermission;
		ok(resolveWorkerPermission, "real dispatch must expose worker permission control");
		const stop = bundle.extension.stop;
		ok(stop, "real dispatch must expose lifecycle shutdown");
		const request: DispatchRequest = {
			agentId: "scout",
			executionRole: "researcher",
			task: "Inspect isolated fixture evidence.",
			cwd: scratch.dir,
			requestOrigin: "internal",
			resultContractOverride: { kind: "provenance-report" },
		};
		return {
			...bundle,
			contract: { ...bundle.contract, resolveWorkerPermission },
			workers,
			ctx,
			spawned,
			request,
			async stop() {
				for (const worker of workers) worker.finish();
				await stop.call(bundle.extension);
			},
		};
	}
	const lineage = { parentRunId: "fleet-root", rootRunId: "fleet-root", attempt: 0, depth: 1 };

	it("addresses three simultaneous members exactly and refuses their ambiguous fleet root", async () => {
		const f = await fixture();
		try {
			const handles = [];
			for (let i = 0; i < 3; i += 1) handles.push(await f.contract.dispatch({ ...f.request, lineage }));
			for (const operation of [
				() => f.contract.steer("fleet-root", "ambiguous"),
				() => f.contract.resolveWorkerPermission("fleet-root", "p", "approve"),
				() => f.contract.abort("fleet-root"),
			])
				throws(operation, /multiple fleet members/u);
			for (const [index, handle] of handles.entries()) {
				f.contract.steer(handle.runId, `guide-${index}`);
				f.contract.resolveWorkerPermission(handle.runId, `permission-${index}`, "approve");
			}
			for (const [index, worker] of f.workers.entries()) {
				const messages = worker.messages as Array<{ type: string; text?: string; requestId?: string }>;
				deepStrictEqual(
					messages.filter((message) => message.type === "steer").map((message) => message.text),
					[`guide-${index}`],
				);
				deepStrictEqual(
					messages.filter((message) => message.type === "permission_decision").map((message) => message.requestId),
					[`permission-${index}`],
				);
			}
			const second = handles[1];
			ok(second);
			f.contract.abort(second.runId);
			deepStrictEqual(
				f.workers.map((worker) => worker.aborts()),
				[0, 1, 0],
			);
			throws(() => f.contract.steer(second.runId, "too late"), /aborting|not active/u);
			throws(() => f.contract.resolveWorkerPermission(second.runId, "late", "approve"), /aborting|not active/u);
			f.workers[0]?.finish();
			f.workers[2]?.finish();
			const receipts = await Promise.all(handles.map((handle) => handle.finalPromise));
			deepStrictEqual(
				receipts.map((receipt) => receipt.outcome),
				["succeeded", "canceled", "succeeded"],
			);
			deepStrictEqual(
				receipts.map((receipt) => receipt.runId),
				handles.map((handle) => handle.runId),
			);
			for (const receipt of receipts) {
				const envelope = f.contract.getRun(receipt.runId);
				ok(envelope);
				strictEqual(verifyReceiptIntegrity(receipt, envelope).ok, true);
			}
		} finally {
			await f.stop();
		}
	});

	it("a terminal member does not forward controls to a live sibling or its higher attempt", async () => {
		const f = await fixture();
		try {
			const first = await f.contract.dispatch({ ...f.request, lineage });
			const second = await f.contract.dispatch({ ...f.request, lineage });
			f.workers[1]?.finish();
			await second.finalPromise;
			const retry = await f.contract.dispatch({
				...f.request,
				lineage: { ...lineage, parentRunId: second.runId, attempt: 1 },
			});
			f.contract.steer(first.runId, "first only");
			f.contract.resolveWorkerPermission(first.runId, "first", "deny");
			f.contract.abort(first.runId);
			deepStrictEqual(
				f.workers.map((worker) => worker.aborts()),
				[1, 0, 0],
			);
			await first.finalPromise;
			throws(() => f.contract.steer(first.runId, "stale"), /not active/u);
			throws(() => f.contract.resolveWorkerPermission(first.runId, "stale", "deny"), /not active/u);
			f.contract.abort(first.runId);
			strictEqual(f.workers[2]?.aborts(), 0);
			f.contract.steer(second.runId, "own continuation");
			f.contract.resolveWorkerPermission(retry.runId, "retry", "approve");
			f.contract.abort(second.runId);
			strictEqual(f.workers[2]?.aborts(), 1);
			strictEqual((await retry.finalPromise).outcome, "canceled");
			const messages = f.workers[2]?.messages as Array<{ type: string; text?: string }>;
			deepStrictEqual(
				messages.filter((message) => message.type === "steer").map((message) => message.text),
				["own continuation"],
			);
		} finally {
			await f.stop();
		}
	});

	it("assignment IDs still cancel a scheduled retry without changing its immutable failed receipt", async (context) => {
		const timers = holdRetries(context);
		const f = await fixture(1);
		const scheduled = deferred<void>();
		f.ctx.bus.on(BusChannels.DispatchProgress, (event) => {
			if (!isProgressEvent(event.event)) return;
			if (event.event.type === "retry_scheduled") scheduled.resolve();
		});
		try {
			const handle = await f.contract.dispatch(f.request);
			f.workers[0]?.finish({ exitCode: 1, signal: null, stderrTail: "HTTP 503 Service Unavailable" });
			await scheduled.promise;
			strictEqual(timers.callbacks.size, 1);
			throws(() => f.contract.steer(handle.runId, "queued"), /not active/u);
			f.contract.abort(handle.runId);
			strictEqual(timers.callbacks.size, 0);
			const receipt = await handle.finalPromise;
			strictEqual(receipt.outcome, "failed");
			strictEqual(f.contract.assignments?.get(handle.runId)?.status, "canceled");
			strictEqual(f.workers.length, 1);
		} finally {
			await f.stop();
		}
	});

	it("an original assignment addresses its live retry while an independent sibling continues", async (context) => {
		const timers = holdRetries(context);
		const f = await fixture(1);
		const scheduled = deferred<void>();
		const retryStarted = deferred<string>();
		f.ctx.bus.on(BusChannels.DispatchProgress, (event) => {
			if (!isProgressEvent(event.event)) return;
			if (event.event.type === "retry_scheduled") scheduled.resolve();
			if (event.event.type === "attempt_start") {
				ok(typeof event.event.runId === "string", "attempt_start must identify its attempt");
				retryStarted.resolve(event.event.runId);
			}
		});
		try {
			const first = await f.contract.dispatch(f.request);
			const second = await f.contract.dispatch(f.request);
			f.workers[0]?.finish({ exitCode: 1, signal: null, stderrTail: "HTTP 503 Service Unavailable" });
			await scheduled.promise;
			timers.runNext();
			const retryId = await retryStarted.promise;
			f.contract.steer(first.runId, "retry guidance");
			f.contract.resolveWorkerPermission(first.runId, "retry permission", "deny");
			f.contract.abort(first.runId);
			deepStrictEqual(
				f.workers.map((worker) => worker.aborts()),
				[0, 0, 1],
			);
			f.workers[1]?.finish();
			const [canceled, succeeded] = await Promise.all([first.finalPromise, second.finalPromise]);
			strictEqual(canceled.runId, retryId);
			strictEqual(canceled.outcome, "canceled");
			strictEqual(succeeded.outcome, "succeeded");
			strictEqual(f.contract.assignments?.getStored(retryId)?.assignmentId, first.runId);
		} finally {
			await f.stop();
		}
	});
	it("canceling a reserved fleet member preserves its sibling's scheduled retry and receipt", async (context) => {
		const timers = holdRetries(context);
		const f = await fixture(1);
		const retryStarted = deferred<string>();
		f.ctx.bus.on(BusChannels.DispatchProgress, (event) => {
			if (!isProgressEvent(event.event)) return;
			if (event.event.type === "attempt_start") {
				ok(typeof event.event.runId === "string", "attempt_start must identify its attempt");
				retryStarted.resolve(event.event.runId);
			}
		});
		try {
			const resolution = f.contract.preview?.(f.request);
			ok(resolution);
			const reservations = f.contract.reservations;
			ok(reservations);
			const reservation = reservations.prepare({
				topology: "parallel",
				tasks: ["first", "second"].map((memberId) => ({ memberId, wave: 0, resolution })),
			});
			const first = await f.contract.dispatch({
				...f.request,
				lineage,
				reservation: { ownerId: reservation.ownerId, memberId: "first" },
			});
			const second = await f.contract.dispatch({
				...f.request,
				lineage,
				reservation: { ownerId: reservation.ownerId, memberId: "second" },
			});
			f.workers[0]?.finish({ exitCode: 1, signal: null, stderrTail: "HTTP 503 Service Unavailable" });
			const firstReceipt = await first.finalPromise;
			f.workers[1]?.finish({ exitCode: 1, signal: null, stderrTail: "HTTP 503 Service Unavailable" });
			const secondReceipt = await second.finalPromise;
			strictEqual(timers.callbacks.size, 2);
			f.contract.abort(first.runId);
			strictEqual(timers.callbacks.size, 1);
			deepStrictEqual(
				f.contract.snapshot().retrying.map((run) => run.runId),
				[second.runId],
			);
			strictEqual(firstReceipt.outcome, "failed");
			strictEqual(secondReceipt.outcome, "failed");
			timers.runNext();
			const retryId = await retryStarted.promise;
			throws(() => f.contract.steer(first.runId, "stale sibling"), /not active/u);
			f.contract.steer(second.runId, "own retry");
			f.contract.abort(retryId);
			deepStrictEqual(
				f.workers.map((worker) => worker.aborts()),
				[0, 0, 1],
			);
		} finally {
			await f.stop();
		}
	});
	it("cancellation during retry startup reaches the handle that arrives afterward", async (context) => {
		const timers = holdRetries(context);
		let abort: () => void = () => {};
		const f = await fixture(1, (_worker, count) => {
			if (count === 3) abort();
		});
		const scheduled = deferred<void>();
		f.ctx.bus.on(BusChannels.DispatchProgress, (event) => {
			if (isProgressEvent(event.event) && event.event.type === "retry_scheduled") scheduled.resolve();
		});
		try {
			const first = await f.contract.dispatch(f.request);
			const second = await f.contract.dispatch(f.request);
			abort = () => f.contract.abort(first.runId);
			f.workers[0]?.finish({ exitCode: 1, signal: null, stderrTail: "HTTP 503 Service Unavailable" });
			await scheduled.promise;
			timers.runNext();
			const receipt = await first.finalPromise;
			strictEqual(receipt.outcome, "canceled");
			deepStrictEqual(
				f.workers.map((worker) => worker.aborts()),
				[0, 0, 1],
			);
			f.workers[1]?.finish();
			strictEqual((await second.finalPromise).outcome, "succeeded");
		} finally {
			await f.stop();
		}
	});

	for (const channel of ["missing", "closed"] as const) {
		it(`refuses a member's ${channel} control channel and preserves explicit timeout attribution`, async () => {
			const f = await fixture(0, (worker, count) => {
				if (count !== 2) return;
				if (channel === "missing") delete worker.worker.send;
				else worker.worker.send = () => false;
			});
			try {
				const first = await f.contract.dispatch({ ...f.request, lineage });
				const second = await f.contract.dispatch({ ...f.request, lineage });
				throws(() => f.contract.steer(second.runId, "guidance"), /no input channel|no longer accepts input/u);
				throws(
					() => f.contract.resolveWorkerPermission(second.runId, "permission", "approve"),
					/no input channel|no longer accepts input/u,
				);
				strictEqual(f.workers[0]?.messages.length, 0);
				f.contract.abort(second.runId, { cause: "timeout", detail: "explicit member deadline" });
				const receipt = await second.finalPromise;
				strictEqual(receipt.outcome, "canceled");
				match(receipt.outcomeDetail ?? "", /explicit member deadline/u);
				match(receipt.outcomeDetail ?? "", /worker process signal: SIGTERM/u);
				strictEqual(f.workers[0]?.aborts(), 0);
				f.workers[0]?.finish();
				await first.finalPromise;
				throws(() => f.contract.steer("unknown-run", "missing"), /not active/u);
				throws(() => f.contract.resolveWorkerPermission("unknown-run", "p", "deny"), /not active/u);
			} finally {
				await f.stop();
			}
		});
	}

	for (const parentKnown of [false, true]) {
		it(`independent repair members reject stale controls with ${parentKnown ? "a known different member" : "the fleet root"} as parent`, async () => {
			const f = await fixture();
			try {
				const resolution = f.contract.preview?.(f.request);
				const reservations = f.contract.reservations;
				ok(resolution);
				ok(reservations);
				const reservation = reservations.prepare({
					topology: "parallel",
					tasks: ["repair-a", "repair-b"].map((memberId) => ({ memberId, wave: 0, resolution })),
				});
				const a = await f.contract.dispatch({
					...f.request,
					lineage: { ...lineage, attempt: 1 },
					reservation: { ownerId: reservation.ownerId, memberId: "repair-a" },
				});
				const b = await f.contract.dispatch({
					...f.request,
					lineage: { ...lineage, parentRunId: parentKnown ? a.runId : lineage.parentRunId, attempt: parentKnown ? 2 : 1 },
					reservation: { ownerId: reservation.ownerId, memberId: "repair-b" },
				});
				f.contract.steer(b.runId, "exact B");
				f.workers[0]?.finish();
				const aReceipt = await a.finalPromise;
				throws(() => f.contract.steer(a.runId, "stale A"), /not active/u);
				throws(() => f.contract.resolveWorkerPermission(a.runId, "stale A", "approve"), /not active/u);
				f.contract.abort(a.runId);
				deepStrictEqual(
					f.workers.map((w) => w.aborts()),
					[0, 0],
				);
				f.workers[1]?.finish();
				const bReceipt = await b.finalPromise;
				deepStrictEqual([aReceipt.outcome, bReceipt.outcome], ["succeeded", "succeeded"]);
				for (const receipt of [aReceipt, bReceipt]) {
					const envelope = f.contract.getRun(receipt.runId);
					ok(envelope);
					strictEqual(verifyReceiptIntegrity(receipt, envelope).ok, true);
				}
			} finally {
				await f.stop();
			}
		});
	}

	it("canceling one repair's queued retry preserves its sibling's continuation", async (context) => {
		const timers = holdRetries(context);
		const f = await fixture(2);
		try {
			const resolution = f.contract.preview?.(f.request);
			const reservations = f.contract.reservations;
			ok(resolution);
			ok(reservations);
			const reservation = reservations.prepare({
				topology: "parallel",
				tasks: ["repair-a", "repair-b"].map((memberId) => ({ memberId, wave: 0, resolution })),
			});
			const handles = [];
			for (const memberId of ["repair-a", "repair-b"])
				handles.push(
					await f.contract.dispatch({
						...f.request,
						lineage: { ...lineage, attempt: 2 },
						reservation: { ownerId: reservation.ownerId, memberId },
					}),
				);
			for (const [i, handle] of handles.entries()) {
				f.workers[i]?.finish({ exitCode: 1, signal: null, stderrTail: "HTTP 503 Service Unavailable" });
				await handle.finalPromise;
			}
			const a = handles[0];
			const b = handles[1];
			ok(a);
			ok(b);
			strictEqual(timers.callbacks.size, 2);
			f.contract.abort(a.runId);
			deepStrictEqual(
				f.contract.snapshot().retrying.map((r) => r.runId),
				[b.runId],
			);
			const drainMember = f.contract.drainMember;
			ok(drainMember);
			await drainMember(a.runId);
			strictEqual(timers.callbacks.size, 1);
			const started = deferred<string>();
			f.ctx.bus.on(BusChannels.DispatchProgress, (event) => {
				if (isProgressEvent(event.event) && event.event.type === "attempt_start") {
					ok(typeof event.event.runId === "string");
					started.resolve(event.event.runId);
				}
			});
			timers.runNext();
			strictEqual(f.contract.getRun(await started.promise)?.lineage?.attempt, 3);
			f.contract.steer(b.runId, "own genuine retry");
			f.contract.abort(b.runId);
			await drainMember(b.runId);
			deepStrictEqual(
				f.workers.map((w) => w.aborts()),
				[0, 0, 1],
			);
			strictEqual((await a.finalPromise).outcome, "failed");
			strictEqual((await b.finalPromise).outcome, "failed");
		} finally {
			await f.stop();
		}
	});

	it("production fleet settles on a successful retry, runs its dependent planner and counts attempts and proposals", async (context) => {
		const timers = holdRetries(context);
		const workspaceRoot = join(scratch.dir, "workspace");
		// Dynamic tasks declare a write boundary, so #231's dependent must run
		// in an isolated repository where that boundary can be verified.
		const initialized = await runCommandVector("git", ["init", "--quiet", workspaceRoot], {
			cwd: scratch.dir,
			workspaceRoot: scratch.dir,
		});
		strictEqual(initialized.exitCode, 0);
		const f = await fixture(1, (worker, count) => {
			worker.worker.events = (async function* () {
				const outcome = await worker.worker.promise;
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: outcome.exitCode === 0 ? "stop" : "error",
						usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: count } },
						content: JSON.stringify(
							count === 4
								? {
										tasks: [{ id: "inspect", agent: "verifier", description: "Inspect evidence.", depends_on: [], writes: [] }],
									}
								: {
										verdict: "pass",
										checks: [{ name: "fixture evidence", passed: true, evidence: "Controlled worker completed." }],
									},
						),
					},
				};
			})();
			worker.finish(
				count === 1
					? { exitCode: 1, signal: null, stderrTail: "HTTP 503 Service Unavailable" }
					: { exitCode: 0, signal: null },
			);
		});
		f.ctx.bus.on(BusChannels.DispatchProgress, (event) => {
			if (isProgressEvent(event.event) && event.event.type === "retry_scheduled") timers.runNext();
		});
		const plan = compileExecutionPlan({
			topology: "sequential",
			rootTask: "retry and proposal costs",
			maxWorkers: 1,
			onFailure: "stop",
			steps: ["first", "planner"].map((id) => ({
				kind: "agent",
				id,
				dependencies: id === "first" ? [] : ["first"],
				agentId: "verifier",
				executionRole: "researcher",
				scope: "readonly",
				expectedResultContract: "verifier-report",
				requestedAuthority: "verification",
				approvedAuthority: "verification",
				task: id,
				...(id === "planner" ? { plan: { roster: ["verifier"], maxTasks: 1, proposals: true } } : {}),
			})),
		});
		try {
			const agents = f.ctx.getContract<AgentsContract>("agents");
			ok(agents);
			const outcome = await executeFleetRun({
				plan,
				dispatch: f.contract,
				agents,
				contractName: "member-retry",
				commands: null,
				workspaceRoot,
				fleetRootId: "fleet-retry-success",
				attributionEnabled: false,
			});
			strictEqual(outcome.result.results.get("first")?.succeeded, true);
			strictEqual(outcome.result.results.get("planner")?.succeeded, true);
			strictEqual(outcome.cleanRun, true);
			deepStrictEqual(outcome.result.skipped, []);
			strictEqual(f.workers.length, 5);
			deepStrictEqual(
				outcome.receipts.map((receipt) => receipt.outcome),
				["failed", "succeeded", "succeeded", "succeeded", "succeeded"],
			);
			strictEqual(new Set(outcome.receipts.map((receipt) => receipt.runId)).size, 5);
			strictEqual(outcome.result.results.get("first")?.terminalRunId, outcome.receipts[1]?.runId);
			strictEqual(outcome.result.results.get("planner")?.terminalRunId, outcome.receipts[3]?.runId);
			strictEqual(outcome.totalCost.calls, 5);
			ok(
				Math.abs(outcome.totalCost.knownUsd - 15) <= 1e-12,
				"total cost includes both attempts and the proposal within $1e-12",
			);
			for (const receipt of outcome.receipts) {
				const envelope = f.contract.getRun(receipt.runId);
				ok(envelope);
				strictEqual(verifyReceiptIntegrity(receipt, envelope).ok, true);
			}
			const stored = f.contract.assignments?.getStored(outcome.rootId);
			ok(stored);
			strictEqual(stored.status, "succeeded");
			for (const receipt of outcome.receipts) ok(stored.attempts.includes(receipt.runId));
		} finally {
			await f.stop();
		}
	});

	it("fleet proposals overlap within admitted capacity and retain roster order after failure", {
		timeout: 10_000,
	}, async () => {
		const started = Array.from({ length: 6 }, () => deferred<void>());
		const f = await fixture(0, (worker, count) => {
			worker.worker.events = (async function* () {
				const outcome = await worker.worker.promise;
				if (outcome.exitCode === 0)
					yield {
						type: "message_end",
						message: { role: "assistant", stopReason: "stop", content: `proposal-${count}` },
					};
			})();
			started[count - 1]?.resolve();
			if (count === 4) worker.finish({ exitCode: 1, signal: null });
		});
		const scheduling = f.ctx.getContract<SchedulingContract>("scheduling");
		ok(scheduling);
		scheduling.maxWorkers = () => 2;
		const roster = ["verifier", "architect", "tester"];
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "proposal order",
			maxWorkers: 4,
			onFailure: "stop",
			steps: [
				{
					kind: "agent",
					id: "planner",
					agentId: "verifier",
					executionRole: "researcher",
					scope: "readonly",
					expectedResultContract: "delegation-plan",
					requestedAuthority: "verification",
					approvedAuthority: "verification",
					dependencies: [],
					task: "Plan from proposals.",
					plan: { roster, maxTasks: 1, proposals: true },
				},
			],
		});
		let briefing: string | undefined;
		let ownerId: string | undefined;
		const dispatch = {
			...f.contract,
			async dispatch(...args: Parameters<typeof f.contract.dispatch>) {
				const [request] = args;
				ownerId ??= request.reservation?.ownerId;
				if (request.resultContractOverride?.kind === "delegation-plan") briefing = request.briefing;
				return f.contract.dispatch(...args);
			},
		};
		try {
			const agents = f.ctx.getContract<AgentsContract>("agents");
			ok(agents);
			const pending = executeFleetRun({
				plan,
				dispatch,
				agents,
				contractName: "proposals",
				commands: null,
				workspaceRoot: scratch.dir,
				fleetRootId: "fleet-proposals",
				attributionEnabled: false,
			});
			await started[1]?.promise;
			await setImmediate();
			strictEqual(f.workers.length, 2, "two proposals run before either settles; the third waits for capacity");
			strictEqual(capacityLeaseUsage().global, 2, "each active proposal owns a capacity lease");
			ok(ownerId);
			strictEqual(getDispatchReservation(ownerId)?.members.length, 4, "proposals and planner share the reservation");
			f.workers[1]?.finish();
			await started[2]?.promise;
			strictEqual(f.workers.length, 3, "the freed slot starts the third proposal while the first still runs");
			f.workers[2]?.finish({ exitCode: 1, signal: null });
			f.workers[0]?.finish();
			const outcome = await pending;
			strictEqual(
				briefing,
				"PROPOSAL verifier\nproposal-1\n\nPROPOSAL architect\nproposal-2\n\nPROPOSAL tester\n[proposal failed]",
			);
			deepStrictEqual(
				outcome.receipts.slice(0, 3).map((receipt) => receipt.agentId),
				roster,
			);
			for (const receipt of outcome.receipts.slice(0, 3)) {
				deepStrictEqual(receipt.lineage, {
					parentRunId: "fleet-proposals",
					rootRunId: "fleet-proposals",
					attempt: 0,
					depth: 1,
				});
				const envelope = f.contract.getRun(receipt.runId);
				ok(envelope);
				strictEqual(verifyReceiptIntegrity(receipt, envelope).ok, true);
			}
			strictEqual(getDispatchReservation(ownerId)?.status, "released");
			await f.contract.assignments?.flushWrites?.();
			await setImmediate();
			strictEqual(capacityLeaseUsage().global, 0);
			const controller = new AbortController();
			const canceled = executeFleetRun({
				plan,
				dispatch,
				agents,
				contractName: "proposals",
				commands: null,
				workspaceRoot: scratch.dir,
				fleetRootId: "fleet-proposals-cancel",
				attributionEnabled: false,
				signal: controller.signal,
			});
			const canceledResult = rejects(canceled);
			await started[5]?.promise;
			controller.abort();
			await canceledResult;
			deepStrictEqual(
				f.workers.slice(4).map((worker) => worker.aborts()),
				[1, 1],
			);
			strictEqual(f.workers.length, 6, "cancellation prevents the queued proposal and planner from launching");
			await f.contract.assignments?.flushWrites?.();
			await setImmediate();
			strictEqual(capacityLeaseUsage().global, 0);
		} finally {
			await f.stop();
		}
	});

	for (const phase of ["queued", "admitting", "running"] as const) {
		it(`production fleet stops on an exhausted sibling and drains its member's ${phase} retry before reservation and ledger release`, async (context) => {
			const timers = holdRetries(context);
			const initial = deferred<void>();
			const canceledPeer = deferred<void>();
			const canceledRetry = deferred<void>();
			const retryStarted = deferred<void>();
			const deliverFirst = deferred<void>();
			const cancellations: number[] = [];
			const f = await fixture(1, (worker, count) => {
				if (count === 3) initial.resolve();
				if (count === 2 || count > 3)
					worker.worker.abort = () => {
						cancellations.push(count);
						if (count === 2) canceledPeer.resolve();
						else canceledRetry.resolve();
					};
			});
			let ownerId: string | undefined;
			let ledgerId: string | undefined;
			const handles: Awaited<ReturnType<typeof f.contract.dispatch>>[] = [];
			const reservations = f.contract.reservations;
			ok(reservations);
			f.ctx.bus.on(BusChannels.DispatchProgress, (event) => {
				if (!isProgressEvent(event.event)) return;
				if (event.event.type === "retry_scheduled" && phase === "admitting") {
					timers.runNext();
					f.workers[2]?.finish({ exitCode: 1, signal: null, stderrTail: "[worker] fatal: WorkerSpec invalid" });
				}
				if (event.event.type === "attempt_start") retryStarted.resolve();
			});
			let returned = false;
			let released = false;
			const dispatch = {
				...f.contract,
				reservations: {
					...reservations,
					release(id: string) {
						strictEqual(f.contract.snapshot().running.length, 0);
						strictEqual(f.contract.snapshot().retrying.length, 0);
						ok(ledgerId);
						strictEqual(readAgentLedger(ledgerId)?.closedAt, null);
						released = true;
						return reservations.release(id);
					},
				},
				async dispatch(request: DispatchRequest) {
					ownerId ??= request.reservation?.ownerId;
					ledgerId ??= request.ledger?.id;
					const handle = await f.contract.dispatch(request);
					handles.push(handle);
					if (request.task === "first" && phase === "running") await deliverFirst.promise;
					return handle;
				},
			};
			const plan = compileExecutionPlan({
				topology: "parallel",
				rootTask: "retry ownership",
				maxWorkers: 3,
				onFailure: "stop",
				steps: ["first", "second", "exhausted"].map((id) => ({
					kind: "agent",
					id,
					dependencies: [],
					agentId: "verifier",
					executionRole: "researcher",
					scope: "readonly",
					expectedResultContract: "verifier-report",
					requestedAuthority: "verification",
					approvedAuthority: "verification",
					task: id,
				})),
			});
			try {
				const agents = f.ctx.getContract<AgentsContract>("agents");
				ok(agents);
				const pending = executeFleetRun({
					plan,
					dispatch,
					agents,
					contractName: "member-drain",
					commands: null,
					workspaceRoot: scratch.dir,
					fleetRootId: `fleet-${phase}`,
					attributionEnabled: false,
				});
				void pending.then(
					() => {
						returned = true;
					},
					() => {
						returned = true;
					},
				);
				await initial.promise;
				f.workers[0]?.finish({ exitCode: 1, signal: null, stderrTail: "HTTP 503 Service Unavailable" });
				if (phase !== "admitting") {
					const first = handles[0];
					ok(first);
					await first.finalPromise;
					strictEqual(cancellations.length, 0);
					if (phase === "running") {
						timers.runNext();
						await retryStarted.promise;
						deliverFirst.resolve();
					}
					f.workers[2]?.finish({ exitCode: 1, signal: null, stderrTail: "[worker] fatal: WorkerSpec invalid" });
				}
				await canceledPeer.promise;
				if (phase !== "queued") await canceledRetry.promise;
				strictEqual(timers.callbacks.size, 0);
				ok(ownerId);
				ok(ledgerId);
				strictEqual(getDispatchReservation(ownerId)?.status, "active");
				strictEqual(readAgentLedger(ledgerId)?.closedAt, null);
				strictEqual(returned, false);
				strictEqual(released, false);
				f.workers[1]?.finish({ exitCode: null, signal: "SIGTERM" });
				if (phase !== "queued") {
					// The peer's terminal is insufficient while the continuation is owned.
					const peer = handles[1];
					ok(peer);
					await peer.finalPromise;
					strictEqual(released, false);
					f.workers[3]?.finish({ exitCode: null, signal: "SIGTERM" });
				}
				const outcome = await pending;
				strictEqual(outcome.cleanRun, false);
				strictEqual(released, true);
				strictEqual(getDispatchReservation(ownerId)?.status, "released");
				ok(readAgentLedger(ledgerId)?.closedAt);
				deepStrictEqual(cancellations.sort(), phase === "queued" ? [2] : [2, 4]);
				const first = handles[0];
				ok(first);
				const receipt = await first.finalPromise;
				strictEqual(receipt.outcome, "failed");
				const envelope = f.contract.getRun(receipt.runId);
				ok(envelope);
				strictEqual(verifyReceiptIntegrity(receipt, envelope).ok, true);
			} finally {
				deliverFirst.resolve();
				await f.stop();
			}
		});
	}
});
