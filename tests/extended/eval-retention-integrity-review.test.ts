import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runEvalSuiteV2 } from "../../src/domains/eval/suites/run.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

for (const mode of [
	"verifier-tamper",
	"ledger-symlink",
	"parent-symlink",
	"ledger-incomplete",
	"failed-incomplete",
	"integrity-incomplete",
] as const) {
	test(`eval review: ${mode}`, async () => {
		const env = await isolateClioEnv("eval-review-");
		try {
			const workspace = join(env.dir, "workspace");
			mkdirSync(workspace);
			writeFileSync(join(workspace, "grader.cjs"), "process.exit(0)");
			const outside = join(env.dir, "outside");
			mkdirSync(outside);
			writeFileSync(join(outside, "current.jsonl"), "OUTSIDE_ARTIFACT_SENTINEL");
			const script = `const fs=require('node:fs'), p=require('node:path');
const base=p.join(process.env.CLIO_CODER_STATE_DIR,'sessions','fixture'); fs.mkdirSync(base,{recursive:true});
const d=p.join(base,'session');
${mode === "parent-symlink" ? `fs.symlinkSync(${JSON.stringify(outside)},d);` : `fs.mkdirSync(d); ${mode === "ledger-symlink" ? `fs.symlinkSync(${JSON.stringify(join(outside, "current.jsonl"))},p.join(d,'current.jsonl'));` : `fs.writeFileSync(p.join(d,'current.jsonl.tmp'),'partial evidence');`}`}
console.log('runner evidence'); ${mode === "failed-incomplete" ? "process.exit(1);" : ""}`;
			writeFileSync(join(workspace, "runner.cjs"), script);
			const artifact = await runEvalSuiteV2(
				{
					path: join(env.dir, "suite.yaml"),
					baseDir: env.dir,
					hash: "a".repeat(64),
					suite: {
						version: 2,
						suite: { id: "review", title: "Review", visibility: "local" },
						matrix: { targets: [{ id: "fixture" }], repeats: 1 },
						tasks: [
							{
								id: mode,
								tags: [],
								workspace: { kind: "local", path: workspace },
								runner: { kind: "external-command", command: mode === "verifier-tamper" ? "true" : "node runner.cjs" },
								verify:
									mode === "verifier-tamper" || mode === "integrity-incomplete"
										? { protectedFiles: ["grader.cjs"], commands: ["printf 'tampered' > grader.cjs"] }
										: {},
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
			assert.equal(result.pass, false);
			assert.equal(result.verdict?.machinery, "infrastructure_failure");
			if (mode === "verifier-tamper") assert.equal(result.failureClass, "grader_integrity");
			else {
				assert.ok(Array.isArray(result.artifacts.sessionLedgerErrors));
				const paths = result.artifacts.sessionLedgers;
				assert.ok(Array.isArray(paths));
				if (mode.endsWith("incomplete")) {
					assert.equal(paths.length, 1);
					const path = paths[0];
					assert.ok(path);
					assert.equal(readFileSync(path, "utf8"), "partial evidence");
					assert.equal(statSync(path).mode & 0o777, 0o600);
					assert.equal(
						result.failureClass,
						mode === "failed-incomplete"
							? "runner_failed"
							: mode === "integrity-incomplete"
								? "grader_integrity"
								: "evidence_integrity",
					);
					const stdout = result.artifacts.runnerStdoutFile;
					assert.equal(typeof stdout, "string");
					assert.match(readFileSync(String(stdout), "utf8"), /runner evidence/);
				} else assert.equal(paths.length, 0);
				assert.ok(!JSON.stringify(result.artifacts).includes("OUTSIDE_ARTIFACT_SENTINEL"));
			}
		} finally {
			env.restore();
		}
	});
}
