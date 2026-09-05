import { match, ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readRunJournal, receiptInvariantMetrics } from "../../src/domains/eval/metrics/invariants.js";
import { readEvalLedgerSnapshot } from "../../src/domains/eval/metrics/tracked.js";
import type { EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";
import {
	closeServer,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import { makeScratchHome } from "../harness/scratch-env.js";

const CLI = new URL("../../dist/cli/index.js", import.meta.url).pathname;
const HEADER_DELAYS_MS = [1200, 200] as const;
const ROUNDING_TOLERANCE_MS = 5;
const CONTENT = "native timing fixture\n";

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

for (const mode of ["durable calls", "eval first call"] as const) {
	test(`built native timing includes delayed response headers: ${mode}`, async () => {
		const scratch = makeScratchHome("clio-native-call-timing-");
		// This is controlled HTTP evidence. Output arrives immediately after
		// delayed headers, exposing providers whose start event arrives too late
		// to serve as an invocation clock. The write forces a second real call.
		const fixture = await startOpenAICompatFixture("TIMING_WRITE_COMPLETE", {
			responseHeaderDelaysMs: HEADER_DELAYS_MS,
			toolCall: { name: "write", arguments: { path: "timing-probe.txt", content: CONTENT } },
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
			const prompt = "Write timing-probe.txt containing exactly native timing fixture followed by a newline.";
			if (mode === "durable calls") {
				const direct = await run(
					["--no-context-files", "--no-skills", "run", "--json", "--autonomy", "full-auto", prompt],
					workspace,
					env,
				);
				strictEqual(direct.code, 0, direct.stderr);
				strictEqual(readFileSync(join(workspace, "timing-probe.txt"), "utf8"), CONTENT);
				match(direct.stdout, /TIMING_WRITE_COMPLETE/u);
				strictEqual(fixture.requests.filter((request) => request.stream !== false).length, 2);
				const journal = readRunJournal(join(scratch.dir, "state"));
				ok(journal);
				strictEqual(journal.receipts.length, 1);
				strictEqual(receiptInvariantMetrics(journal, direct.code)["receipt.integrityValid"], true);
				strictEqual(receiptInvariantMetrics(journal, direct.code)["receipt.outcomeMatchesExit"], true);
				const snapshot = await readEvalLedgerSnapshot(join(scratch.dir, "state"));
				const calls = snapshot.entries.flatMap((entry) => {
					if (entry.kind !== "message" || entry.role !== "assistant") return [];
					if (typeof entry.payload !== "object" || entry.payload === null) return [];
					const payload = entry.payload as Record<string, unknown>;
					return payload.usage === undefined ? [] : [payload];
				});
				strictEqual(calls.length, 2, JSON.stringify(calls));
				const timings = calls.map((call, index) => {
					const timing = call.timing as { ttftMs: number | null; apiMs: number } | null | undefined;
					ok(timing, `call ${index + 1} must persist invocation timing: ${JSON.stringify(call)}`);
					ok(typeof timing.ttftMs === "number", JSON.stringify(timing));
					const minimum = (HEADER_DELAYS_MS[index] ?? 0) - ROUNDING_TOLERANCE_MS;
					ok(timing.ttftMs >= minimum, `call ${index + 1} excludes its header wait: ${JSON.stringify(timing)}`);
					ok(timing.apiMs >= minimum, `call ${index + 1} API duration excludes its header wait`);
					ok(timing.apiMs >= timing.ttftMs, JSON.stringify(timing));
					return { ttftMs: timing.ttftMs, apiMs: timing.apiMs };
				});
				const [first, second] = timings;
				ok(first && second);
				// A turn-wide anchor includes the first call in the second reading.
				// Half the injected one-second difference remains scheduling slack.
				ok(second.ttftMs < first.ttftMs - 500, `calls need separate invocation clocks: ${JSON.stringify(timings)}`);
				return;
			}

			const suitePath = join(scratch.dir, "suite.yaml");
			const output = join(scratch.dir, "eval.json");
			writeFileSync(
				suitePath,
				JSON.stringify({
					version: 2,
					suite: { id: "native-call-timing", title: "Native call timing", visibility: "public" },
					matrix: { targets: [{ id: "mock-chat", model: "mock-model" }], repeats: 1 },
					tasks: [
						{
							id: "write",
							tags: ["regression"],
							workspace: { kind: "temp-copy", path: workspace },
							runner: { kind: "clio-coder-run", autonomy: "full-auto", prompt },
							verify: {
								measure: [
									'node -e \'process.exit(require("node:fs").readFileSync("timing-probe.txt", "utf8") === "native timing fixture\\n" ? 0 : 1)\'',
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
				}),
			);
			const evaluated = await run(
				["eval", "run", "--suite", suitePath, "--out", output, "--clio-coder-entry", CLI],
				workspace,
				env,
			);
			const report = JSON.parse(readFileSync(output, "utf8")) as EvalArtifactV4;
			const result = report.results[0];
			ok(result, evaluated.stderr);
			strictEqual(evaluated.code, 0, evaluated.stderr);
			strictEqual(result.pass, true, JSON.stringify(result));
			strictEqual(result.metrics["receipt.sealed"], true);
			strictEqual(result.metrics["receipt.integrityValid"], true);
			strictEqual(result.metrics["receipt.outcomeMatchesExit"], true);
			strictEqual(fixture.requests.filter((request) => request.stream !== false).length, 2);
			const sources = JSON.parse(String(result.artifacts.trackedMetricSources));
			strictEqual(sources.assistantCalls, "session");
			strictEqual(sources.sessionCalls, 2);
			strictEqual(sources.streamCalls, 2);
			const tracked = result.verdict?.trackedMetrics;
			ok(tracked);
			strictEqual(tracked.modelCalls.value, 2);
			strictEqual(tracked.ttftMsFirstCall.source, "ledger");
			ok(typeof tracked.ttftMsFirstCall.value === "number", JSON.stringify(tracked.ttftMsFirstCall));
			ok(
				tracked.ttftMsFirstCall.value >= HEADER_DELAYS_MS[0] - ROUNDING_TOLERANCE_MS,
				`eval must retain the durable first call's header wait: ${JSON.stringify(tracked.ttftMsFirstCall)}`,
			);
		} finally {
			await closeServer(fixture.server);
			scratch.cleanup();
		}
	});
}
