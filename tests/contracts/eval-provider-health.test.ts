import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { shellQuote } from "../../src/core/shell-quote.js";
import { evaluateGate } from "../../src/domains/eval/compare/gates.js";
import { createTokenUsageFold, tokenMetricEntries } from "../../src/domains/eval/metrics/token-stream.js";
import { runExternalCommandRunner } from "../../src/domains/eval/runners/external-command.js";
import type { EvalMetricAssertion } from "../../src/domains/eval/schema/suite.js";
import { runEvalSuiteV2 } from "../../src/domains/eval/suites/run.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const failedUsage = { input: 7, output: 3, cacheRead: 11, cacheWrite: 2, totalTokens: 23, cost: { total: 0.25 } };
const successUsage = { input: 5, output: 2, cacheRead: 4, cacheWrite: 0, totalTokens: 11, cost: { total: 0.5 } };
const completion = (stopReason: string, usage?: unknown) => ({
	type: "message_end",
	message: { role: "assistant", stopReason, ...(usage === undefined ? {} : { usage }) },
});
const retry = (phase: string) => ({ type: "retry_status", status: { phase, attempt: 1, maxAttempts: 3 } });
const failed = completion("error", failedUsage);
const recovered = [
	failed,
	retry("scheduled"),
	retry("waiting"),
	retry("waiting"),
	retry("retrying"),
	completion("stop", successUsage),
	retry("recovered"),
	{ type: "turn_end", message: failed.message },
	{ type: "agent_end", messages: [failed.message] },
];
const jsonl = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

function metrics(events: unknown[]) {
	const fold = createTokenUsageFold();
	const stream = jsonl(events);
	// A split inside JSON plus an unterminated final line exercise real chunk framing.
	fold.push(stream.slice(0, 31));
	fold.push(stream.slice(31));
	const result = tokenMetricEntries(fold.usage());
	assert.deepEqual(tokenMetricEntries(fold.usage()), result, "reading a fold must not recount its final line");
	return result;
}

test("provider recovery facts preserve total spend and label the failed share once", () => {
	const result = metrics(recovered);
	assert.equal(result["provider.measured"], true);
	assert.equal(result["provider.stopReason.error"], 1);
	assert.equal(result["provider.stopReason.stop"], 1);
	assert.equal(result["provider.retryScheduled"], 1);
	assert.equal(result["provider.retryStarted"], 1);
	assert.equal(result["provider.retryRecovered"], 1);
	assert.equal(result["provider.retryExhausted"], 0);
	assert.equal(result["tokens.total"], 34);
	assert.equal(result["tokens.input"], 12);
	assert.equal(result["tokens.output"], 5);
	assert.equal(result["tokens.cacheRead"], 15);
	assert.equal(result["tokens.cacheWrite"], 2);
	assert.equal(result["cost.usd"], 0.75);
	assert.equal(result["provider.errorTokens.total"], 23);
	assert.equal(result["provider.errorTokens.cacheRead"], 11);
	assert.equal(result["provider.errorCostUsd"], 0.25);
	assert.equal(result["provider.errorUsageObservedCalls"], 1);
	assert.equal(result["provider.errorUsageUnobservedCalls"], 0);
	assert.equal(result["provider.errorUsageIncompleteCalls"], 0);
	assert.equal(result["provider.errorCostUnobservedCalls"], 0);
});

test("failed usage distinguishes absent, synthetic zeros, partial facts and unknown cost", () => {
	const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
	for (const usage of [undefined, {}, empty, { input: -1, output: "3", totalTokens: null }]) {
		const result = metrics([completion("error", usage)]);
		assert.equal(result["tokens.measured"], false);
		assert.equal(result["tokens.total"], undefined);
		assert.equal(result["cost.usd"], undefined);
		assert.equal(result["provider.errorUsageUnobservedCalls"], 1);
		assert.equal(result["provider.errorTokens.total"], undefined);
		assert.equal(result["provider.errorCostUsd"], undefined);
	}
	const partial = metrics([failed, completion("error"), completion("error", { input: 5, output: -1 })]);
	assert.equal(partial["tokens.total"], 28);
	assert.equal(partial["provider.errorTokens.input"], 12);
	assert.equal(partial["provider.errorTokens.output"], 3);
	assert.equal(partial["provider.errorUsageObservedCalls"], 2);
	assert.equal(partial["provider.errorUsageUnobservedCalls"], 1);
	assert.equal(partial["provider.errorUsageIncompleteCalls"], 2);
	assert.equal(partial["provider.errorCostUnobservedCalls"], 2);
	const costOnly = metrics([completion("error", { cost: { total: 0.25 } })]);
	assert.equal(costOnly["tokens.measured"], false);
	assert.equal(costOnly["cost.usd"], 0.25);
	assert.equal(costOnly["provider.errorCostUsd"], 0.25);
	assert.equal(costOnly["provider.errorTokens.input"], undefined);
	const noOutput = metrics([{ type: "message_update", message: { role: "assistant", stopReason: "pending" } }]);
	assert.equal(noOutput["provider.measured"], false);
	assert.equal(noOutput["provider.stopReason.error"], undefined);
});

test("reported failed reasoning is retained without inventing ordinary totals or promoting adapter estimates", () => {
	const reported = metrics([
		completion("error", {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			reasoning: 7,
		}),
	]);
	assert.equal(reported["provider.errorReasoningTokens"], 7);
	assert.equal(reported["provider.errorReasoningUnobservedCalls"], 0);
	assert.equal(reported["provider.errorUsageObservedCalls"], 1);
	assert.equal(reported["provider.errorUsageUnobservedCalls"], 0);
	assert.equal(reported["provider.errorUsageIncompleteCalls"], 1);
	assert.equal(reported["tokens.measured"], false);
	assert.equal(reported["tokens.total"], undefined);
	assert.equal(reported["provider.errorTokens.total"], undefined);
	const mixed = metrics([
		completion("error", { ...failedUsage, reasoning_tokens: 2 }),
		completion("error", { ...failedUsage, reasoningTokens: 5 }),
	]);
	assert.equal(mixed["provider.errorReasoningTokens"], 2);
	assert.equal(mixed["provider.errorReasoningUnobservedCalls"], 1);
	assert.equal(mixed["tokens.total"], 46);
	assert.equal(mixed["provider.errorTokens.total"], 46);
	// Pi adapters initialize missing reasoning detail to zero even when ordinary usage exists.
	const normalizedZero = metrics([completion("error", { ...failedUsage, reasoning: 0 })]);
	assert.equal(normalizedZero["provider.errorReasoningTokens"], undefined);
	assert.equal(normalizedZero["provider.errorReasoningUnobservedCalls"], 1);
	assert.equal(normalizedZero["tokens.total"], 23);
	const estimateOnly = metrics([completion("error", { reasoningTokens: 5 })]);
	assert.equal(estimateOnly["provider.errorReasoningTokens"], undefined);
	assert.equal(estimateOnly["provider.errorReasoningUnobservedCalls"], 1);
	assert.equal(estimateOnly["provider.errorUsageUnobservedCalls"], 1);
});

test("failed normalized zero fields remain unattributed without changing clean zero usage", () => {
	const usage = { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 7 };
	const failed = metrics([completion("error", usage)]);
	assert.equal(failed["provider.errorTokens.input"], 7);
	assert.equal(failed["provider.errorTokens.output"], undefined);
	assert.equal(failed["provider.errorTokens.cacheRead"], undefined);
	assert.equal(failed["provider.errorTokens.cacheWrite"], undefined);
	assert.equal(failed["provider.errorUsageIncompleteCalls"], 1);
	assert.equal(failed["tokens.total"], 7);
	const clean = metrics([completion("stop", { ...usage, input: 0, totalTokens: 0 })]);
	assert.equal(clean["tokens.measured"], true);
	assert.equal(clean["tokens.total"], 0);
	assert.equal(clean["provider.stopReason.error"], 0);
	assert.equal(clean["provider.errorTokens.total"], undefined);
});

test("provider retry phases and terminal reasons remain distinct across retry chains", () => {
	const result = metrics([
		...recovered,
		retry("scheduled"),
		retry("cancelled"),
		retry("scheduled"),
		retry("retrying"),
		retry("exhausted"),
		completion("aborted"),
		completion("length", successUsage),
		completion("toolUse", successUsage),
		completion("future-reason"),
	]);
	assert.equal(result["provider.retryScheduled"], 3);
	assert.equal(result["provider.retryStarted"], 2);
	assert.equal(result["provider.retryCancelled"], 1);
	assert.equal(result["provider.retryExhausted"], 1);
	assert.equal(result["provider.stopReason.error"], 1);
	assert.equal(result["provider.stopReason.aborted"], 1);
	assert.equal(result["provider.stopReason.length"], 1);
	assert.equal(result["provider.stopReason.toolUse"], 1);
	assert.equal(result["provider.stopReason.other"], 1);
});

test("external commands preserve provider facts from truncated middles and failed final commands", async () => {
	const env = await isolateClioEnv("clio-provider-stream-");
	try {
		const first = join(env.dir, "first.cjs");
		const second = join(env.dir, "second.cjs");
		writeFileSync(
			first,
			`process.stdout.write("x".repeat(220000) + "\\n" + ${JSON.stringify(jsonl(recovered))} + "\\n" + "y".repeat(220000));`,
		);
		writeFileSync(
			second,
			`process.stdout.write(${JSON.stringify(jsonl([failed, retry("exhausted")]))}); process.exitCode = 1;`,
		);
		const result = await runExternalCommandRunner(
			{
				kind: "external-command",
				commands: [first, second].map((path) => `${shellQuote(process.execPath)} ${shellQuote(path)}`),
			},
			env.dir,
			5000,
		);
		assert.equal(result.exitCode, 1);
		assert.match(result.stdout, /output middle truncated/u);
		assert.doesNotMatch(result.stdout, /"phase":"recovered"/u);
		assert.equal(result.metrics["provider.retryRecovered"], 1);
		assert.equal(result.metrics["provider.retryExhausted"], 1);
		assert.equal(result.metrics["provider.stopReason.error"], 2);
		assert.equal(result.metrics["provider.errorTokens.total"], 46);
		assert.equal(result.metrics["tokens.total"], 57);
	} finally {
		env.restore();
	}
});

test("suite health assertions opt in while thresholds gate measured recovery without rewriting task success", async () => {
	const env = await isolateClioEnv("clio-provider-gates-");
	try {
		const runner = join(env.dir, "runner.cjs");
		writeFileSync(runner, `process.stdout.write(${JSON.stringify(jsonl(recovered))});`);
		const health: EvalMetricAssertion[] = [
			{ metric: "provider.measured", op: "eq", value: true },
			{ metric: "provider.stopReason.error", op: "eq", value: 0 },
		];
		const artifact = await runEvalSuiteV2(
			{
				path: join(env.dir, "suite.yaml"),
				baseDir: env.dir,
				hash: "a".repeat(64),
				suite: {
					version: 2,
					suite: { id: "provider", title: "Provider health", visibility: "local" },
					matrix: { targets: [{ id: "fixture" }], repeats: 1 },
					tasks: [false, true].map((gated) => ({
						id: gated ? "gated" : "ungated",
						tags: [],
						workspace: { kind: "local", path: env.dir },
						runner: { kind: "external-command", command: `${shellQuote(process.execPath)} ${shellQuote(runner)}` },
						verify: { assertions: gated ? health : [] },
						metrics: { collect: [] },
						timeoutMs: 5000,
					})),
				},
			},
			{ clioEntry: new URL("../../dist/cli/index.js", import.meta.url).pathname },
		);
		assert.equal(artifact.results[0]?.pass, true);
		assert.equal(artifact.results[1]?.pass, false);
		assert.equal(artifact.results[1]?.failureClass, "assertion_failed");
		const gate = evaluateGate(artifact, { fail: [{ metric: "provider.stopReason.error", op: "gt", value: 0 }] });
		assert.equal(gate.pass, false);
		assert.equal(gate.failures.length, 2);
		assert.ok(gate.failures.every((failure) => !failure.unresolved && failure.actual === 1));
		assert.equal(artifact.results[0]?.pass, true);
	} finally {
		env.restore();
	}
});
