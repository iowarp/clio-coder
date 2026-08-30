import { strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	compareEvalArtifactsV4,
	EvalServingConfigurationDriftError,
	renderEvalComparisonV4,
} from "../../src/domains/eval/compare/compare.js";
import { aggregateEvalVerdicts } from "../../src/domains/eval/metrics/aggregate.js";
import { emptyEvalTrackedMetrics } from "../../src/domains/eval/metrics/tracked.js";
import { EvalTrackedMetricSourceMismatchError } from "../../src/domains/eval/run-compare.js";
import type { EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";
import type { EvalMetricSource, EvalVerdictEnvelopeV1 } from "../../src/domains/eval/schema/verdict.js";

function artifact(evalId: string, serverBuild: string, modelCalls: number, source: EvalMetricSource): EvalArtifactV4 {
	const trackedMetrics = emptyEvalTrackedMetrics("ledger");
	trackedMetrics.modelCalls = { value: modelCalls, source };
	const verdict: EvalVerdictEnvelopeV1 = {
		schema: "clio.eval.verdict.v1",
		scenarioId: "tracked-scenario",
		trialIndex: 0,
		outcome: "pass",
		machinery: "ok",
		trackedMetrics,
		behavioral: null,
		evidence: { assignmentId: null, terminalReceiptDigest: null, graderExitCode: 0 },
	};
	return {
		version: 4,
		evalId,
		suite: { id: "tracked", hash: "a".repeat(64) },
		clio: { version: "test", commit: null, entry: "dist/cli/index.js" },
		environment: { platform: "linux-x64", node: process.version },
		matrix: { target: "mini", model: "qwen", thinking: "off" },
		servingConfiguration: {
			targetId: "mini",
			runtimeId: "llamacpp",
			modelId: "qwen",
			serverBuild,
			total_slots: 1,
			thinkingLevel: "off",
			compiledPromptHash: "b".repeat(64),
		},
		summary: {
			runs: 1,
			passed: 1,
			failed: 0,
			passRate: 1,
			tokens: { measured: false, runs: 1, measuredRuns: 0 },
			wallTimeMs: 100,
		},
		aggregates: aggregateEvalVerdicts([verdict]),
		results: [
			{
				assignmentId: null,
				terminalReceiptDigest: null,
				taskId: "tracked-scenario",
				repeatIndex: 0,
				target: { id: "mini", model: "qwen", thinking: "off" },
				pass: true,
				failureClass: null,
				metrics: { "result.pass": true },
				artifacts: {},
				verdict,
			},
		],
	};
}

describe("contracts/eval tracked comparison", () => {
	it("refuses serving configuration drift unless the caller allows it", () => {
		const baseline = artifact("eval-baseline", "build-a", 2, "ledger");
		const candidate = artifact("eval-candidate", "build-b", 4, "ledger");

		throws(() => compareEvalArtifactsV4(baseline, candidate), EvalServingConfigurationDriftError);
		const compared = compareEvalArtifactsV4(baseline, candidate, {
			allowConfigDrift: true,
			metric: "trackedMetrics.modelCalls",
		});
		strictEqual(compared.configDrift, true);
		strictEqual(compared.trackedMetrics.length, 1);
		strictEqual(compared.trackedMetrics[0]?.meanDelta, 2);
		const rendered = renderEvalComparisonV4(compared);
		strictEqual(rendered.includes("baseline serving:"), true);
		strictEqual(rendered.includes("server_build=build-a"), true);
		strictEqual(rendered.includes("candidate serving:"), true);
		strictEqual(rendered.includes("server_build=build-b"), true);
	});

	it("refuses to diff an estimate against a measurement", () => {
		const baseline = artifact("eval-baseline", "same-build", 2, "ledger");
		const candidate = artifact("eval-candidate", "same-build", 4, "estimated");
		throws(
			() => compareEvalArtifactsV4(baseline, candidate, { metric: "modelCalls" }),
			EvalTrackedMetricSourceMismatchError,
		);
	});
});
