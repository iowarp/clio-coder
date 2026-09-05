import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readRunJournal, receiptInvariantMetrics } from "../../src/domains/eval/metrics/invariants.js";
import type { EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";
import { evidenceDirectory } from "../../src/domains/evidence/store.js";
import { readEvidenceIndex } from "../../src/domains/observability/evidence-index.js";
import {
	closeServer,
	hasToolExchange,
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

for (const scenario of ["clean", "recovered", "recovered-gated", "terminal-error"] as const) {
	test(`built headless artifact and eval: ${scenario}`, async () => {
		const scratch = makeScratchHome("clio-headless-artifact-");
		const fixture = await startOpenAICompatFixture("unexpected follow-up", {
			toolCall: { name: "artifact", arguments: { kind: "report", content: "fixture report\n" } },
			usage: {
				prompt_tokens: 17,
				completion_tokens: 5,
				total_tokens: 22,
				prompt_tokens_details: { cached_tokens: 10 },
				completion_tokens_details: { reasoning_tokens: 2 },
			},
			...(scenario === "clean"
				? {}
				: {
						initialErrors: {
							count: 1,
							status: scenario.startsWith("recovered") ? 503 : 401,
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
				...(scenario === "recovered-gated"
					? { thresholds: { fail: [{ metric: "provider.stopReason.error", op: "gt", value: 0 }] } }
					: {}),
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
			if (scenario.startsWith("recovered")) {
				match(stdout, /"stopReason":"error"/u);
				match(stdout, /"phase":"recovered"/u);
			}
			strictEqual(result.pass, succeeded, JSON.stringify({ failureClass: result.failureClass, stderr }));
			strictEqual(result.failureClass, succeeded ? null : "runner_failed");
			strictEqual(evaluated.code, succeeded && scenario !== "recovered-gated" ? 0 : 1, evaluated.stderr);
			strictEqual(
				fixture.requests.filter((request) => request.stream !== false).length,
				scenario.startsWith("recovered") ? 2 : 1,
			);
			const calls = JSON.parse(String(result.artifacts.callLedger)) as unknown[];
			const tracked = result.verdict?.trackedMetrics;
			ok(tracked);
			const sources = JSON.parse(String(result.artifacts.trackedMetricSources));
			strictEqual(sources.assistantCalls, "session");
			strictEqual(sources.sessionCalls, calls.length);
			strictEqual(sources.streamCalls, calls.length);
			strictEqual(result.metrics["ledger.sessionCount"], 1);
			strictEqual(tracked.modelCalls.value, calls.length, JSON.stringify({ tracked, metrics: result.metrics }));
			strictEqual(result.metrics["provider.measured"], true);
			strictEqual(result.metrics["provider.stopReason.error"], scenario === "clean" ? 0 : 1);
			strictEqual(result.metrics["provider.stopReason.toolUse"], succeeded ? 1 : 0);
			strictEqual(result.metrics["provider.retryScheduled"], scenario.startsWith("recovered") ? 1 : 0);
			strictEqual(result.metrics["provider.retryStarted"], scenario.startsWith("recovered") ? 1 : 0);
			strictEqual(result.metrics["provider.retryRecovered"], scenario.startsWith("recovered") ? 1 : 0);
			strictEqual(result.metrics["provider.retryExhausted"], 0);
			if (scenario !== "clean") {
				// This HTTP fault creates synthetic zero usage, not measured free work.
				strictEqual(result.metrics["provider.errorUsageUnobservedCalls"], 1);
				strictEqual(result.metrics["provider.errorTokens.total"], undefined);
			}
			if (succeeded) {
				strictEqual(tracked.generatedTokens.value, result.metrics["tokens.output"]);
				strictEqual(tracked.uncachedPrefillTokens.value, result.metrics["tokens.input"]);
				strictEqual(tracked.cacheReadTokens.value, result.metrics["tokens.cacheRead"]);
			} else {
				strictEqual(result.metrics["tokens.measured"], false);
				strictEqual(result.metrics["tokens.total"], undefined);
				strictEqual(report.summary.tokens.measured, false);
			}
			if (scenario === "recovered-gated") match(evaluated.stdout, /gate: fail/u);
			strictEqual(tracked.compactions.value, 0);
			if (succeeded) {
				strictEqual(tracked.generatedTokens.value, 5);
				strictEqual(tracked.uncachedPrefillTokens.value, 7);
				strictEqual(tracked.cacheReadTokens.value, 10);
				// This compat adapter does not expose wire reasoning-token details.
				// Keep that unknown; the structured-stream contract covers nonzero reasoning.
				strictEqual(tracked.reasoningTokens.value, null);
			}
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

// Issue #331 reported `[clio-coder:evidence] auto-build failed for run <id>:
// run ledger not found` on a healthy headless run under a fresh pinned state
// directory whose dispatch reached DispatchCompleted. The evidence auto-build
// starts on that event and reads `<stateDir>/runs.json`, which the emitting
// finalizer persists first. This drives that exact shape without a model: the
// main agent dispatches one worker whose terminal text satisfies its result
// contract, then ends the turn with the artifact tool.
test("built headless artifact: a completed dispatch builds its evidence under a fresh pinned state dir", async () => {
	const scratch = makeScratchHome("clio-headless-artifact-dispatch-");
	const hasTool = (request: Record<string, unknown>, name: string): boolean =>
		Array.isArray(request.tools) &&
		request.tools.some((tool) => (tool as { function?: { name?: string } })?.function?.name === name);
	const fixture = await startOpenAICompatFixture("worker done: nothing to change\n", {
		// The worker's own conversation has no dispatch tool and gets the text
		// reply, which the artifact-report contract accepts as-is.
		toolCall: (request) => {
			if (!hasTool(request, "dispatch")) return null;
			if (!hasToolExchange(request)) return { name: "dispatch", arguments: { task: "Say hello", agent: "wiki-writer" } };
			return { name: "artifact", arguments: { kind: "report", content: "fixture report\n" }, id: "call-clio-tool-2" };
		},
	});
	try {
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
		// Pinned the way an eval item pins it: an empty directory with no runs.json.
		const stateDir = mkdtempSync(join(scratch.dir, "pinned-state-"));
		const direct = await run(
			["run", "--json", "--autonomy", "full-auto", "Dispatch a worker, then write a report artifact"],
			workspace,
			{ ...env, CLIO_CODER_STATE_DIR: stateDir },
		);
		strictEqual(direct.code, 0, direct.stderr);
		doesNotMatch(direct.stderr, /auto-build failed|receipt write failed/u);
		match(direct.stdout, /"toolName":"dispatch"/u);
		match(direct.stdout, /"toolName":"artifact"/u);
		const journal = readRunJournal(stateDir);
		ok(journal);
		const dispatched = journal.receipts.filter((receipt) => receipt.agentId === "wiki-writer");
		strictEqual(dispatched.length, 1);
		strictEqual(dispatched[0]?.outcome, "succeeded");
		strictEqual(journal.receipts.filter((receipt) => receipt.agentId === "main-agent").length, 1);
		const rows = readEvidenceIndex(stateDir).filter((row) => row.runId === dispatched[0]?.runId);
		strictEqual(rows.length, 1, JSON.stringify(readEvidenceIndex(stateDir)));
		strictEqual(rows[0]?.succeeded, true);
		ok(existsSync(join(evidenceDirectory(join(scratch.dir, "data"), rows[0]?.evidenceId ?? ""), "overview.json")));
	} finally {
		await closeServer(fixture.server);
		scratch.cleanup();
	}
});

// The task deadline is the eval's own; it has to end the run it is timing.
// Spawned through `sh -c`, dash kept the shell as the parent, so the deadline's
// SIGTERM stopped the shell while Clio finished the turn after the deadline,
// wrote the artifact, sealed a succeeded receipt with exit 0, and exited 0.
// The item was then recorded as runner_failed beside an ok receipt, with
// `receipt.outcomeMatchesExit` false (issue #275). Delivered to Clio itself,
// the deadline cancels the turn and the receipt records that cancellation
// with the exit status the runner reports.
test("built headless artifact and eval: task deadline ends the Clio run it is timing", async () => {
	const scratch = makeScratchHome("clio-headless-artifact-deadline-");
	// The model answers the artifact call only long after the deadline. A run
	// the deadline never reached would go on to write the artifact.
	const fixture = await startOpenAICompatFixture("unexpected follow-up", {
		toolCall: { name: "artifact", arguments: { kind: "report", content: "fixture report\n" } },
		responseHeaderDelaysMs: [30_000],
	});
	try {
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
			suite: { id: "artifact-deadline", title: "Artifact deadline", visibility: "public" },
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
						measure: ["test -f .clio-coder/artifacts/REPORT.md"],
						assertions: [],
					},
					metrics: { collect: ["result.pass", "task.solved", "receipt.outcomeMatchesExit"] },
					timeoutMs: 8_000,
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
		const detail = JSON.stringify({
			failureClass: result.failureClass,
			metrics: result.metrics,
			stderr: result.artifacts.stderr,
		});
		strictEqual(evaluated.code, 1, evaluated.stderr);
		strictEqual(result.pass, false, detail);
		strictEqual(result.failureClass, "runner_failed", detail);
		strictEqual(result.metrics["task.solved"], false, detail);
		doesNotMatch(String(result.artifacts.stdout), /"toolName":"artifact"/u);
		strictEqual(result.metrics["receipt.sealed"], true, detail);
		strictEqual(result.metrics["receipt.count"], 1, detail);
		strictEqual(result.metrics["receipt.integrityValid"], true, detail);
		strictEqual(result.metrics["receipt.outcomeMatchesExit"], true, detail);
		ok(Number(result.metrics["latency.wallMs"]) < 30_000, detail);
	} finally {
		await closeServer(fixture.server);
		scratch.cleanup();
	}
});
