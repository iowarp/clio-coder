import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEvalArtifactV4 } from "../../src/domains/eval/artifacts/store.js";
import { compareEvalArtifactsV4 } from "../../src/domains/eval/compare/compare.js";
import { emptyEvalTrackedMetrics } from "../../src/domains/eval/metrics/tracked.js";
import { renderEvalComparisonReportV1 } from "../../src/domains/eval/reports/comparison.js";
import { renderEvalJunitReportV4 } from "../../src/domains/eval/reports/junit.js";
import { renderEvalMarkdownReportV4 } from "../../src/domains/eval/reports/markdown.js";
import { renderEvalTextReportV4 } from "../../src/domains/eval/reports/text.js";
import type { EvalArtifactResultV4, EvalArtifactV4 } from "../../src/domains/eval/schema/artifact.js";
import { EVAL_BEHAVIOR_CATEGORIES, type EvalBehaviorVerdictV1 } from "../../src/domains/eval/schema/behavioral.js";
import {
	buildEvalBehaviorMetricsV1,
	EVAL_BEHAVIOR_METRIC_DEFINITIONS_V1,
	EVAL_BEHAVIOR_METRICS_SCHEMA_V1,
	type EvalBehaviorMetricNameV1,
} from "../../src/domains/eval/schema/behavioral-metrics.js";

const DIGEST = "a".repeat(64);

describe("contracts/eval behavioral multi-metric comparison", () => {
	it("keeps correctness hard while reporting cheaper, steadier execution separately", () => {
		const baseline = artifact("eval-baseline", [
			trial(0, { "correctness.taskSolved": 1, "efficiency.toolCalls": 10, "cost.usd": 1 }),
			trial(1, { "correctness.taskSolved": 1, "efficiency.toolCalls": 12, "cost.usd": 1 }),
			trial(2, { "correctness.taskSolved": 1, "efficiency.toolCalls": 14, "cost.usd": 1 }),
		]);
		const candidate = artifact("eval-candidate", [
			trial(0, { "correctness.taskSolved": 1, "efficiency.toolCalls": 8, "cost.usd": 0.5 }),
			trial(1, { "correctness.taskSolved": 0, "efficiency.toolCalls": 8, "cost.usd": 0.5 }),
			trial(2, { "correctness.taskSolved": 1, "efficiency.toolCalls": 8, "cost.usd": 0.5 }),
		]);

		const compared = compareEvalArtifactsV4(baseline, candidate);
		strictEqual(compared.hardGate.pass, false);
		deepStrictEqual(
			compared.hardGate.failures.map((failure) => [failure.metric, failure.change]),
			[["correctness.taskSolved", "regressed"]],
		);
		const correctness = row(compared, "correctness.taskSolved");
		strictEqual(correctness.change, "regressed");
		strictEqual(correctness.baseline.mean, 1);
		strictEqual(correctness.candidate.mean, 2 / 3);
		const tools = row(compared, "efficiency.toolCalls");
		strictEqual(tools.change, "improved");
		strictEqual(tools.baseline.variance, 8 / 3);
		strictEqual(tools.candidate.variance, 0);
		strictEqual(tools.varianceChange, "improved");
		strictEqual(row(compared, "cost.usd").change, "improved");
		strictEqual(tools.role, "main");
		deepStrictEqual(tools.target, { id: "mini", model: "qwen" });
	});

	it("keeps missing values null and marks an unmeasured hard metric incomparable", () => {
		const baseline = artifact("eval-baseline", [trial(0, { "safety.violations": 0 })]);
		const candidate = artifact("eval-candidate", [trial(0, { "safety.violations": null })]);

		const compared = compareEvalArtifactsV4(baseline, candidate);
		const safety = row(compared, "safety.violations");
		strictEqual(safety.candidate.mean, null);
		strictEqual(safety.candidate.measured, 0);
		strictEqual(safety.candidate.unmeasured, 1);
		strictEqual(safety.change, "incomparable");
		strictEqual(compared.hardGate.pass, false);
		deepStrictEqual(
			compared.hardGate.failures.map((failure) => failure.metric),
			["safety.violations"],
		);
	});

	it("renders the same hard verdict and metric classifications in every comparison format", () => {
		const baseline = artifact("eval-baseline", [trial(0, { "correctness.taskSolved": 1 })]);
		const candidate = artifact("eval-candidate", [trial(0, { "correctness.taskSolved": 0 })]);
		const compared = compareEvalArtifactsV4(baseline, candidate);

		const text = renderEvalComparisonReportV1(compared, "text");
		match(text, /behavioral hard gate: fail \(1\)/u);
		match(text, /correctness\.taskSolved.*regressed/u);
		const json = JSON.parse(renderEvalComparisonReportV1(compared, "json")) as typeof compared;
		strictEqual(json.hardGate.pass, false);
		strictEqual(row(json, "correctness.taskSolved").change, "regressed");
		const markdown = renderEvalComparisonReportV1(compared, "md");
		match(markdown, /Behavioral hard gate: \*\*fail\*\*/u);
		match(markdown, /\| correctness \| correctness\.taskSolved .*\| regressed \|/u);
		const junit = renderEvalComparisonReportV1(compared, "junit");
		match(junit, /failures="1"/u);
		match(junit, /failure message="regressed"/u);
	});

	it("parses the additive projection and keeps artifact reports behaviorally fail-closed", () => {
		const result = trial(0, { "correctness.taskSolved": 1 }, "behavioral_failure");
		const input = artifact("eval-report", [result]);
		const parsed = parseEvalArtifactV4(structuredClone(input), "fixture");
		strictEqual(parsed.results[0]?.behavioralMetrics?.schema, EVAL_BEHAVIOR_METRICS_SCHEMA_V1);
		match(renderEvalTextReportV4(parsed), /behavioral: pass=0 failure=1/u);
		match(renderEvalMarkdownReportV4(parsed), /\| behavioral_failure \|/u);
		const junit = renderEvalJunitReportV4(parsed);
		match(junit, /failures="1"/u);
		match(junit, /failure message="behavioral_failure"/u);
	});

	it("derives tool, grader, label, runner, and receipt observations without filling absence with zero", () => {
		const result = trial(0, {});
		result.metrics = {
			"task.solved": true,
			"tools.totalCalls": 4,
			"tools.read.outsideAllowed": 2,
			"claims.unsupported": 1,
			"latency.wallMs": 25,
			"cost.usd": 0.2,
		};
		const projection = buildEvalBehaviorMetricsV1(result, "main");
		deepStrictEqual(projection.metrics["correctness.taskSolved"], { value: 1, source: "grader" });
		deepStrictEqual(projection.metrics["efficiency.toolCalls"], { value: 4, source: "tool-event" });
		deepStrictEqual(projection.metrics["exploration.unnecessaryReads"], { value: 2, source: "tool-event" });
		deepStrictEqual(projection.metrics["claims.unsupported"], { value: 1, source: "grader" });
		deepStrictEqual(projection.metrics["latency.wallMs"], { value: 25, source: "runner" });
		deepStrictEqual(projection.metrics["cost.usd"], { value: 0.2, source: "receipt" });
		deepStrictEqual(projection.metrics["tokens.total"], { value: null, source: "runner" });
	});

	it("keeps the label-violation count null when any category lacks a decisive label", () => {
		const result = trial(0, {});
		const first = result.behavioral?.labels[0];
		if (first === undefined) throw new Error("behavioral fixture has no labels");
		first.label = "unknown";
		const projection = buildEvalBehaviorMetricsV1(result, "main");
		deepStrictEqual(projection.metrics["behavior.labelViolations"], {
			value: null,
			source: "behavioral-label",
		});
	});
});

function row(summary: ReturnType<typeof compareEvalArtifactsV4>, metric: EvalBehaviorMetricNameV1) {
	const found = summary.behavioralMetrics.find((entry) => entry.metric === metric);
	if (found === undefined) throw new Error(`missing comparison row ${metric}`);
	return found;
}

function artifact(evalId: string, results: EvalArtifactResultV4[]): EvalArtifactV4 {
	return {
		version: 4,
		evalId,
		suite: { id: "behavior-compare", hash: DIGEST },
		clio: { version: "test", commit: null, entry: "dist/cli/index.js" },
		environment: { platform: "linux-x64", node: process.version },
		matrix: { target: "mini", model: "qwen", thinking: "off" },
		servingConfiguration: {
			targetId: "mini",
			runtimeId: "llamacpp",
			modelId: "qwen",
			serverBuild: "same-build",
			total_slots: 1,
			thinkingLevel: "off",
			compiledPromptHash: DIGEST,
		},
		summary: {
			runs: results.length,
			passed: results.length,
			failed: 0,
			passRate: 1,
			tokens: { measured: false, runs: results.length, measuredRuns: 0 },
			wallTimeMs: 100,
		},
		results,
	};
}

function trial(
	repeatIndex: number,
	values: Partial<Record<EvalBehaviorMetricNameV1, number | null>>,
	outcome: EvalBehaviorVerdictV1["outcome"] = "pass",
): EvalArtifactResultV4 {
	const behavioral = behavior(outcome, repeatIndex);
	return {
		assignmentId: null,
		terminalReceiptDigest: null,
		taskId: "behavior-case",
		repeatIndex,
		target: { id: "mini", model: "qwen", thinking: "off" },
		pass: true,
		failureClass: null,
		metrics: {},
		artifacts: {},
		verdict: {
			schema: "clio.eval.verdict.v1",
			scenarioId: "behavior-case",
			trialIndex: repeatIndex,
			outcome: "pass",
			machinery: "ok",
			reason: null,
			trackedMetrics: emptyEvalTrackedMetrics(),
			behavioral: null,
			evidence: { assignmentId: null, terminalReceiptDigest: null, graderExitCode: 0 },
		},
		behavioral,
		behavioralMetrics: {
			schema: EVAL_BEHAVIOR_METRICS_SCHEMA_V1,
			scenarioId: "behavior-case",
			role: "main",
			target: { id: "mini", model: "qwen" },
			metrics: Object.fromEntries(
				EVAL_BEHAVIOR_METRIC_DEFINITIONS_V1.map((definition) => [
					definition.name,
					{
						value: Object.hasOwn(values, definition.name) ? (values[definition.name] ?? null) : defaultValue(definition.name),
						source: definition.source,
					},
				]),
			) as NonNullable<EvalArtifactResultV4["behavioralMetrics"]>["metrics"],
		},
	};
}

function defaultValue(metric: EvalBehaviorMetricNameV1): number | null {
	if (metric === "correctness.taskSolved" || metric === "delegation.quality") return 1;
	if (metric === "safety.violations" || metric === "behavior.labelViolations" || metric === "claims.unsupported") {
		return 0;
	}
	return null;
}

function behavior(outcome: EvalBehaviorVerdictV1["outcome"], repeatIndex: number): EvalBehaviorVerdictV1 {
	const failing = outcome === "behavioral_failure";
	return {
		schema: "clio.eval.behavior.v1",
		verdictRef: { schema: "clio.eval.verdict.v1", scenarioId: "behavior-case", trialIndex: repeatIndex },
		corpus: { id: "public-behavior", version: "1.0.0" },
		judgeInputDigest: DIGEST,
		outcome,
		labels: EVAL_BEHAVIOR_CATEGORIES.map((category, index) => ({
			category,
			label: failing && index === 0 ? "violated" : "satisfied",
			ruleIds: [`rule-${category}`],
			evidence: [
				{
					factId: `fact-${category}`,
					source: "grader",
					locator: `metrics.${category}`,
					digest: DIGEST,
					excerpt: null,
				},
			],
			explanation: null,
		})),
	};
}
