import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";
import { validateEvalSuiteV2 } from "../../src/domains/eval/schema/validate.js";
import { loadV1TaskFileAsSuite } from "../../src/domains/eval/suites/load.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("contracts/eval suite v2", { concurrency: false }, () => {
	it("validates accepted and rejected suite v2 shapes", () => {
		const valid = validateEvalSuiteV2({
			version: 2,
			suite: { id: "contract", title: "Contract", visibility: "public" },
			matrix: { targets: [{ id: "local" }], repeats: 1 },
			tasks: [
				{
					id: "task",
					tags: ["contract"],
					workspace: { kind: "local", path: "." },
					runner: { kind: "external-command", commands: ['node -e "process.exit(0)"'] },
					verify: { assertions: [{ metric: "result.pass", op: "eq", value: true }] },
					metrics: { collect: ["latency.wallMs"] },
					timeoutMs: 5000,
				},
			],
		});
		strictEqual(valid.valid, true);

		const rejected = validateEvalSuiteV2({
			version: 2,
			suite: { id: "contract", title: "Contract", visibility: "public" },
			matrix: { targets: [{ id: "local" }], repeats: 1 },
			tasks: [
				{
					id: "task",
					tags: [],
					workspace: { kind: "local", path: "." },
					runner: { kind: "dispatch" },
					verify: {},
					metrics: { collect: [] },
					timeoutMs: 5000,
				},
			],
		});
		strictEqual(rejected.valid, false);
		if (rejected.valid) throw new Error("expected rejected suite");
		ok(rejected.issues.some((issue) => issue.path === "$.tasks[0].runner.kind"));
	});

	it("adapts v1 task files into the v2 suite model", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eval-v1-adapter-"));
		try {
			const taskFile = join(root, "tasks.yaml");
			writeFileSync(
				taskFile,
				[
					"version: 1",
					"tasks:",
					"  - id: legacy",
					"    prompt: legacy prompt",
					"    cwd: .",
					"    setup:",
					'      - node -e "process.exit(0)"',
					"    verifier:",
					'      - node -e "process.exit(0)"',
					"    timeoutMs: 5000",
					"    tags:",
					"      - legacy",
					"",
				].join("\n"),
				"utf8",
			);

			const loaded = await loadV1TaskFileAsSuite(taskFile, 2);
			strictEqual(loaded.suite.version, 2);
			strictEqual(loaded.suite.suite.provenance?.taskFileVersion, 1);
			strictEqual(loaded.suite.matrix.repeats, 2);
			strictEqual(loaded.suite.tasks[0]?.runner.kind, "external-command");
			strictEqual(loaded.suite.tasks[0]?.runner.commands?.length, 1);
			strictEqual(loaded.suite.tasks[0]?.verify.commands?.length, 1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runs the context-index runner end to end on this repo through the built CLI", async () => {
		const scratch = makeScratchHome();
		try {
			const suitePath = join(scratch.dir, "context-suite.yaml");
			writeFileSync(
				suitePath,
				[
					"version: 2",
					"suite:",
					"  id: contract-context",
					"  title: Contract context index",
					"  visibility: local",
					"matrix:",
					"  targets:",
					"    - id: local",
					"  repeats: 1",
					"tasks:",
					"  - id: context-index",
					"    tags:",
					"      - offline",
					"    workspace:",
					"      kind: local",
					`      path: ${JSON.stringify(REPO_ROOT)}`,
					"    runner:",
					"      kind: context-index",
					"    verify:",
					"      assertions:",
					"        - metric: context.indexedFiles",
					"          op: gt",
					"          value: 0",
					"    metrics:",
					"      collect:",
					"        - context.indexedFiles",
					"        - context.coverage",
					"        - context.structuralHash",
					"    timeoutMs: 120000",
					"",
				].join("\n"),
				"utf8",
			);

			const result = await runCli(["eval", "run", "--suite", suitePath], {
				env: scratch.env,
				cwd: REPO_ROOT,
				timeoutMs: 150_000,
			});
			strictEqual(result.code, 0, `stderr=${result.stderr}`);
			const artifact = readArtifact(scratch.env, evalIdFrom(result.stdout));
			strictEqual(artifact.version, 4);
			strictEqual(artifact.summary.passed, 1);
			const indexedFiles = artifact.results[0]?.metrics["context.indexedFiles"];
			if (typeof indexedFiles !== "number") throw new Error("context.indexedFiles metric missing");
			ok(indexedFiles > 0);
			const runnerOutput = artifact.results[0]?.artifacts.stdout;
			if (typeof runnerOutput !== "string") throw new Error("context-index stdout artifact missing");
			const runnerMetrics = JSON.parse(runnerOutput) as {
				indexedSourceFiles?: unknown;
				coverage?: unknown;
				structuralHash?: unknown;
			};
			strictEqual(indexedFiles, runnerMetrics.indexedSourceFiles);
			strictEqual(artifact.results[0]?.metrics["context.coverage"], runnerMetrics.coverage);
			strictEqual(artifact.results[0]?.metrics["context.structuralHash"], runnerMetrics.structuralHash);
			const digestTokens = artifact.results[0]?.metrics["context.digestTokens"];
			ok(typeof digestTokens === "number" && digestTokens > 0);
		} finally {
			scratch.cleanup();
		}
	});

	it("runs external-command suites, reports all formats, compares, and gates exit codes", async () => {
		const scratch = makeScratchHome();
		try {
			const workspace = join(scratch.dir, "workspace");
			mkdirSync(workspace, { recursive: true });
			const passSuite = writeExternalSuite(scratch.dir, "pass-suite.yaml", {
				id: "external-pass",
				command: `${process.execPath} -e ${JSON.stringify("require('fs').writeFileSync('result.txt', 'ok')")}`,
				verify: `${process.execPath} -e ${JSON.stringify("if (require('fs').readFileSync('result.txt', 'utf8') !== 'ok') process.exit(1)")}`,
			});
			const failSuite = writeExternalSuite(scratch.dir, "fail-suite.yaml", {
				id: "external-fail",
				command: `${process.execPath} -e ${JSON.stringify("process.exit(1)")}`,
				verify: `${process.execPath} -e ${JSON.stringify("process.exit(0)")}`,
			});

			const passRun = await runCli(["eval", "run", "--suite", passSuite], {
				env: scratch.env,
				cwd: scratch.dir,
				timeoutMs: 30_000,
			});
			strictEqual(passRun.code, 0, `stderr=${passRun.stderr}`);
			const passEvalId = evalIdFrom(passRun.stdout);
			const passArtifact = readArtifact(scratch.env, passEvalId);
			strictEqual(passArtifact.summary.failed, 0);
			strictEqual(passArtifact.results[0]?.metrics["verifier.exitCode"], 0);

			const failRun = await runCli(["eval", "run", "--suite", failSuite], {
				env: scratch.env,
				cwd: scratch.dir,
				timeoutMs: 30_000,
			});
			strictEqual(failRun.code, 1, `stderr=${failRun.stderr}`);
			const failEvalId = evalIdFrom(failRun.stdout);

			const text = await runCli(["eval", "report", passEvalId, "--format", "text"], { env: scratch.env });
			strictEqual(text.code, 0, `stderr=${text.stderr}`);
			ok(text.stdout.includes(`eval: ${passEvalId}`));

			const json = await runCli(["eval", "report", passEvalId, "--format", "json"], { env: scratch.env });
			strictEqual(json.code, 0, `stderr=${json.stderr}`);
			strictEqual((JSON.parse(json.stdout) as EvalArtifactV4).evalId, passEvalId);

			const md = await runCli(["eval", "report", passEvalId, "--format", "md"], { env: scratch.env });
			strictEqual(md.code, 0, `stderr=${md.stderr}`);
			ok(md.stdout.startsWith(`# Eval ${passEvalId}`));

			const swe = await runCli(["eval", "report", passEvalId, "--format", "swe-jsonl"], { env: scratch.env });
			strictEqual(swe.code, 0, `stderr=${swe.stderr}`);
			const sweRecord = JSON.parse(swe.stdout.trim()) as { instance_id?: unknown; status?: unknown };
			strictEqual(sweRecord.instance_id, "external-pass-task");
			strictEqual(sweRecord.status, "pass");

			const junit = await runCli(["eval", "report", passEvalId, "--format", "junit"], { env: scratch.env });
			strictEqual(junit.code, 0, `stderr=${junit.stderr}`);
			ok(junit.stdout.includes("<testsuite"));
			ok(junit.stdout.includes('failures="0"'));

			const compare = await runCli(["eval", "compare", passEvalId, failEvalId], { env: scratch.env });
			strictEqual(compare.code, 0, `stderr=${compare.stderr}`);
			ok(compare.stdout.includes("baseline"));
			const compareJson = await runCli(["eval", "compare", passEvalId, failEvalId, "--format", "json"], {
				env: scratch.env,
			});
			strictEqual(compareJson.code, 0, `stderr=${compareJson.stderr}`);
			strictEqual((JSON.parse(compareJson.stdout) as { hardGate?: { pass?: unknown } }).hardGate?.pass, true);
			const compareMarkdown = await runCli(["eval", "compare", passEvalId, failEvalId, "--format", "md"], {
				env: scratch.env,
			});
			strictEqual(compareMarkdown.code, 0, `stderr=${compareMarkdown.stderr}`);
			ok(compareMarkdown.stdout.startsWith("# Eval comparison"));
			const compareJunit = await runCli(["eval", "compare", passEvalId, failEvalId, "--format", "junit"], {
				env: scratch.env,
			});
			strictEqual(compareJunit.code, 0, `stderr=${compareJunit.stderr}`);
			ok(compareJunit.stdout.includes('<testsuite name="eval-comparison"'));

			const gatePass = await runCli(["eval", "gate", passEvalId, "--baseline", passEvalId], { env: scratch.env });
			strictEqual(gatePass.code, 0, `stderr=${gatePass.stderr}`);
			strictEqual(gatePass.stdout, "gate: pass\n");

			const gateFail = await runCli(["eval", "gate", failEvalId, "--baseline", passEvalId], { env: scratch.env });
			strictEqual(gateFail.code, 1, `stderr=${gateFail.stderr}`);
			ok(gateFail.stdout.startsWith("gate: fail"));

			// A thresholds file firing on a summary metric must fail the gate.
			const firingThresholds = join(scratch.dir, "firing-thresholds.yaml");
			writeFileSync(firingThresholds, "fail:\n  - metric: summary.passRate\n    op: lt\n    value: 2\n");
			const gateThresholdFail = await runCli(
				["eval", "gate", passEvalId, "--baseline", passEvalId, "--thresholds", firingThresholds],
				{ env: scratch.env },
			);
			strictEqual(gateThresholdFail.code, 1, `stderr=${gateThresholdFail.stderr}`);
			ok(gateThresholdFail.stdout.includes("summary.passRate"));

			// A receipt-derived evidence metric on a suite that produced no
			// receipt is unresolved and fails the gate closed: evidence can never
			// be asserted from absence (T20).
			const evidenceThresholds = join(scratch.dir, "evidence-thresholds.yaml");
			writeFileSync(evidenceThresholds, 'fail:\n  - metric: evidence.verification\n    op: neq\n    value: "verified"\n');
			const gateEvidenceUnresolved = await runCli(
				["eval", "gate", passEvalId, "--baseline", passEvalId, "--thresholds", evidenceThresholds],
				{ env: scratch.env },
			);
			strictEqual(gateEvidenceUnresolved.code, 1, `stderr=${gateEvidenceUnresolved.stderr}`);
			ok(gateEvidenceUnresolved.stdout.includes("evidence.verification"));
			ok(gateEvidenceUnresolved.stdout.includes("unresolved metric"));

			// An unresolvable metric fails closed instead of silently passing.
			const unknownThresholds = join(scratch.dir, "unknown-thresholds.yaml");
			writeFileSync(unknownThresholds, "fail:\n  - metric: summary.doesNotExist\n    op: gt\n    value: 0\n");
			const gateUnresolved = await runCli(
				["eval", "gate", passEvalId, "--baseline", passEvalId, "--thresholds", unknownThresholds],
				{ env: scratch.env },
			);
			strictEqual(gateUnresolved.code, 1, `stderr=${gateUnresolved.stderr}`);
			ok(gateUnresolved.stdout.includes("unresolved metric"));

			// A non-firing thresholds file keeps the gate green.
			const quietThresholds = join(scratch.dir, "quiet-thresholds.yaml");
			writeFileSync(quietThresholds, "fail:\n  - metric: summary.passRate\n    op: lt\n    value: 1\n");
			const gateThresholdPass = await runCli(
				["eval", "gate", passEvalId, "--baseline", passEvalId, "--thresholds", quietThresholds],
				{ env: scratch.env },
			);
			strictEqual(gateThresholdPass.code, 0, `stderr=${gateThresholdPass.stderr}`);
			strictEqual(gateThresholdPass.stdout, "gate: pass\n");

			const informationalThresholds = join(scratch.dir, "informational-thresholds.yaml");
			writeFileSync(
				informationalThresholds,
				"fail: []\ninformational:\n  - metric: summary.wallTimeMs\n    op: gte\n    value: 0\n",
			);
			const informationalGate = await runCli(
				["eval", "gate", passEvalId, "--baseline", passEvalId, "--thresholds", informationalThresholds],
				{ env: scratch.env },
			);
			strictEqual(informationalGate.code, 0, `stderr=${informationalGate.stderr}`);
			ok(informationalGate.stdout.includes("informational budgets: 1 notice"));
			ok(informationalGate.stdout.endsWith("gate: pass\n"));
		} finally {
			scratch.cleanup();
		}
	});
});

function writeExternalSuite(
	root: string,
	name: string,
	options: { id: string; command: string; verify: string },
): string {
	const path = join(root, name);
	writeFileSync(
		path,
		[
			"version: 2",
			"suite:",
			`  id: ${options.id}`,
			`  title: ${options.id}`,
			"  visibility: local",
			"matrix:",
			"  targets:",
			"    - id: local",
			"  repeats: 1",
			"tasks:",
			`  - id: ${options.id}-task`,
			"    tags:",
			"      - contract",
			"    workspace:",
			"      kind: local",
			"      path: workspace",
			"    runner:",
			"      kind: external-command",
			"      commands:",
			`        - ${JSON.stringify(options.command)}`,
			"    verify:",
			"      commands:",
			`        - ${JSON.stringify(options.verify)}`,
			"    metrics:",
			"      collect:",
			"        - latency.wallMs",
			"        - verifier.exitCode",
			"    timeoutMs: 10000",
			"",
		].join("\n"),
		"utf8",
	);
	return path;
}

function evalIdFrom(stdout: string): string {
	const found = /eval: (eval-[^\s]+)/.exec(stdout);
	if (found?.[1] === undefined) throw new Error(`eval id missing from stdout: ${stdout}`);
	return found[1];
}

function readArtifact(env: NodeJS.ProcessEnv, evalId: string): EvalArtifactV4 {
	const dataDir = env.CLIO_CODER_DATA_DIR;
	if (dataDir === undefined) throw new Error("scratch CLIO_CODER_DATA_DIR missing");
	return JSON.parse(readFileSync(join(dataDir, "evals", `${evalId}.json`), "utf8")) as EvalArtifactV4;
}
