import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEvalArtifactV4 } from "../../src/domains/eval/artifacts/store.js";
import { evaluateMetricAssertion, metricValue } from "../../src/domains/eval/compare/thresholds.js";
import { tokenMeasurementCoverage } from "../../src/domains/eval/metrics/coverage.js";
import {
	createTokenUsageFold,
	tokenMetricEntries,
	tokenUsageFromJsonl,
} from "../../src/domains/eval/metrics/token-stream.js";
import { tokenAccountingFrom } from "../../src/domains/eval/metrics/tokens.js";
import { renderEvalTextReportV4 } from "../../src/domains/eval/reports/text.js";
import { runExternalCommandRunner } from "../../src/domains/eval/runners/external-command.js";
import type { EvalArtifactResultV4, EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";

function usage(total: number): unknown {
	return {
		input: total - 30,
		output: 20,
		cacheRead: 10,
		cacheWrite: 0,
		totalTokens: total,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
	};
}

function messageEnd(total: number): string {
	return JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: usage(total) },
	});
}

describe("contracts/eval token accounting", () => {
	it("sums every completed assistant message and never counts a republished one twice", () => {
		const stream = [
			messageEnd(1000),
			// turn_end republishes the same assistant message; agent_end republishes
			// the segment summary. Counting either would multiply the run's cost.
			JSON.stringify({ type: "turn_end", message: { role: "assistant", usage: usage(1000) } }),
			JSON.stringify({ type: "agent_end", messageCount: 1, usage: { totalTokens: 1000 } }),
			messageEnd(200),
			"not-json",
		].join("\n");

		const folded = tokenUsageFromJsonl(stream);
		strictEqual(folded.measured, true);
		strictEqual(folded.tokens.total, 1200);
		strictEqual(folded.tokens.output, 40);
		strictEqual(folded.costUsd, 0.5);
	});

	it("reads the usage field names the engine actually writes", () => {
		// The previous fold looked for inputTokens/cacheReadTokens, which no
		// engine message carries, so every per-field metric read zero.
		const folded = tokenUsageFromJsonl(messageEnd(500));
		deepStrictEqual(folded.tokens, { input: 470, output: 20, total: 500, cacheRead: 10, cacheWrite: 0 });
	});

	it("folds across chunk boundaries that split a line", () => {
		const fold = createTokenUsageFold();
		const line = messageEnd(700);
		fold.push(line.slice(0, 17));
		fold.push(line.slice(17));
		strictEqual(fold.usage().tokens.total, 700);
	});

	it("emits no counts at all when nothing was observed", () => {
		deepStrictEqual(tokenMetricEntries(tokenUsageFromJsonl("some prose\n")), { "tokens.measured": false });
	});

	it("an external command that streams Clio events is measured", async () => {
		const script = `printf '%s\\n' ${JSON.stringify(messageEnd(1500))}`;
		const output = await runExternalCommandRunner(
			{ kind: "external-command", commands: [script] } as never,
			process.cwd(),
			30_000,
		);
		strictEqual(output.metrics["tokens.measured"], true);
		strictEqual(output.metrics["tokens.total"], 1500);
	});

	it("an external command whose Clio work is out of sight is unmeasured, not free", async () => {
		const output = await runExternalCommandRunner(
			{ kind: "external-command", commands: ["printf 'wrote results to a file\\n'"] } as never,
			process.cwd(),
			30_000,
		);
		strictEqual(output.metrics["tokens.measured"], false);
		strictEqual(output.metrics["tokens.total"], undefined, "absence is not zero");
	});

	it("the text report states measurement coverage instead of asserting a zero total", () => {
		const result = (measured: boolean): EvalArtifactResultV4 => ({
			assignmentId: null,
			terminalReceiptDigest: null,
			taskId: "t",
			repeatIndex: 0,
			target: { id: "local", model: null, thinking: null },
			pass: true,
			failureClass: null,
			metrics: measured ? { "tokens.measured": true, "tokens.total": 900 } : { "tokens.measured": false },
			artifacts: {},
		});
		const artifact = (results: EvalArtifactResultV4[]): EvalArtifactV4 => ({
			version: 4,
			evalId: "eval-1",
			suite: { id: "v1-task-file", hash: "h" },
			clio: { version: "0.3.1", commit: null, entry: "dist/cli/index.js" },
			environment: { platform: "linux", node: "v22" },
			matrix: { target: "local", model: null, thinking: null },
			summary: {
				runs: results.length,
				passed: results.length,
				failed: 0,
				passRate: 1,
				tokens: tokenAccountingFrom(results),
				wallTimeMs: 10,
			},
			results,
		});

		const unmeasured = artifact([result(false), result(false)]);
		match(renderEvalTextReportV4(unmeasured), /tokens total: unmeasured \(0 of 2 runs reported usage\)/);

		const partial = artifact([result(true), result(false)]);
		match(renderEvalTextReportV4(partial), /tokens total: 900 \(measured in 1 of 2 runs\)/);

		const full = artifact([result(true)]);
		match(renderEvalTextReportV4(full), /tokens total: 900\n/);

		deepStrictEqual(tokenMeasurementCoverage([result(true), result(false)]), { total: 2, measured: 1 });
	});

	it("an unmeasured artifact carries no counts at all, in the stored artifact as well as the report", () => {
		const unmeasured = tokenAccountingFrom([{ metrics: { "tokens.measured": false } }, { metrics: {} }]);
		deepStrictEqual(unmeasured, { measured: false, runs: 2, measuredRuns: 0 });
		ok(!("total" in unmeasured), "an unmeasured total is absent, never zero");

		const partial = tokenAccountingFrom([
			{ metrics: { "tokens.measured": true, "tokens.input": 100, "tokens.output": 20, "tokens.total": 120 } },
			{ metrics: { "tokens.measured": false } },
		]);
		deepStrictEqual(partial, {
			measured: true,
			runs: 2,
			measuredRuns: 1,
			input: 100,
			output: 20,
			total: 120,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	it("a stored artifact that claims counts beside an unmeasured flag is refused", () => {
		const base = {
			version: 4,
			evalId: "eval-1",
			suite: { id: "s", hash: "h" },
			clio: { version: "0.3.1", commit: null, entry: "dist/cli/index.js" },
			environment: { platform: "linux", node: "v22" },
			matrix: { target: "local", model: null, thinking: null },
			results: [],
		};
		const summary = (tokens: unknown): unknown => ({
			...base,
			summary: { runs: 1, passed: 1, failed: 0, passRate: 1, tokens, wallTimeMs: 1 },
		});
		throws(
			() => parseEvalArtifactV4(summary({ measured: false, runs: 1, measuredRuns: 0, total: 0 }), "artifact"),
			/unmeasured accounting carries no counts/,
		);
		throws(
			() =>
				parseEvalArtifactV4(
					summary({ measured: true, runs: 1, measuredRuns: 0, input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 }),
					"artifact",
				),
			/expected a positive count when measured/,
		);
		deepStrictEqual(
			parseEvalArtifactV4(summary({ measured: false, runs: 1, measuredRuns: 0 }), "artifact").summary.tokens,
			{ measured: false, runs: 1, measuredRuns: 0 },
		);
	});

	it("a token threshold on an unmeasured artifact fails closed instead of reading zero", () => {
		const artifact = parseEvalArtifactV4(
			{
				version: 4,
				evalId: "eval-1",
				suite: { id: "s", hash: "h" },
				clio: { version: "0.3.1", commit: null, entry: "dist/cli/index.js" },
				environment: { platform: "linux", node: "v22" },
				matrix: { target: "local", model: null, thinking: null },
				summary: {
					runs: 1,
					passed: 1,
					failed: 0,
					passRate: 1,
					tokens: { measured: false, runs: 1, measuredRuns: 0 },
					wallTimeMs: 1,
				},
				results: [],
			},
			"artifact",
		);
		strictEqual(metricValue("tokens.total", {}, artifact), null);
		strictEqual(evaluateMetricAssertion({ metric: "tokens.total", op: "lt", value: 1_000 }, {}, artifact), false);
	});
});
