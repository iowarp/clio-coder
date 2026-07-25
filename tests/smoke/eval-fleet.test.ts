import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

describe("clio eval and fleet smoke tests", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;

	beforeEach(() => {
		scratch = makeScratchHome();
	});

	afterEach(() => {
		scratch.cleanup();
	});

	it("eval report renders text and SWE JSONL from a current stored artifact", async () => {
		const dataDir = scratch.env.CLIO_DATA_DIR;
		if (dataDir === undefined) throw new Error("scratch CLIO_DATA_DIR missing");
		const evalDir = join(dataDir, "evals");
		mkdirSync(evalDir, { recursive: true });
		writeFileSync(
			join(evalDir, "eval-smoke.json"),
			`${JSON.stringify(
				{
					version: 3,
					evalId: "eval-smoke",
					suite: { id: "smoke", hash: "abc123" },
					clio: { version: "test", commit: null, entry: "dist/cli/index.js" },
					environment: { platform: "linux-x64", node: "v24.0.0" },
					matrix: { target: "local", model: null, thinking: null },
					summary: {
						runs: 1,
						passed: 1,
						failed: 0,
						passRate: 1,
						tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
						wallTimeMs: 12,
					},
					results: [
						{
							assignmentId: null,
							terminalReceiptDigest: null,
							taskId: "task-a",
							repeatIndex: 0,
							target: { id: "local", model: null, thinking: null },
							pass: true,
							failureClass: null,
							metrics: {},
							artifacts: { patch: "diff --git a/app.py b/app.py\n+print('ok')\n" },
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const text = await runCli(["eval", "report", "eval-smoke"], { env: scratch.env });
		strictEqual(text.code, 0, `stderr=${text.stderr}`);
		match(text.stdout, /eval: eval-smoke/);
		match(text.stdout, /passed: 1/);

		const jsonl = await runCli(["eval", "report", "eval-smoke", "--format", "swe-jsonl"], { env: scratch.env });
		strictEqual(jsonl.code, 0, `stderr=${jsonl.stderr}`);
		const parsed = JSON.parse(jsonl.stdout) as { instance_id: string; status: string; model_patch: string };
		strictEqual(parsed.instance_id, "task-a");
		strictEqual(parsed.status, "pass");
		match(parsed.model_patch, /diff --git/);
	});

	it("eval run --task-file stores provenance and redacted command output", async () => {
		const dataDir = scratch.env.CLIO_DATA_DIR;
		if (dataDir === undefined) throw new Error("scratch CLIO_DATA_DIR missing");
		const taskFile = join(scratch.dir, "provenance.yaml");
		const command = `${process.execPath} -e ${JSON.stringify(
			"console.log(process.env.HOME + '/artifact-path'); console.error('Authorization: Bearer secretsecretsecret')",
		)}`;
		writeFileSync(
			taskFile,
			[
				"version: 1",
				"tasks:",
				"  - id: provenance",
				"    prompt: local provenance smoke",
				"    cwd: .",
				"    setup: []",
				"    verifier:",
				`      - ${JSON.stringify(command)}`,
				"    timeoutMs: 5000",
				"    tags:",
				"      - provenance",
				"",
			].join("\n"),
			"utf8",
		);

		const result = await runCli(["eval", "run", "--task-file", taskFile], {
			env: { ...scratch.env, HOME: scratch.dir },
			cwd: scratch.dir,
			timeoutMs: 15_000,
		});
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		const evalId = /eval: (eval-[^\s]+)/.exec(result.stdout)?.[1];
		if (evalId === undefined) throw new Error(`eval id missing from stdout: ${result.stdout}`);
		const raw = readFileSync(join(dataDir, "evals", `${evalId}.json`), "utf8");
		ok(!raw.includes(scratch.dir), "stored eval artifact must not contain the raw scratch home");
		ok(!raw.includes("secretsecretsecret"), "stored eval artifact must redact credential-looking output");
		const parsed = JSON.parse(raw) as {
			version?: unknown;
			suite?: { id?: unknown; hash?: unknown };
			clio?: { version?: unknown; commit?: unknown; entry?: unknown };
			environment?: { platform?: unknown; node?: unknown };
			matrix?: { target?: unknown; model?: unknown; thinking?: unknown };
			results?: Array<{ artifacts?: { verifierStdout?: unknown; verifierStderr?: unknown } }>;
		};
		strictEqual(parsed.version, 3);
		strictEqual(parsed.suite?.id, "v1-task-file");
		strictEqual(typeof parsed.suite?.hash, "string");
		strictEqual(typeof parsed.clio?.version, "string");
		strictEqual(typeof parsed.clio?.entry, "string");
		strictEqual(typeof parsed.environment?.platform, "string");
		strictEqual(typeof parsed.environment?.node, "string");
		strictEqual(parsed.matrix?.target, "local");
		strictEqual(parsed.matrix?.model, null);
		strictEqual(parsed.matrix?.thinking, null);
		strictEqual(parsed.results?.[0]?.artifacts?.verifierStdout, "$HOME/artifact-path\n");
		strictEqual(parsed.results?.[0]?.artifacts?.verifierStderr, "Authorization: [redacted]\n");
	});

	it("fleet status --json is provider-free and reports an empty ledger", async () => {
		const result = await runCli(["fleet", "status", "--json"], { env: scratch.env });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		const parsed = JSON.parse(result.stdout) as {
			running: unknown[];
			retrying: unknown[];
			totals: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
		};
		strictEqual(Array.isArray(parsed.running), true);
		strictEqual(Array.isArray(parsed.retrying), true);
		strictEqual(parsed.running.length, 0);
		strictEqual(parsed.retrying.length, 0);
		strictEqual(parsed.totals.inputTokens, 0);
		strictEqual(parsed.totals.outputTokens, 0);
		strictEqual(parsed.totals.totalTokens, 0);
		strictEqual(parsed.totals.costUsd, 0);
	});
});
