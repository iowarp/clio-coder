import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runEvalSuiteV2 } from "../../src/domains/eval/suites/run.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

for (const tamper of [false, true])
	test(`grader integrity: tamper=${tamper}`, async () => {
		const env = await isolateClioEnv("eval-integrity-");
		try {
			const workspace = join(env.dir, "workspace");
			mkdirSync(workspace);
			writeFileSync(join(workspace, "grader.cjs"), "process.exit(0)");
			const artifact = await runEvalSuiteV2(
				{
					path: join(env.dir, "suite.yaml"),
					baseDir: env.dir,
					hash: "a".repeat(64),
					suite: {
						version: 2,
						suite: { id: "integrity", title: "Integrity", visibility: "local" },
						matrix: { targets: [{ id: "fixture" }], repeats: 1 },
						tasks: [
							{
								id: "grader",
								tags: [],
								workspace: { kind: "temp-copy", path: workspace },
								runner: {
									kind: "external-command",
									command: tamper ? `printf 'process.exit(0) // tampered' > grader.cjs` : "true",
								},
								verify: { measure: ["node grader.cjs"], protectedFiles: ["grader.cjs"] },
								metrics: { collect: [] },
								timeoutMs: 5000,
							},
						],
					},
				},
				{ clioEntry: new URL("../../dist/cli/index.js", import.meta.url).pathname },
			);
			const result = artifact.results[0];
			assert.ok(result);
			assert.equal(result.pass, !tamper);
			assert.equal(result.verdict?.machinery, tamper ? "infrastructure_failure" : "ok");
			if (tamper) {
				assert.equal(result.failureClass, "grader_integrity");
				assert.equal(result.metrics["task.solved"], undefined);
			}
		} finally {
			env.restore();
		}
	});
