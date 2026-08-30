import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import { aggregateEvalVerdicts } from "../../src/domains/eval/metrics/aggregate.js";
import { createEvalCallLedgerFold } from "../../src/domains/eval/metrics/call-ledger-stream.js";
import { buildEvalTrackedMetrics, emptyEvalTrackedMetrics } from "../../src/domains/eval/metrics/tracked.js";
import { adaptSuiteV2ResultToVerdictV1 } from "../../src/domains/eval/schema/adapter.js";
import {
	EVAL_VERDICT_SCHEMA_V1,
	type EvalTrackedMetricsV1,
	type EvalVerdictEnvelopeV1,
	parseEvalVerdictEnvelopeV1,
	safeParseEvalVerdictEnvelopeV1,
} from "../../src/domains/eval/schema/verdict.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";

function envelope(
	outcome: EvalVerdictEnvelopeV1["outcome"],
	machinery: EvalVerdictEnvelopeV1["machinery"] = "ok",
	trialIndex = 0,
	trackedMetrics: EvalTrackedMetricsV1 = emptyEvalTrackedMetrics("ledger"),
): EvalVerdictEnvelopeV1 {
	return {
		schema: EVAL_VERDICT_SCHEMA_V1,
		scenarioId: "scenario-a",
		trialIndex,
		outcome,
		machinery,
		reason: outcome === "fail" ? (machinery === "ok" ? "grader_failed" : "infrastructure_failure") : null,
		trackedMetrics,
		behavioral: null,
		evidence: { assignmentId: null, terminalReceiptDigest: null, graderExitCode: null },
	};
}

function syntheticLedger(): SessionEntry[] {
	const base = { parentTurnId: null, timestamp: "2026-08-29T12:00:00.000Z" };
	return [
		{
			...base,
			kind: "message",
			role: "assistant",
			turnId: "call-1",
			payload: {
				promptCache: {
					input: 40,
					cacheRead: 80,
					backendVerdict: "hot",
					expectedColdReasons: ["residency", "residency"],
					backend: { promptTokens: 120, cachedTokens: 80, predictedTokens: 20, source: "llamacpp" },
				},
				timing: { ttftMs: 25, apiMs: 120 },
				usage: { input: 40, cacheRead: 80, output: 20, reasoning: 2 },
			},
		},
		{
			...base,
			kind: "message",
			role: "assistant",
			turnId: "call-2",
			payload: {
				promptCache: {
					input: 30,
					cacheRead: 70,
					backendVerdict: "hot",
					expectedColdReasons: ["thinking_change"],
				},
				timing: { ttftMs: 8, apiMs: 90 },
				usage: { input: 30, cacheRead: 70, output: 10, reasoning: 3 },
			},
		},
		{
			...base,
			kind: "message",
			role: "assistant",
			turnId: "call-3",
			payload: {
				promptCache: { backendVerdict: "unknown" },
				usage: { input: 5, output: 7 },
			},
		},
	] as SessionEntry[];
}

function syntheticReceipt(): RunReceipt {
	return {
		startedAt: "2026-08-29T12:00:00.000Z",
		endedAt: "2026-08-29T12:00:02.500Z",
		reasoningTokenCount: 11,
		toolCalls: 4,
		toolStats: [
			{ tool: "read", count: 2, ok: 2, errors: 0, blocked: 0, totalDurationMs: 20 },
			{ tool: "edit", count: 2, ok: 0, errors: 2, blocked: 0, totalDurationMs: 30 },
		],
	} as unknown as RunReceipt;
}

describe("contracts/eval verdict v1", () => {
	it("parses pass, fail, unmeasured, and infrastructure failure fixtures", () => {
		for (const fixture of [
			envelope("pass"),
			envelope("fail"),
			envelope("unmeasured"),
			envelope("fail", "infrastructure_failure"),
		]) {
			deepStrictEqual(parseEvalVerdictEnvelopeV1(fixture), fixture);
		}
	});

	it("rejects malformed input before it can parse to a pass", () => {
		const malformed = { ...envelope("pass"), machinery: "infrastructure_failure" };
		const parsed = safeParseEvalVerdictEnvelopeV1(malformed);
		strictEqual(parsed.ok, false);
		if (parsed.ok) throw new Error("expected malformed verdict to fail");
		strictEqual(parsed.error.includes("cannot carry a pass"), true);
	});

	it("takes the normalized grader result as its outcome and names a failed rule", () => {
		const fixture = {
			assignmentId: null,
			terminalReceiptDigest: null,
			taskId: "grader-fixture",
			repeatIndex: 0,
			target: { id: "local", model: null, thinking: null },
			metrics: { "task.solved": true, "task.exitCode": 0 },
			artifacts: {},
		};
		const passed = adaptSuiteV2ResultToVerdictV1(
			{ ...fixture, pass: true, failureClass: null },
			emptyEvalTrackedMetrics(),
		);
		strictEqual(passed.outcome, "pass");
		strictEqual(passed.reason, null);

		const failed = adaptSuiteV2ResultToVerdictV1(
			{
				...fixture,
				pass: false,
				failureClass: "grader_failed",
				metrics: { "task.solved": false, "task.exitCode": 7 },
			},
			emptyEvalTrackedMetrics(),
		);
		strictEqual(failed.outcome, "fail");
		strictEqual(failed.machinery, "ok");
		strictEqual(failed.reason, "grader_failed");
	});

	it("builds every tracked metric from three structured calls and the receipt", () => {
		const metrics = buildEvalTrackedMetrics({
			ledgerEntries: syntheticLedger(),
			receipt: syntheticReceipt(),
			fallbackWallClockMs: 9_999,
		});

		deepStrictEqual(metrics, {
			modelCalls: { value: 3, source: "ledger" },
			uncachedPrefillTokens: { value: 75, source: "estimated" },
			cacheReadTokens: { value: 150, source: "estimated" },
			generatedTokens: { value: 37, source: "ledger" },
			reasoningTokens: { value: 11, source: "receipt" },
			toolCalls: { value: 4, source: "receipt" },
			toolErrors: { value: 2, source: "receipt" },
			ttftMsFirstCall: { value: 25, source: "ledger" },
			wallClockMs: { value: 2_500, source: "receipt" },
			contextTokensAtEnd: { value: 0, source: "estimated" },
			compactions: { value: 0, source: "ledger" },
			expectedColdReasons: {
				residency: { value: 1, source: "ledger" },
				thinking_change: { value: 1, source: "ledger" },
			},
		});
	});

	it("folds a dispatched worker stream into prompt cache and timing ledger entries", () => {
		let observedAt = 10;
		const fold = createEvalCallLedgerFold(() => observedAt);
		fold.push(
			`${JSON.stringify({ type: "message_start", message: { role: "assistant", timestamp: 1_788_000_000_000 } })}\n`,
		);
		observedAt = 25;
		fold.push(`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta" } })}\n`);
		observedAt = 50;
		fold.push(
			`${JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					timestamp: 1_788_000_000_000,
					usage: { input: 60, output: 5, cacheRead: 40, cacheWrite: 0, reasoning: 0 },
					backendTimings: {
						promptTokens: 100,
						cachedTokens: 40,
						predictedTokens: 5,
						promptMs: 12,
						predictedMs: 8,
						source: "llamacpp-timings",
					},
				},
			})}\n`,
		);
		const entries = fold.entries();
		strictEqual(entries.length, 1);
		const metrics = buildEvalTrackedMetrics({ ledgerEntries: entries, receipt: null, fallbackWallClockMs: 40 });
		deepStrictEqual(metrics.modelCalls, { value: 1, source: "ledger" });
		deepStrictEqual(metrics.uncachedPrefillTokens, { value: 60, source: "ledger" });
		deepStrictEqual(metrics.cacheReadTokens, { value: 40, source: "ledger" });
		deepStrictEqual(metrics.generatedTokens, { value: 5, source: "ledger" });
		deepStrictEqual(metrics.ttftMsFirstCall, { value: 15, source: "ledger" });
		deepStrictEqual(metrics.contextTokensAtEnd, { value: 105, source: "ledger" });

		observedAt = 60;
		fold.push(
			`${JSON.stringify({ type: "message_start", message: { role: "assistant", timestamp: 1_788_000_001_000 } })}\n`,
		);
		observedAt = 70;
		fold.push(
			`${JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					timestamp: 1_788_000_001_000,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			})}\n`,
		);
		const afterEmptyTerminalCall = buildEvalTrackedMetrics({
			ledgerEntries: fold.entries(),
			receipt: null,
			fallbackWallClockMs: 60,
		});
		deepStrictEqual(afterEmptyTerminalCall.contextTokensAtEnd, { value: 105, source: "ledger" });
	});

	it("aggregates pass at k, pass power k, means, and nearest-rank p90", () => {
		const first = emptyEvalTrackedMetrics("ledger");
		const second = emptyEvalTrackedMetrics("ledger");
		const third = emptyEvalTrackedMetrics("ledger");
		first.modelCalls.value = 1;
		second.modelCalls.value = 5;
		third.modelCalls.value = 9;
		const [aggregate] = aggregateEvalVerdicts([
			envelope("pass", "ok", 0, first),
			envelope("fail", "ok", 1, second),
			envelope("pass", "ok", 2, third),
		]);

		strictEqual(aggregate?.trials, 3);
		strictEqual(aggregate?.k, 3);
		strictEqual(aggregate?.passAtK, 1);
		strictEqual(aggregate?.passPowK, 0);
		strictEqual(aggregate?.trackedMetrics.modelCalls.mean, 5);
		strictEqual(aggregate?.trackedMetrics.modelCalls.p90, 9);
		deepStrictEqual(aggregate?.trackedMetrics.modelCalls.sources, ["ledger"]);
	});
});
