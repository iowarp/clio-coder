import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readRunJournal, receiptInvariantMetrics } from "../../src/domains/eval/metrics/invariants.js";
import type { EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";
import {
	closeServer,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const CLI = new URL("../../dist/cli/index.js", import.meta.url).pathname;

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
		execFile(
			process.execPath,
			[CLI, ...args],
			{ cwd, env, timeout: 40_000, maxBuffer: 2_000_000 },
			(error, stdout, stderr) => {
				if (error && typeof error.code !== "number") {
					reject(error);
					return;
				}
				resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
			},
		);
	});
}

for (const scenario of ["clean", "recovered", "terminal-error"] as const) {
	test(`built headless artifact and eval: ${scenario}`, async () => {
		const scratch = makeScratchHome("clio-headless-artifact-");
		const fixture = await startOpenAICompatFixture("unexpected follow-up", {
			toolCall: { name: "artifact", arguments: { kind: "report", content: "fixture report\n" } },
			...(scenario === "clean"
				? {}
				: {
						initialErrors: {
							count: 1,
							status: scenario === "recovered" ? 503 : 401,
							message: "fixture provider unavailable",
						},
					}),
		});
		try {
			// Eval creates a per-item state directory under TMPDIR. Keep that
			// directory beneath the scratch home too; leave the home guard on.
			const env = {
				...process.env,
				...scratch.env,
				TMPDIR: scratch.dir,
				NODE_ENV: "test",
				CLIO_CODER_TEST_OPENAI_KEY: "fixture-key",
			};
			const workspace = join(scratch.dir, "workspace");
			mkdirSync(workspace);
			const doctor = await run(["doctor", "--fix"], workspace, env);
			strictEqual(doctor.code, 0, doctor.stderr);
			seedOpenAICompatToolOrchestrator(join(scratch.dir, "config"), fixture.url, "full-auto");
			const suite = {
				version: 2,
				suite: { id: `artifact-${scenario}`, title: "Artifact settlement", visibility: "public" },
				matrix: { targets: [{ id: "mock-chat", model: "mock-model" }], repeats: 1 },
				tasks: [
					{
						id: "report",
						tags: ["regression"],
						workspace: { kind: "temp-copy", path: workspace },
						runner: {
							kind: "clio-coder-run",
							autonomy: "full-auto",
							prompt: "Write a report artifact containing exactly: fixture report",
						},
						verify: {
							measure: [
								'node -e \'process.exit(require("node:fs").readFileSync(".clio-coder/artifacts/REPORT.md", "utf8") === "fixture report\\n" ? 0 : 1)\'',
							],
							assertions: [
								{ metric: "receipt.sealed", op: "eq", value: true },
								{ metric: "receipt.integrityValid", op: "eq", value: true },
								{ metric: "receipt.outcomeMatchesExit", op: "eq", value: true },
							],
						},
						metrics: { collect: ["result.pass", "task.solved", "receipt.outcomeMatchesExit"] },
						timeoutMs: 30_000,
					},
				],
			};
			const suitePath = join(scratch.dir, "suite.yaml");
			const output = join(scratch.dir, "eval.json");
			writeFileSync(suitePath, JSON.stringify(suite));
			const evaluated = await run(
				["eval", "run", "--suite", suitePath, "--out", output, "--clio-coder-entry", CLI],
				workspace,
				env,
			);
			const report = JSON.parse(readFileSync(output, "utf8")) as EvalArtifactV4;
			const result = report.results[0];
			ok(result, evaluated.stderr);
			const succeeded = scenario !== "terminal-error";
			strictEqual(result.metrics["receipt.sealed"], true, JSON.stringify(result));
			strictEqual(result.metrics["receipt.count"], 1);
			strictEqual(result.metrics["receipt.rootCount"], 1);
			strictEqual(result.metrics["receipt.integrityValid"], true);
			strictEqual(result.metrics["receipt.outcomeMatchesExit"], true);
			strictEqual(result.metrics["task.solved"], succeeded);
			const stdout = String(result.artifacts.stdout);
			const stderr = String(result.artifacts.stderr);
			doesNotMatch(stderr, /auto-build failed|receipt write failed/u);
			if (succeeded) {
				match(stdout, /"toolName":"artifact"/u);
				match(stdout, /"terminate":true/u);
				doesNotMatch(stdout, /unexpected follow-up/u);
				const events = stdout
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line));
				const completed = events.filter(
					(event) =>
						event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "toolUse",
				);
				strictEqual(completed.length, 1);
				ok(completed[0].message.content.some((block: { type: string }) => block.type === "toolCall"));
				ok(
					completed[0].message.content.every(
						(block: { type: string; text?: string }) => block.type !== "text" || !block.text,
					),
				);
			}
			if (scenario === "recovered") {
				match(stdout, /"stopReason":"error"/u);
				match(stdout, /"phase":"recovered"/u);
			}
			strictEqual(result.pass, succeeded, JSON.stringify({ failureClass: result.failureClass, stderr }));
			strictEqual(result.failureClass, succeeded ? null : "runner_failed");
			strictEqual(evaluated.code, succeeded ? 0 : 1, evaluated.stderr);
			strictEqual(fixture.requests.filter((request) => request.stream !== false).length, scenario === "recovered" ? 2 : 1);
			// A separate clean built run keeps its pinned journal available, so we
			// inspect the actual sealed outcome, not just the eval's invariant.
			if (scenario === "clean") {
				const direct = await run(["run", "--json", "--autonomy", "full-auto", "Write a report artifact"], workspace, env);
				strictEqual(direct.code, 0, direct.stderr);
				const journal = readRunJournal(join(scratch.dir, "state"));
				ok(journal);
				strictEqual(journal.receipts.length, 1);
				strictEqual(journal.receipts[0]?.outcome, "succeeded");
				strictEqual(journal.receipts[0]?.exitCode, 0);
				strictEqual(receiptInvariantMetrics(journal, direct.code)["receipt.integrityValid"], true);
			}
		} finally {
			await closeServer(fixture.server);
			scratch.cleanup();
		}
	});
}
