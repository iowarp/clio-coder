import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readAgentLedger } from "../../src/domains/dispatch/agent-ledger-store.js";
import { compileExecutionPlan, type ExecutionPlanAgentStep } from "../../src/domains/dispatch/execution-plan.js";
import {
	type ExecutionSchedulerAdapter,
	type ExecutionStepResult,
	executePlan,
} from "../../src/domains/dispatch/execution-scheduler.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const step = (id: string, dependencies: string[] = []): ExecutionPlanAgentStep => ({
	kind: "agent",
	id,
	dependencies,
	agentId: "scout",
	executionRole: "researcher",
	scope: "readonly",
	expectedResultContract: "provenance-report",
	requestedAuthority: "read-only",
	approvedAuthority: "read-only",
	task: `Inspect ${id}`,
});
const result = (id: string, succeeded = true): ExecutionStepResult => ({
	stepId: id,
	assignmentId: id,
	terminalRunId: `run-${id}`,
	receiptDigest: `digest-${id}`,
	output: `output-${id}`,
	succeeded,
	integrityValid: true,
});
const plan = (steps = [step("a"), step("b"), step("dependent", ["a", "b"])]) =>
	compileExecutionPlan({ topology: "parallel", rootTask: "Inspect fixtures", maxWorkers: 2, onFailure: "stop", steps });

function fixture() {
	type Handle = Awaited<ReturnType<ExecutionSchedulerAdapter["run"]>>;
	const launches = new Map<string, ReturnType<typeof deferred<Handle>>>();
	const entered = new Map(["a", "b", "dependent"].map((id) => [id, deferred<void>()]));
	const canceled = new Map(["a", "b"].map((id) => [id, deferred<void>()]));
	const log: string[] = [];
	let ledgerId: string | undefined;
	const adapter: ExecutionSchedulerAdapter = {
		preflight: (step) => ({ step, costUpperBoundUsd: 1, nodeId: "local" }),
		reserve: () => ({ ownerId: "owner" }),
		run: (step, _handoffs, _reservation, ledger) => {
			ledgerId = ledger?.id;
			log.push(`launch:${step.id}`);
			const launch = deferred<Awaited<ReturnType<ExecutionSchedulerAdapter["run"]>>>();
			launches.set(step.id, launch);
			entered.get(step.id)?.resolve();
			return launch.promise;
		},
		cancel: (id) => {
			log.push(`cancel:${id}`);
			canceled.get(id)?.resolve();
		},
		release: () => {
			log.push("release");
		},
		releaseUnconsumed: () => {
			log.push("release-unconsumed");
		},
	};
	return {
		adapter,
		launches,
		entered,
		canceled,
		log,
		ledger: () => (ledgerId === undefined ? null : readAgentLedger(ledgerId)),
	};
}

describe("execution scheduler lifecycle", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-scheduler-");
	});
	afterEach(() => scratch.restore());

	for (const late of [false, true]) {
		it(`owns sibling startup and terminal cleanup when rejection comes ${late ? "before" : "after"} its handle`, async () => {
			const f = fixture();
			const terminal = deferred<ExecutionStepResult>();
			const error = new Error("startup failed");
			const completed = executePlan(plan(), f.adapter);
			const rejection = rejects(completed, (observed) => observed === error);
			await f.entered.get("b")?.promise;
			if (!late) f.launches.get("a")?.resolve({ assignmentId: "a", result: terminal.promise });
			f.launches.get("b")?.reject(error);
			if (late) f.launches.get("a")?.resolve({ assignmentId: "a", result: terminal.promise });
			await f.canceled.get("a")?.promise;
			strictEqual(f.log.includes("release"), false);
			strictEqual(f.log.includes("release-unconsumed"), false);
			strictEqual(f.ledger()?.closedAt, null);
			terminal.resolve(result("a"));
			await rejection;
			deepStrictEqual(
				f.log.filter((line) => line.startsWith("cancel:")),
				["cancel:a"],
			);
			strictEqual(f.log.includes("launch:dependent"), false);
			ok(f.ledger()?.closedAt);
		});
	}

	for (const timing of ["before", "during", "after"] as const) {
		it(`cancels ${timing} startup without admitting a passing dependent`, async () => {
			const f = fixture();
			const controller = new AbortController();
			if (timing === "before") controller.abort();
			const terminal = deferred<ExecutionStepResult>();
			const execution = executePlan(plan([step("a"), step("dependent", ["a"])]), f.adapter, controller.signal);
			if (timing !== "before") {
				await f.entered.get("a")?.promise;
				if (timing === "during") controller.abort();
				f.launches.get("a")?.resolve({ assignmentId: "a", result: terminal.promise });
				if (timing === "after") {
					await Promise.resolve();
					controller.abort();
				}
				await f.canceled.get("a")?.promise;
				strictEqual(f.log.includes("release"), false);
				const receipt = result("a");
				terminal.resolve(receipt);
				const outcome = await execution;
				strictEqual(receipt.succeeded, true, "never alter the adapter's receipt projection");
				strictEqual(outcome.results.get("a")?.succeeded, false);
				strictEqual(outcome.results.get("a")?.receiptDigest, receipt.receiptDigest);
			} else await execution;
			strictEqual(f.log.includes("launch:dependent"), false);
			if (timing === "before")
				strictEqual(
					f.log.some((line) => line.startsWith("launch:")),
					false,
				);
		});
	}

	it("observes result rejection while sibling startup is pending and drains the late handle", async () => {
		const f = fixture();
		const terminal = deferred<ExecutionStepResult>();
		const sibling = deferred<ExecutionStepResult>();
		const failed = new Error("result rejected");
		const rejection = rejects(executePlan(plan(), f.adapter), (error) => error === failed);
		await f.entered.get("b")?.promise;
		f.launches.get("a")?.resolve({ assignmentId: "a", result: terminal.promise });
		await Promise.resolve();
		terminal.reject(failed);
		f.launches.get("b")?.resolve({ assignmentId: "b", result: sibling.promise });
		await f.canceled.get("b")?.promise;
		strictEqual(f.log.includes("release"), false);
		sibling.resolve(result("b", false));
		await rejection;
		ok(f.ledger()?.closedAt);
	});

	it("preserves primary startup and cleanup errors and attempts all releases", async () => {
		const f = fixture();
		const terminal = deferred<ExecutionStepResult>();
		const startup = new Error("primary startup");
		const cancel = new Error("cancel failed");
		const release = new Error("release failed");
		const unconsumed = new Error("unconsumed failed");
		const normalCancel = f.adapter.cancel;
		f.adapter.cancel = (id) => {
			normalCancel(id);
			throw cancel;
		};
		f.adapter.release = () => {
			f.log.push("release");
			throw release;
		};
		f.adapter.releaseUnconsumed = () => {
			f.log.push("release-unconsumed");
			throw unconsumed;
		};
		const rejection = rejects(executePlan(plan(), f.adapter), (error: unknown) => {
			ok(error instanceof AggregateError);
			strictEqual(error.cause, startup);
			deepStrictEqual(error.errors, [startup, cancel, unconsumed, release]);
			return true;
		});
		await f.entered.get("b")?.promise;
		f.launches.get("a")?.resolve({ assignmentId: "a", result: terminal.promise });
		f.launches.get("b")?.reject(startup);
		await f.canceled.get("a")?.promise;
		strictEqual(f.log.includes("release"), false);
		terminal.resolve(result("a"));
		await rejection;
		ok(f.ledger()?.closedAt);
	});

	it("preserves parallel successes, receipt handoffs, boundaries and downstream work", async () => {
		const f = fixture();
		const handoffs: string[] = [];
		f.adapter.run = async (step, upstream) => {
			handoffs.push(...upstream.map((item) => item.receiptDigest));
			return { assignmentId: step.id, result: Promise.resolve(result(step.id)) };
		};
		const boundaries: string[] = [];
		f.adapter.beginWriteBoundary = (window) => {
			boundaries.push(`begin:${window}`);
		};
		f.adapter.verifyWriteBoundary = async (window) => {
			boundaries.push(`verify:${window}`);
			return { window, violated: false, failedStepIds: [], detail: null };
		};
		const outcome = await executePlan(
			plan([{ ...step("a"), writes: [] }, { ...step("b"), writes: [] }, step("dependent", ["a", "b"])]),
			f.adapter,
		);
		deepStrictEqual([...outcome.results.keys()], ["a", "b", "dependent"]);
		deepStrictEqual(handoffs, ["digest-a", "digest-b"]);
		deepStrictEqual(boundaries, ["begin:wave-0", "verify:wave-0"]);
		strictEqual(
			f.log.some((line) => line.startsWith("cancel:")),
			false,
		);
	});
	it("normal stop cancels the failed member and live peers and preserves receipt diagnostics", async () => {
		const f = fixture();
		const a = deferred<ExecutionStepResult>();
		const b = deferred<ExecutionStepResult>();
		const saved: ExecutionStepResult[] = [];
		f.adapter.onStepSettled = (_step, result) => {
			saved.push(result);
		};
		const pending = executePlan(plan(), f.adapter);
		await f.entered.get("b")?.promise;
		f.launches.get("a")?.resolve({ assignmentId: "a", result: a.promise });
		f.launches.get("b")?.resolve({ assignmentId: "b", result: b.promise });
		a.resolve(result("a", false));
		await f.canceled.get("b")?.promise;
		deepStrictEqual(
			f.log.filter((line) => line.startsWith("cancel:")),
			["cancel:a", "cancel:b"],
		);
		b.resolve({ ...result("b", false), failureReason: "worker cancellation acknowledged" });
		await pending;
		strictEqual(saved.find((row) => row.stepId === "b")?.failureReason, "worker cancellation acknowledged");
		strictEqual(f.log.includes("launch:dependent"), false);
	});

	it("aborts code work and waits for its terminal result before releasing capacity", async () => {
		const f = fixture();
		const controller = new AbortController();
		const entered = deferred<AbortSignal>();
		const terminal = deferred<ExecutionStepResult>();
		f.adapter.runCode = async (_step, _handoffs, signal) => {
			entered.resolve(signal);
			return terminal.promise;
		};
		const p = compileExecutionPlan({
			topology: "sequential",
			rootTask: "code",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [
				{ kind: "code", id: "code", commandId: "fixture", scope: "readonly", dependencies: [] },
				step("dependent", ["code"]),
			],
		});
		const pending = executePlan(p, f.adapter, controller.signal);
		const signal = await entered.promise;
		controller.abort();
		strictEqual(signal.aborted, true);
		strictEqual(f.log.includes("release"), false);
		terminal.resolve(result("code"));
		const outcome = await pending;
		strictEqual(outcome.results.get("code")?.succeeded, false);
		strictEqual(f.log.includes("launch:dependent"), false);
	});

	it("startup cancellation never starts admitted code siblings", async () => {
		const f = fixture();
		const controller = new AbortController();
		const terminal = deferred<ExecutionStepResult>();
		let codeStarts = 0;
		f.adapter.runCode = async () => {
			codeStarts += 1;
			return result("code");
		};
		const p = compileExecutionPlan({
			topology: "parallel",
			rootTask: "mixed",
			maxWorkers: 2,
			onFailure: "stop",
			steps: [step("a"), { kind: "code", id: "code", commandId: "fixture", scope: "readonly", dependencies: [] }],
		});
		const pending = executePlan(p, f.adapter, controller.signal);
		await f.entered.get("a")?.promise;
		controller.abort();
		f.launches.get("a")?.resolve({ assignmentId: "a", result: terminal.promise });
		await f.canceled.get("a")?.promise;
		terminal.resolve(result("a"));
		await pending;
		strictEqual(codeStarts, 0);
	});

	it("checks write boundaries and records owned receipts even after sibling startup failure", async () => {
		const f = fixture();
		const terminal = deferred<ExecutionStepResult>();
		const log: string[] = [];
		f.adapter.beginWriteBoundary = () => {
			log.push("begin");
		};
		f.adapter.verifyWriteBoundary = async (window) => {
			log.push("verify");
			return { window, violated: true, failedStepIds: ["a"], detail: "outside declared boundary" };
		};
		f.adapter.onStepSettled = (_step, result) => {
			strictEqual(result.succeeded, false);
			strictEqual(result.boundaryViolated, true);
			strictEqual(result.receiptDigest, "digest-a");
			log.push("saved");
		};
		const p = plan([
			{ ...step("a"), writes: [] },
			{ ...step("b"), writes: [] },
		]);
		const rejection = rejects(executePlan(p, f.adapter), /startup/u);
		await f.entered.get("b")?.promise;
		f.launches.get("a")?.resolve({ assignmentId: "a", result: terminal.promise });
		f.launches.get("b")?.reject(new Error("startup"));
		await f.canceled.get("a")?.promise;
		terminal.resolve(result("a"));
		await rejection;
		deepStrictEqual(log, ["begin", "verify", "saved"]);
	});

	it("serializes declared writers until the preceding writer terminal settles", async () => {
		const f = fixture();
		const first = deferred<ExecutionStepResult>();
		const p = compileExecutionPlan({
			topology: "parallel",
			rootTask: "writers",
			maxWorkers: 2,
			writers: 1,
			onFailure: "stop",
			steps: [
				{ ...step("a"), scope: "workspace" },
				{ ...step("b"), scope: "workspace" },
			],
		});
		const pending = executePlan(p, f.adapter);
		await f.entered.get("a")?.promise;
		strictEqual(f.log.includes("launch:b"), false);
		f.launches.get("a")?.resolve({ assignmentId: "a", result: first.promise });
		await Promise.resolve();
		strictEqual(f.log.includes("launch:b"), false);
		first.resolve(result("a"));
		await f.entered.get("b")?.promise;
		f.launches.get("b")?.resolve({ assignmentId: "b", result: Promise.resolve(result("b")) });
		await pending;
	});

	it("preserves bounded code verification and repair loops", async () => {
		const f = fixture();
		const log: string[] = [];
		f.adapter.run = async (step) => {
			log.push(step.id);
			return { assignmentId: step.id, result: Promise.resolve(result(step.id)) };
		};
		f.adapter.runCode = async (step) => {
			log.push(step.id);
			return result(step.id, step.id !== "check-1");
		};
		const p = compileExecutionPlan({
			topology: "fleet",
			rootTask: "loop",
			maxWorkers: 1,
			onFailure: "stop",
			loops: [
				{ id: "loop", checkKind: "code", maxAttempts: 2, checkStepIds: ["check-1", "check-2"], repairStepIds: ["repair"] },
			],
			steps: [
				{
					kind: "code",
					id: "check-1",
					commandId: "check",
					scope: "readonly",
					dependencies: [],
					loop: { loopId: "loop", role: "check", attempt: 1 },
				},
				{ ...step("repair", ["check-1"]), loop: { loopId: "loop", role: "repair", attempt: 1 } },
				{
					kind: "code",
					id: "check-2",
					commandId: "check",
					scope: "readonly",
					dependencies: ["repair"],
					loop: { loopId: "loop", role: "check", attempt: 2 },
				},
				step("dependent", ["check-2"]),
			],
		});
		const outcome = await executePlan(p, f.adapter);
		deepStrictEqual(log, ["check-1", "repair", "check-2", "dependent"]);
		strictEqual(outcome.loops[0]?.resolved, true);
		strictEqual(outcome.loops[0]?.attempts, 2);
	});

	it("admission failure launches no work, and invalid replay releases the reservation", async () => {
		const f = fixture();
		f.adapter.preflight = () => {
			throw new Error("admission denied");
		};
		await rejects(executePlan(plan(), f.adapter), /admission denied/u);
		deepStrictEqual(f.log, []);
		const replay = fixture();
		replay.adapter.replayed = new Map([["a", result("a", false)]]);
		await rejects(executePlan(plan(), replay.adapter), /not a completed successful step/u);
		deepStrictEqual(replay.log, ["release-unconsumed", "release"]);
	});
	it("canceled agent verification cannot publish a passing loop decision", async () => {
		const f = fixture();
		const controller = new AbortController();
		const terminal = deferred<ExecutionStepResult>();
		let decisions = 0;
		f.adapter.decideLoop = async () => {
			decisions += 1;
			return { resolved: true, findings: null };
		};
		const p = compileExecutionPlan({
			topology: "fleet",
			rootTask: "agent gate",
			maxWorkers: 1,
			onFailure: "stop",
			loops: [{ id: "gate", checkKind: "agent", maxAttempts: 1, checkStepIds: ["a"], repairStepIds: [] }],
			steps: [{ ...step("a"), loop: { loopId: "gate", role: "check", attempt: 1 } }, step("dependent", ["a"])],
		});
		const pending = executePlan(p, f.adapter, controller.signal);
		await f.entered.get("a")?.promise;
		controller.abort();
		f.launches.get("a")?.resolve({ assignmentId: "a", result: terminal.promise });
		await f.canceled.get("a")?.promise;
		terminal.resolve(result("a"));
		const outcome = await pending;
		strictEqual(decisions, 0);
		strictEqual(outcome.loops[0]?.resolved, false);
		strictEqual(f.log.includes("launch:dependent"), false);
	});

	it("revalidates stale code verification before a dependent consumes its handoff", async () => {
		const f = fixture();
		let checks = 0;
		const log: string[] = [];
		f.adapter.run = async (step) => {
			log.push(step.id);
			return { assignmentId: step.id, result: Promise.resolve(result(step.id)) };
		};
		f.adapter.runCode = async (step) => {
			checks += 1;
			log.push(step.id);
			return result(step.id);
		};
		const p = compileExecutionPlan({
			topology: "fleet",
			rootTask: "staleness",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [
				{ kind: "code", id: "verify", commandId: "verify", scope: "readonly", dependencies: [], verification: true },
				{ ...step("mutate", ["verify"]), scope: "workspace" },
				step("dependent", ["mutate"]),
			],
		});
		const outcome = await executePlan(p, f.adapter);
		strictEqual(checks, 2);
		deepStrictEqual(log, ["verify", "mutate", "verify", "dependent"]);
		deepStrictEqual(outcome.revalidated, ["verify"]);
	});
});
