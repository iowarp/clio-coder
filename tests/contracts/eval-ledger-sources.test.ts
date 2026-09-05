import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { shellQuote } from "../../src/core/shell-quote.js";
import { runShellCommand } from "../../src/domains/eval/runners/external-command.js";
import { runEvalSuiteV2 } from "../../src/domains/eval/suites/run.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const USAGE = { input: 7, output: 5, cacheRead: 10, cacheWrite: 0, reasoning: 2, totalTokens: 22 };
const BASE = { parentTurnId: null, timestamp: "2026-09-04T00:00:00.000Z" };
const calls: SessionEntry[] = [1, 2].map((id) => ({
	...BASE,
	kind: "message",
	role: "assistant",
	turnId: `durable-${id}`,
	payload: {
		usage: USAGE,
		timing: { ttftMs: 37, apiMs: 50 },
		promptCache: {
			input: 7,
			cacheRead: 10,
			expectedColdReasons: ["fixture-cold"],
			backend: { promptTokens: 17, cachedTokens: 10, predictedTokens: 5 },
		},
	},
}));
const metadata: SessionEntry[] = [
	{ ...BASE, kind: "message", role: "tool_call", turnId: "tool", payload: { toolCallId: "tool", name: "read" } },
	{
		...BASE,
		kind: "message",
		role: "tool_result",
		turnId: "result",
		payload: { toolCallId: "tool", isError: true },
	},
	{
		...BASE,
		kind: "compactionSummary",
		turnId: "compact",
		summary: "fixture checkpoint",
		tokensBefore: 100,
		tokensAfter: 40,
		firstKeptTurnId: "durable-2",
		usage: {
			input: 11,
			output: 3,
			cacheRead: 2,
			cacheWrite: 0,
			reasoning: 1,
			totalTokens: 16,
			cost: { total: 0.1 },
			apiCalls: 2,
		},
	},
];
const event = { type: "message_end", message: { role: "assistant", timestamp: 1, usage: USAGE } };

for (const mode of ["both", "ledger-only", "stream-only", "metadata-only", "partial", "multiple-sessions"] as const) {
	test(`eval ledger sources: ${mode}`, async () => {
		const env = await isolateClioEnv("clio-eval-sources-");
		try {
			const workspace = join(env.dir, "workspace");
			mkdirSync(workspace);
			const script = join(workspace, "runner.cjs");
			const durable =
				mode === "stream-only"
					? []
					: mode === "metadata-only"
						? metadata
						: [...calls.slice(0, mode === "partial" ? 1 : 2), ...metadata];
			const ledgers = mode === "multiple-sessions" ? [[calls[0], ...metadata], [calls[1]]] : [durable];
			// Exercise the actual external runner, state reader and suite composition.
			// Identical usage represents two real calls, not duplicated content.
			writeFileSync(
				script,
				`
const fs = require("node:fs"), path = require("node:path");
const ledgers = ${JSON.stringify(ledgers)};
for (const [index, entries] of ledgers.entries()) {
  if (!entries.length) continue;
  const dir = path.join(process.env.CLIO_CODER_STATE_DIR, "sessions", "fixture", "session-" + index);
  fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(path.join(dir, "current.jsonl"), entries.map(x => JSON.stringify(x)).join("\\n") + "\\n");
}
if (${mode !== "ledger-only"}) {
  process.stdout.write(${JSON.stringify(`${JSON.stringify(event)}\n${JSON.stringify(event)}\n`)});
}
`,
			);
			const artifact = await runEvalSuiteV2(
				{
					path: join(env.dir, "suite.yaml"),
					baseDir: env.dir,
					hash: "a".repeat(64),
					suite: {
						version: 2,
						suite: { id: "source-policy", title: "Source policy", visibility: "local" },
						matrix: { targets: [{ id: "fixture" }], repeats: 1 },
						tasks: [
							{
								id: mode,
								tags: [],
								workspace: { kind: "local", path: workspace },
								runner: { kind: "external-command", command: `${shellQuote(process.execPath)} ${shellQuote(script)}` },
								verify: {},
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
			assert.equal(result.pass, true, JSON.stringify(result));
			const tracked = result.verdict?.trackedMetrics;
			assert.ok(tracked);
			const count = mode === "partial" ? 1 : 2;
			const compact = mode === "stream-only" ? 0 : 1;
			assert.equal(tracked.modelCalls.value, count + compact * 2);
			assert.equal(tracked.uncachedPrefillTokens.value, count * 7 + compact * 11);
			assert.equal(tracked.generatedTokens.value, count * 5 + compact * 3);
			assert.equal(tracked.cacheReadTokens.value, count * 10 + compact * 2);
			assert.equal(tracked.reasoningTokens.value, count * 2 + compact);
			assert.equal(tracked.compactions.value, compact);
			assert.equal(tracked.toolCalls.value, compact);
			assert.equal(tracked.toolErrors.value, compact);
			if (mode !== "ledger-only") {
				// Stdout observes assistant calls only, not the compaction's two calls.
				assert.equal(result.metrics["tokens.output"], 10);
				assert.equal(result.metrics["tokens.input"], 14);
				assert.equal(result.metrics["tokens.cacheRead"], 20);
			}
			const source = JSON.parse(String(result.artifacts.trackedMetricSources));
			const usesStream = mode === "stream-only" || mode === "metadata-only";
			assert.equal(source.assistantCalls, usesStream ? "stream" : "session");
			if (!usesStream) {
				assert.deepEqual(tracked.ttftMsFirstCall, { value: 37, source: "ledger" });
				assert.deepEqual(tracked.expectedColdReasons["fixture-cold"], { value: count, source: "ledger" });
				if (mode !== "ledger-only") {
					assert.match(String(result.artifacts.trackedMetricWarning), /not a reconciled union/u);
					assert.equal(JSON.parse(String(result.artifacts.callLedger)).length, 2);
				}
			}
		} finally {
			env.restore();
		}
	});
}

test("stream call accounting survives bounded stdout and repeated identical usage", async () => {
	const env = await isolateClioEnv("clio-eval-bounded-");
	try {
		const script = join(env.dir, "verbose.cjs");
		writeFileSync(
			script,
			`
process.stdout.write("x".repeat(220000) + "\\n");
process.stdout.write(${JSON.stringify(`${JSON.stringify({ ...event, marker: "middle-call" })}\n`)});
process.stdout.write("y".repeat(220000) + "\\n");
process.stdout.write(${JSON.stringify(`${JSON.stringify(event)}\n`)});
`,
		);
		const result = await runShellCommand(`${shellQuote(process.execPath)} ${shellQuote(script)}`, env.dir, 5000);
		assert.equal(result.exitCode, 0);
		assert.ok(result.stdout.length <= 200000);
		assert.match(result.stdout, /output middle truncated/u);
		assert.doesNotMatch(result.stdout, /middle-call/u);
		assert.equal(result.ledgerEntries.length, 2);
		assert.equal(result.usage.tokens.output, 10);
		assert.equal(result.usage.tokens.cacheRead, 20);
	} finally {
		env.restore();
	}
});
