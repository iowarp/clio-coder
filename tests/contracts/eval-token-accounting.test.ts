import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { tokenMeasurementCoverage } from "../../src/domains/eval/metrics/coverage.js";
import {
	createTokenUsageFold,
	tokenMetricEntries,
	tokenUsageFromJsonl,
} from "../../src/domains/eval/metrics/token-stream.js";
import { renderEvalTextReportV3 } from "../../src/domains/eval/reports/text.js";
import { runExternalCommandRunner } from "../../src/domains/eval/runners/external-command.js";
import type { EvalArtifactResultV3, EvalArtifactV3 } from "../../src/domains/eval/schema/artifact.js";

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
		const result = (measured: boolean): EvalArtifactResultV3 => ({
			assignmentId: null,
			terminalReceiptDigest: null,
			taskId: "t",
			repeatIndex: 0,
			target: { id: "local", model: null, thinking: null },
			pass: true,
			failureClass: null,
			metrics: { "tokens.measured": measured },
			artifacts: {},
		});
		const artifact = (results: EvalArtifactResultV3[], total: number): EvalArtifactV3 => ({
			version: 3,
			evalId: "eval-1",
			suite: { id: "v1-task-file", hash: "h" },
			clio: { version: "0.3.0", commit: null, entry: "dist/cli/index.js" },
			environment: { platform: "linux", node: "v22" },
			matrix: { target: "local", model: null, thinking: null },
			summary: {
				runs: results.length,
				passed: results.length,
				failed: 0,
				passRate: 1,
				tokens: { input: 0, output: 0, total, cacheRead: 0, cacheWrite: 0 },
				wallTimeMs: 10,
			},
			results,
		});

		const none = renderEvalTextReportV3(artifact([result(false), result(false)], 0));
		match(none, /tokens total: unmeasured \(0 of 2 runs reported usage\)/);

		const partial = renderEvalTextReportV3(artifact([result(true), result(false)], 900));
		match(partial, /tokens total: 900 \(measured in 1 of 2 runs\)/);

		const full = renderEvalTextReportV3(artifact([result(true)], 900));
		match(full, /tokens total: 900\n/);

		deepStrictEqual(tokenMeasurementCoverage([result(true), result(false)]), { total: 2, measured: 1 });
	});
});
