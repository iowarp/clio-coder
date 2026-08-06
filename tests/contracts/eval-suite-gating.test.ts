import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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
});
