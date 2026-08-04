import { deepStrictEqual, rejects, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	compileExecutionPlan,
	type ExecutionPlanAgentStep,
	executionPlanWaves,
} from "../../src/domains/dispatch/execution-plan.js";
import {
	type ExecutionSchedulerAdapter,
	type ExecutionStepResult,
	executePlan,
} from "../../src/domains/dispatch/execution-scheduler.js";

const step = (id: string, dependencies: string[] = []): ExecutionPlanAgentStep => ({
	kind: "agent",
	id,
	dependencies,
	agentId: "coder",
	executionRole: "builder",
	scope: "workspace",
	expectedResultContract: "mutation-report",
	requestedAuthority: "workspace-edit",
	approvedAuthority: "workspace-edit",
	task: id,
});
const plan = (steps: ExecutionPlanAgentStep[], maxWorkers = 2, onFailure: "stop" | "continue" = "continue") =>
	compileExecutionPlan({ topology: "fleet", rootTask: "root", maxWorkers, onFailure, steps });

function adapter(
	outcomes: Record<string, boolean> = {},
): ExecutionSchedulerAdapter & { launched: string[]; canceled: string[]; released: string[] } {
	const launched: string[] = [],
		canceled: string[] = [],
		released: string[] = [];
	return {
		launched,
		canceled,
		released,
		preflight(value) {
			if (value.agentId === "impossible") throw new Error("impossible admission");
			return { step: value, costUpperBoundUsd: 1, nodeId: "local" };
		},
		reserve(_plan, admissions) {
			strictEqual(admissions.length > 0, true);
			return { ownerId: "reservation" };
		},
		async run(value, handoffs) {
			launched.push(value.id);
			deepStrictEqual(
				handoffs.map((item) => item.stepId),
				value.dependencies,
			);
			const succeeded = outcomes[value.id] ?? true;
			const result: ExecutionStepResult = {
				stepId: value.id,
				assignmentId: `assignment-${value.id}`,
				terminalRunId: `run-${value.id}`,
				receiptDigest: "a".repeat(64),
				output: value.id,
				succeeded,
				integrityValid: true,
			};
			return { assignmentId: result.assignmentId, result: Promise.resolve(result) };
		},
		cancel(id) {
			canceled.push(id);
		},
		release(id) {
			released.push(id);
		},
		releaseUnconsumed(id) {
			released.push(id);
		},
	};
}

describe("execution plan", () => {
	it("DAG validation rejects duplicate missing and cyclic dependencies", () => {
		throws(() => plan([step("a"), step("a")]), /duplicate/);
		throws(() => plan([step("a", ["missing"])]), /missing dependency/);
		throws(() => plan([step("a", ["b"]), step("b", ["a"])]), /cycle/);
	});
	it("maxWorkers deterministically splits a wide dependency level into waves", () =>
		deepStrictEqual(executionPlanWaves([step("a"), step("b"), step("c")], 2), [["a", "b"], ["c"]]));
	it("whole-plan preflight fails before any spawn when a late step is impossible", async () => {
		const fake = adapter();
		await rejects(() => executePlan(plan([step("a"), { ...step("late"), agentId: "impossible" }]), fake), /impossible/);
		deepStrictEqual(fake.launched, []);
	});
	it("whole-plan budget reservation uses every step upper bound", async () => {
		let total = 0;
		const fake = adapter();
		fake.reserve = (_p, rows) => {
			total = rows.reduce((sum, row) => sum + row.costUpperBoundUsd, 0);
			return { ownerId: "r" };
		};
		await executePlan(plan([step("a"), step("b")]), fake);
		strictEqual(total, 2);
	});
	it("dependent handoff uses the successful terminal retry receipt", async () => {
		const fake = adapter();
		let terminal = "";
		fake.run = async (value, handoffs) => {
			if (value.id === "b") terminal = handoffs[0]?.terminalRunId ?? "";
			const result: ExecutionStepResult = {
				stepId: value.id,
				assignmentId: `a-${value.id}`,
				terminalRunId: value.id === "a" ? "retry-terminal" : "b",
				receiptDigest: "b".repeat(64),
				output: "ok",
				succeeded: true,
				integrityValid: true,
			};
			return { assignmentId: result.assignmentId, result: Promise.resolve(result) };
		};
		await executePlan(plan([step("a"), step("b", ["a"])]), fake);
		strictEqual(terminal, "retry-terminal");
	});
	it("continue skips failed descendants and runs independent branches", async () => {
		const fake = adapter({ a: false });
		const result = await executePlan(plan([step("a"), step("child", ["a"]), step("independent")]), fake);
		deepStrictEqual(result.skipped, ["child"]);
		deepStrictEqual(fake.launched, ["a", "independent"]);
	});
	it("stop cancels only assignments owned by the plan", async () => {
		const fake = adapter({ a: false });
		await executePlan(plan([step("a"), step("later", ["a"])], 1, "stop"), fake);
		deepStrictEqual(fake.canceled, []);
	});
	it("cancellation releases all unconsumed reservations", async () => {
		const fake = adapter();
		const controller = new AbortController();
		controller.abort();
		await executePlan(plan([step("a")]), fake, controller.signal);
		strictEqual(fake.released.includes("reservation"), true);
	});
	it("version 4 seals authority grants and refuses a plan that lacks one", async () => {
		const granted = plan([step("a")]);
		const ungranted = compileExecutionPlan({
			topology: "fleet",
			rootTask: "root",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [{ ...step("a"), approvedAuthority: null }],
		});
		strictEqual(granted.version, 4);
		strictEqual(ungranted.version, 4);
		strictEqual(granted.hash === ungranted.hash, false);
		const fake = adapter();
		await rejects(() => executePlan(ungranted, fake), /lacks its requested authority grant/u);
		deepStrictEqual(fake.launched, []);
	});
	it("equal plans produce equal hashes and launch order", async () => {
		const a = plan([step("root"), step("left", ["root"]), step("right", ["root"])]);
		const b = plan([step("root"), step("left", ["root"]), step("right", ["root"])]);
		strictEqual(a.hash, b.hash);
		const fa = adapter(),
			fb = adapter();
		await executePlan(a, fa);
		await executePlan(b, fb);
		deepStrictEqual(fa.launched, fb.launched);
	});
});
