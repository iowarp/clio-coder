import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { evaluateGate } from "../../src/domains/eval/compare/gates.js";
import type { EvalArtifactResultV4, EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";
import type { EvalMetricAssertion, EvalSuiteTaskV2, LoadedEvalSuiteV2 } from "../../src/domains/eval/schema/suite.js";
import { runEvalSuiteV2 } from "../../src/domains/eval/suites/run.js";

function loadedSuite(workspace: string, tasks: EvalSuiteTaskV2[]): LoadedEvalSuiteV2 {
	return {
		path: join(workspace, "suite.yaml"),
		baseDir: workspace,
		hash: "0".repeat(64),
		suite: {
			version: 2,
			suite: { id: "gating", title: "Gating", visibility: "local" },
			matrix: { targets: [{ id: "local" }], repeats: 1 },
			tasks,
		},
	};
}

function quietTask(id: string, assertions: EvalMetricAssertion[]): EvalSuiteTaskV2 {
	return {
		id,
		tags: ["offline"],
		workspace: { kind: "local", path: ".", excludes: [] },
		// Exits 0 and measures nothing. The machinery behaved; the assertions
		// below are the only thing under test.
		runner: { kind: "external-command", commands: [`${process.execPath} -e ""`], args: [] },
		verify: { commands: [], assertions, forbidPaths: [] },
		metrics: { collect: [] },
		timeoutMs: 15_000,
	};
}

function intact(taskId: string, repeatIndex: number): EvalArtifactResultV4 {
	return {
		assignmentId: null,
		terminalReceiptDigest: null,
		taskId,
		repeatIndex,
		target: { id: "mini", model: null, thinking: null },
		pass: true,
		failureClass: null,
		metrics: { "result.pass": true, "receipt.sealed": true, "receipt.integrityValid": true },
		artifacts: {},
	};
}

function brokenMetrics(): EvalArtifactResultV4["metrics"] {
	return { "result.pass": true, "receipt.sealed": true, "receipt.integrityValid": false };
}

function artifactWith(results: EvalArtifactResultV4[]): EvalArtifactV4 {
	const passed = results.filter((result) => result.pass).length;
	return {
		version: 4,
		evalId: "eval-gating",
		suite: { id: "gating", hash: "0".repeat(64) },
		clio: { version: "test", commit: null, entry: "dist/cli/index.js" },
		environment: { platform: "linux-x64", node: process.version },
		matrix: { target: "mini", model: null, thinking: null },
		summary: {
			runs: results.length,
			passed,
			failed: results.length - passed,
			passRate: results.length === 0 ? 0 : passed / results.length,
			tokens: { measured: false, runs: results.length, measuredRuns: 0 },
			wallTimeMs: 0,
		},
		results,
	};
}

describe("contracts/eval suite gating", { concurrency: false }, () => {
	it("fails a task assertion whose metric this run never produced", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "clio-eval-gating-"));
		try {
			const artifact = await runEvalSuiteV2(
				loadedSuite(workspace, [
					// `neq` is the shape that used to pass on absence: a missing metric
					// is not equal to anything, so an unmeasured run looked compliant.
					quietTask("unresolved", [{ metric: "receipt.integrityValid", op: "neq", value: false }]),
				]),
				{ clioEntry: join(workspace, "unused-entry.js") },
			);

			strictEqual(artifact.results[0]?.pass, false);
			strictEqual(artifact.results[0]?.failureClass, "assertion_unresolved");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("gates on a per-run invariant, naming the run that broke it", () => {
		const thresholds = { fail: [{ metric: "receipt.integrityValid", op: "eq" as const, value: false }] };

		const clean = evaluateGate(artifactWith([intact("solved", 0), intact("unsolved", 1)]), thresholds);
		strictEqual(clean.pass, true);

		// One run in a two-run matrix sealed a receipt its ledger cannot
		// authenticate. Whole-artifact aggregation would average it away.
		const broken = evaluateGate(
			artifactWith([intact("solved", 0), { ...intact("unsolved", 1), metrics: brokenMetrics() }]),
			thresholds,
		);
		strictEqual(broken.pass, false);
		strictEqual(broken.failures.length, 1);
		strictEqual(broken.failures[0]?.taskId, "unsolved");
		strictEqual(broken.failures[0]?.repeatIndex, 1);
		strictEqual(broken.failures[0]?.unresolved, false);
	});

	it("fails the gate closed when a run never measured the invariant at all", () => {
		const gate = evaluateGate(
			artifactWith([intact("measured", 0), { ...intact("silent", 1), metrics: { "result.pass": true } }]),
			{ fail: [{ metric: "receipt.sealed", op: "eq", value: false }] },
		);

		strictEqual(gate.pass, false);
		strictEqual(gate.failures.length, 1);
		strictEqual(gate.failures[0]?.unresolved, true);
		strictEqual(gate.failures[0]?.taskId, "silent");
	});

	it("fails the gate closed when the matrix produced no runs to read", () => {
		const gate = evaluateGate(artifactWith([]), {
			fail: [{ metric: "receipt.integrityValid", op: "eq", value: false }],
		});

		strictEqual(gate.pass, false);
		strictEqual(gate.failures[0]?.unresolved, true);
	});

	it("passes a task assertion the run actually measured", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "clio-eval-gating-measured-"));
		try {
			const artifact = await runEvalSuiteV2(
				loadedSuite(workspace, [quietTask("measured", [{ metric: "verifier.exitCode", op: "eq", value: 0 }])]),
				{ clioEntry: join(workspace, "unused-entry.js") },
			);

			strictEqual(artifact.results[0]?.pass, true);
			strictEqual(artifact.results[0]?.failureClass, null);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("records a failed task outcome without failing the item", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "clio-eval-measure-"));
		try {
			const task = quietTask("unsolved", []);
			task.verify.measure = [`${process.execPath} -e "process.exit(7)"`];

			const artifact = await runEvalSuiteV2(loadedSuite(workspace, [task]), {
				clioEntry: join(workspace, "unused-entry.js"),
			});

			// The model did not solve it. The machinery behaved, so the item passes
			// and the report carries both readings side by side.
			strictEqual(artifact.results[0]?.metrics["task.solved"], false);
			strictEqual(artifact.results[0]?.metrics["task.exitCode"], 7);
			strictEqual(artifact.results[0]?.pass, true);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("leaves the task outcome absent when a task declares no measure commands", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "clio-eval-unmeasured-outcome-"));
		try {
			const artifact = await runEvalSuiteV2(loadedSuite(workspace, [quietTask("silent", [])]), {
				clioEntry: join(workspace, "unused-entry.js"),
			});

			strictEqual("task.solved" in (artifact.results[0]?.metrics ?? {}), false);
			strictEqual("task.exitCode" in (artifact.results[0]?.metrics ?? {}), false);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("fails an item whose fixture setup never came up", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "clio-eval-setup-"));
		try {
			const task = quietTask("unseeded", []);
			task.workspace.setup = [`${process.execPath} -e "process.exit(1)"`];

			const artifact = await runEvalSuiteV2(loadedSuite(workspace, [task]), {
				clioEntry: join(workspace, "unused-entry.js"),
			});

			strictEqual(artifact.results[0]?.pass, false);
			strictEqual(artifact.results[0]?.failureClass, "setup_failed");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("runs setup in the prepared workspace before the runner sees it", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "clio-eval-setup-order-"));
		try {
			const task = quietTask("seeded", []);
			task.workspace.setup = [`${process.execPath} -e "require('fs').writeFileSync('seeded.txt','1')"`];
			task.runner = {
				kind: "external-command",
				commands: [`${process.execPath} -e "if(!require('fs').existsSync('seeded.txt'))process.exit(9)"`],
				args: [],
			};

			const artifact = await runEvalSuiteV2(loadedSuite(workspace, [task]), {
				clioEntry: join(workspace, "unused-entry.js"),
			});

			strictEqual(artifact.results[0]?.pass, true);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("passes the resolved absolute Clio entry to external-command runners", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "clio-eval-entry-env-"));
		try {
			const clioEntry = join(workspace, "resolved-clio-entry.js");
			const task = quietTask("entry-env", []);
			task.runner = {
				kind: "external-command",
				commands: [`${process.execPath} -e "if (process.env.CLIO_ENTRY !== '${clioEntry}') process.exit(12)"`],
				args: [],
			};

			const artifact = await runEvalSuiteV2(loadedSuite(workspace, [task]), { clioEntry });

			strictEqual(artifact.results[0]?.pass, true);
			strictEqual(artifact.results[0]?.failureClass, null);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
