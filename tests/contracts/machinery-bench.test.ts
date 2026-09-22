import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SCENARIOS as CONTEXT_BUDGET } from "../../evals/machinery/lib/context-budget.js";
import { SCENARIOS as CONTINUITY } from "../../evals/machinery/lib/continuity.js";
import { SCENARIOS as DISPATCH_ADMISSION } from "../../evals/machinery/lib/dispatch-admission.js";
import { SCENARIOS as MEMORY_SELECTION } from "../../evals/machinery/lib/memory-selection.js";
import {
	behaviorDigest,
	behaviorDocument,
	type MachineryScenario,
	measureLine,
} from "../../evals/machinery/lib/observation.js";
import { SCENARIOS as PROMPT_COMPILE } from "../../evals/machinery/lib/prompt-compile.js";
import { renderSuite, SUITE_DIR } from "../../evals/machinery/lib/suite-gen.js";
import { BASELINE_PIN, MACHINERY_SUITES, machineryTaskId } from "../../evals/machinery/lib/suites.js";

const IMPLEMENTATIONS: Record<string, Record<string, MachineryScenario>> = {
	"dispatch-admission": DISPATCH_ADMISSION,
	"prompt-compile": PROMPT_COMPILE,
	"context-budget": CONTEXT_BUDGET,
	"memory-selection": MEMORY_SELECTION,
	continuity: CONTINUITY,
};

interface CommittedBaseline {
	suite: string;
	pin: string[];
	tasks: Record<string, Record<string, unknown>>;
}

function committedBaseline(name: string): CommittedBaseline {
	return JSON.parse(readFileSync(join(SUITE_DIR, "baselines", `${name}.json`), "utf8")) as CommittedBaseline;
}

describe("machinery bench", () => {
	it("keeps every committed suite equal to what the table generates", () => {
		for (const suite of MACHINERY_SUITES) {
			const path = join(SUITE_DIR, `${suite.name}.yaml`);
			strictEqual(readFileSync(path, "utf8"), renderSuite(suite), `${suite.name}.yaml is stale; run suite-gen.ts`);
		}
	});

	it("pins exactly the two metrics that are a property of the harness", () => {
		// Wall time, RSS and CPU move with whatever else the machine is doing, so
		// pinning one would fail the check on a busier laptop and teach everyone
		// to ignore it. The driver does not even print them.
		deepStrictEqual(BASELINE_PIN, ["task.solved", "custom.digest.behavior"]);
		const printed = JSON.parse(measureLine("a".repeat(64))) as { metrics: Record<string, unknown> };
		deepStrictEqual(Object.keys(printed.metrics), ["custom.digest.behavior"]);
		for (const suite of MACHINERY_SUITES) {
			const yaml = readFileSync(join(SUITE_DIR, `${suite.name}.yaml`), "utf8");
			ok(yaml.includes(`  pin: [${BASELINE_PIN.join(", ")}]`), `${suite.name}.yaml pins a different metric list`);
			deepStrictEqual(committedBaseline(suite.name).pin, BASELINE_PIN);
		}
	});

	it("implements every declared scenario and declares every implemented one", () => {
		for (const suite of MACHINERY_SUITES) {
			const implemented = IMPLEMENTATIONS[suite.name];
			ok(implemented, `${suite.name} has no scenario module`);
			deepStrictEqual(Object.keys(implemented).sort(), [...suite.scenarios].sort(), suite.name);
			strictEqual(new Set(suite.scenarios).size, suite.scenarios.length, `${suite.name} declares a scenario twice`);
		}
		const ids = MACHINERY_SUITES.flatMap((suite) => suite.scenarios.map((name) => machineryTaskId(suite, name)));
		strictEqual(new Set(ids).size, ids.length, "task ids must be unique across the machinery suites");
	});

	it("records one committed baseline row per task", () => {
		for (const suite of MACHINERY_SUITES) {
			const baseline = committedBaseline(suite.name);
			strictEqual(baseline.suite, suite.id);
			deepStrictEqual(
				Object.keys(baseline.tasks).sort(),
				suite.scenarios.map((name) => machineryTaskId(suite, name)).sort(),
			);
			for (const [taskId, metrics] of Object.entries(baseline.tasks)) {
				deepStrictEqual(Object.keys(metrics).sort(), [...BASELINE_PIN].sort(), taskId);
				strictEqual(metrics["task.solved"], true, `${taskId} is recorded as unsolved`);
				ok(/^[0-9a-f]{64}$/.test(String(metrics["custom.digest.behavior"])), `${taskId} has no digest`);
			}
		}
	});

	it("fingerprints behavior and post-state without fingerprinting the run", () => {
		// The property the whole baseline rests on: two runs that did the same
		// thing at different times, in different scratch directories, digest the
		// same, while a changed observation moves the digest.
		const roots = [["/tmp", "<tmp>"]] as const;
		const first = behaviorDocument(
			"dispatch-admission",
			"worker-autonomy-ceiling",
			{
				facts: { at: "2026-01-01T00:00:00.000Z", cwd: "/tmp/clio-coder-machinery-abc123/run", resolved: "read-only" },
				failures: [],
			},
			roots,
		);
		const second = behaviorDocument(
			"dispatch-admission",
			"worker-autonomy-ceiling",
			{
				facts: { at: "2026-06-30T11:22:33.000Z", cwd: "/tmp/clio-coder-machinery-zzz999/run", resolved: "read-only" },
				failures: [],
			},
			roots,
		);
		strictEqual(behaviorDigest(first), behaviorDigest(second));
		const moved = behaviorDocument(
			"dispatch-admission",
			"worker-autonomy-ceiling",
			{
				facts: { at: "2026-01-01T00:00:00.000Z", cwd: "/tmp/clio-coder-machinery-abc123/run", resolved: "full-auto" },
				failures: [],
			},
			roots,
		);
		ok(behaviorDigest(moved) !== behaviorDigest(first), "a changed observation must move the digest");
		const failed = behaviorDocument(
			"dispatch-admission",
			"worker-autonomy-ceiling",
			{
				facts: { at: "2026-01-01T00:00:00.000Z", cwd: "/tmp/clio-coder-machinery-abc123/run", resolved: "read-only" },
				failures: ["a check"],
			},
			roots,
		);
		ok(behaviorDigest(failed) !== behaviorDigest(first), "a broken expectation must move the digest");
	});
});
