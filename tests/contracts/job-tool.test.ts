import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { JobCreateInput, JobOwner, JobRecord } from "../../src/core/job-types.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createJobController } from "../../src/domains/scheduling/job-controller.js";
import { jobIsComplete } from "../../src/domains/scheduling/job-model.js";
import type { JobController, JobRunnerPorts, JobStore } from "../../src/domains/scheduling/job-types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createJobRuntime } from "../../src/entry/job-runtime.js";
import { createJobTool } from "../../src/tools/job.js";
import { prepareJobCommand } from "../../src/tools/job-command.js";
import { createRegistry } from "../../src/tools/registry.js";
import type { IsolatedClioEnv } from "../harness/scratch-env.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function present<T>(value: T | null | undefined): T {
	ok(value !== undefined && value !== null);
	return value;
}

const settle = async (): Promise<void> => {
	await new Promise<void>((resolve) => setImmediate(resolve));
};

// An in-memory persistence seam lets the contract distinguish persisted admission
// from effects without introducing a second scheduler or wall-clock sleeps.
function memoryStore(): JobStore {
	const records = new Map<string, JobRecord>();
	return {
		list: (owner) =>
			[...records.values()]
				.filter((row) => row.owner.sessionId === owner.sessionId && row.owner.cwd === owner.cwd)
				.map((row) => structuredClone(row)),
		write(record, revision) {
			strictEqual(records.get(record.id)?.revision ?? null, revision);
			records.set(record.id, structuredClone(record));
		},
	};
}

describe("job ownership, scheduling and execution settlement", () => {
	let scratch: IsolatedClioEnv;
	let controller: JobController | undefined;
	let clock: number;
	let owner: JobOwner;
	let releaseOnCleanup: Array<() => void>;
	const input = (): JobCreateInput => ({ intervalMs: 1000, runner: { kind: "command", argv: ["node", "--version"] } });
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-job-contract-");
		clock = 100000;
		releaseOnCleanup = [];
		owner = { sessionId: "job-session", cwd: scratch.dir, generation: "generation-a" };
	});
	afterEach(async () => {
		for (const release of releaseOnCleanup) release();
		await controller?.close();
		controller = undefined;
		scratch.restore();
	});
	function make(
		ports: Partial<JobRunnerPorts> = {},
		store: JobStore = memoryStore(),
		monotonicNow?: () => number,
	): JobController {
		controller = createJobController({
			automatic: false,
			now: () => clock,
			...(monotonicNow === undefined ? {} : { monotonicNow }),
			store,
			ports: {
				isCurrent: (requested) =>
					requested.sessionId === owner.sessionId &&
					requested.cwd === owner.cwd &&
					requested.generation === owner.generation,
				admit: async () => ({ status: "ready" }),
				run: async (context) => {
					strictEqual(context.start(), true);
					return { outcome: "succeeded", json: { ready: false } };
				},
				deliver: async (context) => {
					strictEqual(context.start(), true);
					return { outcome: "succeeded" };
				},
				...ports,
			},
		});
		return controller;
	}
	it("defaults to five finite occurrences, first after the interval", async () => {
		const starts: number[] = [];
		const host = make({
			run: async (context) => {
				strictEqual(context.start(), true);
				starts.push(clock);
				return { outcome: "succeeded" };
			},
		});
		const created = await host.create(input(), owner);
		strictEqual(created.spec.count, 5);
		host.tick();
		await settle();
		strictEqual(starts.length, 0);
		for (let i = 1; i <= 5; i++) {
			clock = 100000 + i * 1000;
			host.tick();
			await settle();
		}
		deepStrictEqual(starts, [101000, 102000, 103000, 104000, 105000]);
		const final = present(host.get(created.id, owner));
		strictEqual(final.starts, 5);
		strictEqual(final.settled, 5);
		strictEqual(final.reason, "count");
		strictEqual(jobIsComplete(final), true);
		clock += 100000;
		host.tick();
		await settle();
		strictEqual(starts.length, 5);
	});
	it("coalesces missed ticks without overlapping a running occurrence", async () => {
		let finish: (() => void) | undefined;
		let running = 0;
		let maximum = 0;
		const host = make({
			run: async (context) => {
				strictEqual(context.start(), true);
				running++;
				maximum = Math.max(maximum, running);
				await new Promise<void>((resolve) => {
					finish = resolve;
					releaseOnCleanup.push(resolve);
				});
				running--;
				return { outcome: "succeeded" };
			},
		});
		const created = await host.create({ ...input(), count: 2 }, owner);
		clock += 1000;
		host.tick();
		await settle();
		strictEqual(running, 1);
		clock += 10000;
		host.tick();
		await settle();
		strictEqual(present(host.get(created.id, owner)).starts, 1);
		strictEqual(maximum, 1);
		present(finish)();
		await settle();
		clock += 1000;
		host.tick();
		await settle();
		strictEqual(maximum, 1);
		finish?.();
		await settle();
		strictEqual(present(host.get(created.id, owner)).starts, 2);
	});
	it("finishes the last counted run after navigation without delivering a stale match", async () => {
		let finish: (() => void) | undefined;
		const host = make({
			run: async (context) => {
				strictEqual(context.start(), true);
				await new Promise<void>((resolve) => {
					finish = resolve;
					releaseOnCleanup.push(resolve);
				});
				return { outcome: "succeeded", json: { ready: true } };
			},
		});
		const created = await host.create({ ...input(), count: 1, until: { path: ["ready"], op: "eq", value: true } }, owner);
		clock += 1000;
		host.tick();
		await settle();
		await host.retire(owner);
		present(finish)();
		await settle();
		const final = present(host.get(created.id, owner));
		strictEqual(final.reason, "count");
		strictEqual(final.settled, 1);
		strictEqual(final.delivery, null);
		strictEqual(jobIsComplete(final), true);
	});
	it("retries pending admission after a monotonic poll interval despite wall-clock rollback", async () => {
		let monotonic = 0;
		let ready = false;
		let admissions = 0;
		const host = make(
			{
				admit: async (context) => {
					if (context.phase !== "run") return { status: "ready" };
					admissions++;
					return ready ? { status: "ready" } : { status: "wait", reason: "host busy" };
				},
			},
			memoryStore(),
			() => monotonic,
		);
		const created = await host.create({ ...input(), count: 1 }, owner);
		clock += 1000;
		monotonic += 1000;
		host.tick();
		await settle();
		ready = true;
		clock -= 60000;
		monotonic += 249;
		host.tick();
		await settle();
		strictEqual(admissions, 1);
		monotonic++;
		host.tick();
		await settle();
		strictEqual(admissions, 2);
		strictEqual(jobIsComplete(present(host.get(created.id, owner))), true);
	});
	it("refuses another session's control without changing the owned job", async () => {
		const host = make();
		const created = await host.create(input(), owner);
		await rejects(host.control(created.id, "cancel", { ...owner, sessionId: "foreign" }));
		strictEqual(present(host.get(created.id, owner)).state, "active");
		strictEqual(present(host.get(created.id, owner)).cancelRequested, false);
	});
	it("keeps cancellation pending until the runner actually settles", async () => {
		let finish: (() => void) | undefined;
		let signal: AbortSignal | undefined;
		const host = make({
			run: async (context) => {
				strictEqual(context.start(), true);
				signal = context.signal;
				await new Promise<void>((resolve) => {
					finish = resolve;
					releaseOnCleanup.push(resolve);
				});
				return { outcome: "succeeded" };
			},
		});
		const created = await host.create(input(), owner);
		clock += 1000;
		host.tick();
		await settle();
		let settled = false;
		const cancel = host.control(created.id, "cancel", owner).then(() => {
			settled = true;
		});
		await settle();
		strictEqual(present(signal).aborted, true);
		strictEqual(settled, true);
		strictEqual(present(host.get(created.id, owner)).cancelRequested, true);
		strictEqual(jobIsComplete(present(host.get(created.id, owner))), false);
		present(finish)();
		await cancel;
		await settle();
		strictEqual(jobIsComplete(present(host.get(created.id, owner))), true);
		strictEqual(present(host.get(created.id, owner)).reason, "canceled");
	});
	it("does not execute when intent cannot be persisted", async () => {
		let effects = 0;
		const host = make(
			{
				run: async (context) => {
					context.start();
					effects++;
					return { outcome: "succeeded" };
				},
			},
			{
				list: () => [],
				write: () => {
					throw new Error("intent write failed");
				},
			},
		);
		await rejects(host.create(input(), owner), /intent write failed/);
		clock += 10000;
		host.tick();
		await settle();
		strictEqual(effects, 0);
	});
	it("suspends a failed success-settlement write without replacing the result with an infrastructure failure", async () => {
		const durable = memoryStore();
		let settlementAttempts = 0;
		const host = make(
			{},
			{
				list: durable.list,
				write(record, revision) {
					if (record.history.length > 0 && ++settlementAttempts === 1) throw new Error("settlement write failed");
					durable.write(record, revision);
				},
			},
		);
		const created = await host.create({ ...input(), count: 1 }, owner);
		clock += 1000;
		host.tick();
		await settle();
		clock += 10000;
		host.tick();
		await settle();
		strictEqual(settlementAttempts, 1);
		const stored = present(durable.list(owner)[0]);
		strictEqual(stored.history.length, 0);
		strictEqual(stored.active?.state, "running");
		const suspended = present(host.get(created.id, owner));
		strictEqual(suspended.revision, stored.revision);
		match(present(suspended.persistenceError), /settlement write failed/);
		strictEqual(jobIsComplete(suspended), false);
	});
	for (const action of ["deadline", "cancel", "timeout"] as const) {
		it(`aborts after a failed ${action} receipt without retrying writes or restarting recurrence`, async () => {
			const durable = memoryStore();
			let fail = false;
			let failedWrites = 0;
			let finish: (() => void) | undefined;
			let signal: AbortSignal | undefined;
			const host = make(
				{
					run: async (context) => {
						strictEqual(context.start(), true);
						signal = context.signal;
						await new Promise<void>((resolve) => {
							finish = resolve;
							releaseOnCleanup.push(resolve);
						});
						return { outcome: "succeeded" };
					},
				},
				{
					list: durable.list,
					write(record, revision) {
						if (fail) {
							failedWrites++;
							throw new Error("control write failed");
						}
						durable.write(record, revision);
					},
				},
			);
			const created = await host.create(
				{
					...input(),
					count: 3,
					...(action === "deadline" ? { deadlineAt: clock + 2000 } : {}),
					...(action === "timeout" ? { timeoutMs: 1000 } : {}),
				},
				owner,
			);
			clock += 1000;
			host.tick();
			await settle();
			fail = true;
			if (action === "cancel") await rejects(host.control(created.id, "cancel", owner), /control write failed/);
			else {
				clock += 1000;
				host.tick();
			}
			strictEqual(present(signal).aborted, true);
			for (let tick = 0; tick < 5; tick++) host.tick();
			strictEqual(failedWrites, 1);
			fail = false;
			present(finish)();
			await settle();
			clock += 10000;
			host.tick();
			await settle();
			const suspended = present(host.get(created.id, owner));
			strictEqual(suspended.starts, 1);
			strictEqual(suspended.history.length, 0);
			match(present(suspended.persistenceError), /control write failed/);
			strictEqual(jobIsComplete(suspended), false);
		});
	}
	it("recovers interrupted costs and exhausted counts without replacing a proven condition", async () => {
		const durable = memoryStore();
		const host = make({}, durable);
		const run = await host.create({ intervalMs: 1000, count: 1, runner: { kind: "main", prompt: "Respond yes" } }, owner);
		const matched = { ...input(), count: 1, until: { path: ["ready"], op: "eq" as const, value: true } };
		const delivery = await host.create({ ...matched, onMatch: { kind: "main_turn", prompt: "Analyze" } }, owner);
		const paused = await host.create(matched, owner);
		await host.close();
		for (const record of durable.list(owner)) {
			const revision = record.revision;
			record.revision++;
			record.process = { ...record.process, birthToken: "prior-process", instanceId: "prior-host" };
			record.starts = 1;
			record.reason = record.id === run.id ? null : "condition";
			record.state = record.id === run.id ? "active" : record.id === paused.id ? "paused" : "terminal";
			record.costUsd = 0.25;
			if (record.id === run.id)
				record.active = {
					id: "interrupted-run",
					scheduledAt: clock,
					startedAt: clock,
					endedAt: null,
					state: "running",
					evidence: null,
				};
			else
				record.delivery = {
					id: `${record.id}:delivery`,
					occurrenceId: "matched",
					kind: record.id === delivery.id ? "main_turn" : "notice",
					state: record.id === delivery.id ? "running" : "pending",
					createdAt: clock,
					startedAt: record.id === delivery.id ? clock : null,
					endedAt: null,
					reason: null,
					evidence: null,
				};
			durable.write(record, revision);
		}
		const recovered = make({}, durable);
		recovered.recover(owner);
		const interrupted = present(recovered.get(run.id, owner));
		strictEqual(interrupted.reason, "count");
		strictEqual(interrupted.history.at(-1)?.evidence?.outcome, "interrupted");
		strictEqual(interrupted.costUsd, null);
		const interruptedDelivery = present(recovered.get(delivery.id, owner));
		strictEqual(interruptedDelivery.delivery?.state, "failed");
		strictEqual(interruptedDelivery.costUsd, null);
		const proven = present(recovered.get(paused.id, owner));
		strictEqual(proven.reason, "condition");
		strictEqual(proven.delivery?.state, "dropped");
		strictEqual(proven.costUsd, 0.25);
		for (const job of [interrupted, interruptedDelivery, proven]) strictEqual(jobIsComplete(job), true);
	});
	it("blocks replacement runs and completion claims when command cleanup is unresolved", async () => {
		let effects = 0;
		const host = make({
			run: async (context) => {
				strictEqual(context.start(), true);
				effects++;
				return { outcome: "failed", cleanupUnresolved: true, summary: "process cleanup unresolved" };
			},
		});
		const created = await host.create(input(), owner);
		clock += 1000;
		host.tick();
		await settle();
		strictEqual(jobIsComplete(present(host.get(created.id, owner))), false);
		clock += 10000;
		host.tick();
		await settle();
		strictEqual(effects, 1);
		await rejects(host.control(created.id, "resume", owner), /cleanup/i);
		await host.control(created.id, "cancel", owner);
		strictEqual(jobIsComplete(present(host.get(created.id, owner))), false);
	});
	it("retains the deadline while matching analysis waits for main admission", async () => {
		let deliveries = 0;
		const host = make({
			admit: async (context) =>
				context.phase === "delivery" ? { status: "wait", reason: "operator turn active" } : { status: "ready" },
			run: async (context) => {
				strictEqual(context.start(), true);
				return { outcome: "succeeded", json: { status: "completed" } };
			},
			deliver: async () => {
				deliveries++;
				return { outcome: "succeeded" };
			},
		});
		const created = await host.create(
			{
				...input(),
				deadlineAt: clock + 5000,
				until: { path: ["status"], op: "eq", value: "completed" },
				onMatch: { kind: "main_turn", prompt: "Analyze the observed result" },
			},
			owner,
		);
		clock += 1000;
		host.tick();
		await settle();
		const pending = present(host.get(created.id, owner));
		strictEqual(pending.reason, "condition");
		strictEqual(pending.delivery?.state, "pending");
		strictEqual(jobIsComplete(pending), false);
		clock += 5000;
		host.tick();
		await settle();
		strictEqual(deliveries, 0);
		const expired = present(host.get(created.id, owner));
		strictEqual(jobIsComplete(expired), true);
		strictEqual(expired.delivery?.state, "dropped");
	});
	it("admits through the parent registry and refuses model-supplied authority", async () => {
		const host = make();
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: scratch.dir }) });
		const { spec } = createJobTool({
			controller: host,
			registry,
			owner: () => owner,
			constraints: () => undefined,
			hostRefusal: () => null,
		});
		registry.register(spec);
		const admitted = await registry.invoke(
			{ tool: ToolNames.Job, args: { action: "create", runner: "main", every_ms: 1000, prompt: "Respond yes" } },
			{ sessionId: owner.sessionId },
		);
		strictEqual(admitted.kind, "ok");
		if (admitted.kind !== "ok") throw new Error("job was not admitted");
		strictEqual(admitted.result.kind, "ok");
		strictEqual(host.list(owner).length, 1);
		const refused = await registry.invoke(
			{
				tool: ToolNames.Job,
				args: {
					action: "create",
					runner: "main",
					every_ms: 1000,
					prompt: "Respond yes",
					grants: ["all"],
					sessionId: "foreign",
				},
			},
			{ sessionId: owner.sessionId },
		);
		strictEqual(refused.kind, "ok");
		if (refused.kind !== "ok") throw new Error("malformed arguments never reached their diagnostic");
		strictEqual(refused.result.kind, "error");
		if (refused.result.kind === "error") match(refused.result.message, /unsupported field/);
		strictEqual(host.list(owner).length, 1);
	});
	it("does not turn job admission into permission for an unknown command", async () => {
		const host = make();
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: scratch.dir }) });
		const { spec } = createJobTool({
			controller: host,
			registry,
			owner: () => owner,
			constraints: () => undefined,
			hostRefusal: () => null,
		});
		registry.register(spec);
		const verdict = await registry.invoke(
			{
				tool: ToolNames.Job,
				args: { action: "create", runner: "command", every_ms: 1000, argv: [process.execPath, "-e", "process.exit(0)"] },
			},
			{ sessionId: owner.sessionId },
		);
		strictEqual(verdict.kind, "blocked");
		strictEqual(host.list(owner).length, 0);
	});
	it("waits for an operator decision before attestation, then refuses changed or missing executables", async () => {
		const host = make();
		let blocked = true;
		const runtime = createJobRuntime({
			chat: () => null,
			isCurrent: () => true,
			constraints: () => undefined,
			safety: createWorkerSafety({ cwd: scratch.dir }),
			autonomy: () => "default",
			hostRefusal: () => null,
			trustRefusal: () => null,
			permissionPending: () => blocked,
			runCommand: async () => {
				throw new Error("unattested command executed");
			},
			notice: () => {},
		});
		for (const change of ["changed", "missing"] as const) {
			blocked = true;
			const executable = join(scratch.dir, `job-${change}`);
			writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
			const job = await host.create({ ...input(), runner: prepareJobCommand([executable], scratch.dir) }, owner);
			if (change === "changed") writeFileSync(executable, "#!/bin/sh\nexit 1\n");
			else unlinkSync(executable);
			const abort = new AbortController();
			const context = {
				job,
				executionId: "blocked-occurrence",
				signal: abort.signal,
				start: () => {
					throw new Error("unattested occurrence started");
				},
			};
			strictEqual((await runtime.admit({ job, phase: "run", signal: abort.signal })).status, "wait");
			strictEqual((await runtime.run(context)).outcome, "deferred");
			for (const phase of ["create", "resume"] as const)
				strictEqual((await runtime.admit({ job, phase, signal: abort.signal })).status, "denied");
			blocked = false;
			strictEqual((await runtime.admit({ job, phase: "run", signal: abort.signal })).status, "denied");
			strictEqual((await runtime.run(context)).errorClass, "permission");
			blocked = true;
			abort.abort();
			const canceled = await runtime.admit({ job, phase: "run", signal: abort.signal });
			strictEqual(canceled.status, "denied");
			match(canceled.reason, /canceled before admission/);
		}
	});
	it("rejects unbounded or malformed timing and preserves explicit scope", async () => {
		const host = make();
		await rejects(host.create({ ...input(), intervalMs: 0 }, owner));
		await rejects(host.create({ ...input(), count: Number.NaN }, owner));
		const allowed = ["read"];
		const created = await host.create({ ...input(), constraints: { mode: "answer", allowedTools: allowed } }, owner);
		allowed.push("write");
		deepStrictEqual(created.spec.constraints?.allowedTools, ["read"]);
		match(created.specHash, /^[a-f0-9]{64}$/);
	});
});
