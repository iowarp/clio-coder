import { aggregateEvalVerdicts, type EvalMetricDistributionV1 } from "../metrics/aggregate.js";
import { assertComparableTrackedMetricSources } from "../run-compare.js";
import type { EvalArtifactV4 } from "../schema/artifact.js";
import {
	type EvalServingConfigurationV1,
	renderEvalServingConfiguration,
	sameEvalServingConfiguration,
} from "../schema/serving.js";
import { EVAL_TRACKED_METRIC_NAMES } from "../schema/verdict.js";
import {
	classifyChange,
	compareEvalBehaviorMetricsV1,
	type EvalBehaviorHardGateV1,
	type EvalBehaviorMetricComparisonV1,
	type EvalMetricChangeV1,
} from "./behavioral.js";

export interface EvalCompareV4Options {
	metric?: string;
	allowConfigDrift?: boolean;
}

export interface EvalTrackedMetricComparisonV1 {
	scenarioId: string;
	metric: string;
	baseline: EvalMetricDistributionV1;
	candidate: EvalMetricDistributionV1;
	meanDelta: number | null;
	p90Delta: number | null;
	varianceDelta: number | null;
	change: EvalMetricChangeV1;
	varianceChange: EvalMetricChangeV1;
}

export interface EvalCompareV4Summary {
	baselineEvalId: string;
	candidateEvalId: string;
	baselineServingConfiguration: EvalServingConfigurationV1;
	candidateServingConfiguration: EvalServingConfigurationV1;
	configDrift: boolean;
	passRateDelta: number;
	/** Null when either side observed no usage because a delta against an unknown is not zero. */
	tokenDelta: number | null;
	wallTimeDelta: number;
	trackedMetrics: EvalTrackedMetricComparisonV1[];
	behavioralMetrics: EvalBehaviorMetricComparisonV1[];
	hardGate: EvalBehaviorHardGateV1;
}

export class EvalServingConfigurationDriftError extends Error {
	readonly baseline: EvalServingConfigurationV1;
	readonly candidate: EvalServingConfigurationV1;

	constructor(baseline: EvalServingConfigurationV1, candidate: EvalServingConfigurationV1) {
		super(
			[
				"serving configuration drift; pass --allow-config-drift to compare these runs",
				`baseline serving: ${renderEvalServingConfiguration(baseline)}`,
				`candidate serving: ${renderEvalServingConfiguration(candidate)}`,
			].join("\n"),
		);
		this.name = "EvalServingConfigurationDriftError";
		this.baseline = baseline;
		this.candidate = candidate;
	}
}

export function compareEvalArtifactsV4(
	baseline: EvalArtifactV4,
	candidate: EvalArtifactV4,
	options: EvalCompareV4Options = {},
): EvalCompareV4Summary {
	const baselineTokens = baseline.summary.tokens;
	const candidateTokens = candidate.summary.tokens;
	const baselineServing = servingConfigurationOf(baseline);
	const candidateServing = servingConfigurationOf(candidate);
	const configDrift = !sameEvalServingConfiguration(baselineServing, candidateServing);
	if (configDrift && options.allowConfigDrift !== true) {
		throw new EvalServingConfigurationDriftError(baselineServing, candidateServing);
	}
	const behavioral = compareEvalBehaviorMetricsV1(baseline, candidate);
	const trackedMetrics = compareTrackedMetrics(baseline, candidate, options.metric);
	const normalizedFilter = normalizeMetricFilter(options.metric);
	const behavioralMetrics =
		normalizedFilter === undefined
			? behavioral.comparisons
			: behavioral.comparisons.filter((row) => row.metric === normalizedFilter || row.family === normalizedFilter);
	if (options.metric !== undefined && trackedMetrics.length === 0 && behavioralMetrics.length === 0) {
		throw new Error(`eval metric not found: ${options.metric}`);
	}
	return {
		baselineEvalId: baseline.evalId,
		candidateEvalId: candidate.evalId,
		baselineServingConfiguration: baselineServing,
		candidateServingConfiguration: candidateServing,
		configDrift,
		passRateDelta: candidate.summary.passRate - baseline.summary.passRate,
		tokenDelta: baselineTokens.measured && candidateTokens.measured ? candidateTokens.total - baselineTokens.total : null,
		wallTimeDelta: candidate.summary.wallTimeMs - baseline.summary.wallTimeMs,
		trackedMetrics,
		behavioralMetrics,
		hardGate: behavioral.hardGate,
	};
}

export function renderEvalComparisonV4(summary: EvalCompareV4Summary): string {
	const hardFailures = summary.hardGate.failures.map(
		(failure) =>
			`  hard failure: ${failure.scenarioId} ${failure.role} ${failure.target.id}/${failure.target.model ?? "none"} ${failure.metric} ${failure.change}`,
	);
	const tracked = summary.trackedMetrics.flatMap((row, index) => [
		...(index === 0
			? [
					"tracked metrics:",
					"scenario metric baseline_mean baseline_p90 baseline_variance candidate_mean candidate_p90 candidate_variance mean_delta p90_delta variance_delta change variance_change sources",
				]
			: []),
		[
			row.scenarioId,
			row.metric,
			formatMetric(row.baseline.mean),
			formatMetric(row.baseline.p90),
			formatMetric(row.baseline.variance ?? null),
			formatMetric(row.candidate.mean),
			formatMetric(row.candidate.p90),
			formatMetric(row.candidate.variance ?? null),
			formatSignedMetric(row.meanDelta),
			formatSignedMetric(row.p90Delta),
			formatSignedMetric(row.varianceDelta),
			row.change,
			row.varianceChange,
			`${row.baseline.sources.join("+") || "none"}->${row.candidate.sources.join("+") || "none"}`,
		].join(" "),
	]);
	const behavioral = summary.behavioralMetrics.flatMap((row, index) => [
		...(index === 0
			? [
					"behavioral metrics:",
					"scenario role target model family metric baseline_mean baseline_variance baseline_coverage candidate_mean candidate_variance candidate_coverage mean_delta variance_delta change variance_change gate source",
				]
			: []),
		[
			row.scenarioId,
			row.role,
			row.target.id,
			row.target.model ?? "none",
			row.family,
			row.metric,
			formatMetric(row.baseline.mean),
			formatMetric(row.baseline.variance),
			`${row.baseline.measured}/${row.baseline.observations}`,
			formatMetric(row.candidate.mean),
			formatMetric(row.candidate.variance),
			`${row.candidate.measured}/${row.candidate.observations}`,
			formatSignedMetric(row.meanDelta),
			formatSignedMetric(row.varianceDelta),
			row.change,
			row.varianceChange,
			row.hardGate ? "hard" : "informational",
			row.baseline.source,
		].join(" "),
	]);
	return [
		`baseline eval: ${summary.baselineEvalId}`,
		`candidate eval: ${summary.candidateEvalId}`,
		`baseline serving: ${renderEvalServingConfiguration(summary.baselineServingConfiguration)}`,
		`candidate serving: ${renderEvalServingConfiguration(summary.candidateServingConfiguration)}`,
		`config drift: ${summary.configDrift ? "allowed" : "none"}`,
		`pass-rate delta: ${(summary.passRateDelta * 100).toFixed(2)}%`,
		`token delta: ${summary.tokenDelta === null ? "unmeasured" : summary.tokenDelta}`,
		`wall-time delta ms: ${summary.wallTimeDelta}`,
		`behavioral hard gate: ${summary.hardGate.pass ? "pass" : `fail (${summary.hardGate.failures.length})`}`,
		...hardFailures,
		...tracked,
		...behavioral,
		"",
	].join("\n");
}

function compareTrackedMetrics(
	baseline: EvalArtifactV4,
	candidate: EvalArtifactV4,
	metricFilter?: string,
): EvalTrackedMetricComparisonV1[] {
	const baselineAggregates =
		baseline.aggregates ??
		aggregateEvalVerdicts(baseline.results.flatMap((result) => (result.verdict === undefined ? [] : [result.verdict])));
	const candidateAggregates =
		candidate.aggregates ??
		aggregateEvalVerdicts(candidate.results.flatMap((result) => (result.verdict === undefined ? [] : [result.verdict])));
	const baselineByScenario = new Map(baselineAggregates.map((entry) => [entry.scenarioId, entry]));
	const candidateByScenario = new Map(candidateAggregates.map((entry) => [entry.scenarioId, entry]));
	const scenarioIds = [...baselineByScenario.keys()]
		.filter((scenarioId) => candidateByScenario.has(scenarioId))
		.sort((left, right) => left.localeCompare(right));
	const filter = normalizeMetricFilter(metricFilter);
	const rows: EvalTrackedMetricComparisonV1[] = [];
	for (const scenarioId of scenarioIds) {
		const baselineAggregate = baselineByScenario.get(scenarioId);
		const candidateAggregate = candidateByScenario.get(scenarioId);
		if (baselineAggregate === undefined || candidateAggregate === undefined) continue;
		for (const metric of EVAL_TRACKED_METRIC_NAMES) {
			if (filter !== undefined && filter !== metric) continue;
			rows.push(
				metricComparison(
					scenarioId,
					metric,
					baselineAggregate.trackedMetrics[metric],
					candidateAggregate.trackedMetrics[metric],
				),
			);
		}
		const reasons = new Set([
			...Object.keys(baselineAggregate.trackedMetrics.expectedColdReasons),
			...Object.keys(candidateAggregate.trackedMetrics.expectedColdReasons),
		]);
		for (const reason of [...reasons].sort((left, right) => left.localeCompare(right))) {
			const metric = `expectedColdReasons.${reason}`;
			if (filter !== undefined && filter !== metric && filter !== "expectedColdReasons") continue;
			rows.push(
				metricComparison(
					scenarioId,
					metric,
					baselineAggregate.trackedMetrics.expectedColdReasons[reason] ?? zeroDistribution(baselineAggregate.k),
					candidateAggregate.trackedMetrics.expectedColdReasons[reason] ?? zeroDistribution(candidateAggregate.k),
				),
			);
		}
	}
	return rows;
}

function metricComparison(
	scenarioId: string,
	metric: string,
	baseline: EvalMetricDistributionV1,
	candidate: EvalMetricDistributionV1,
): EvalTrackedMetricComparisonV1 {
	assertComparableTrackedMetricSources(`${scenarioId}.${metric}`, baseline.sources, candidate.sources);
	const direction = trackedMetricDirection(metric);
	return {
		scenarioId,
		metric,
		baseline,
		candidate,
		meanDelta: subtractNullable(candidate.mean, baseline.mean),
		p90Delta: subtractNullable(candidate.p90, baseline.p90),
		varianceDelta: subtractNullable(candidate.variance ?? null, baseline.variance ?? null),
		change: classifyChange(baseline.mean, candidate.mean, direction),
		varianceChange: classifyChange(baseline.variance ?? null, candidate.variance ?? null, "lower"),
	};
}

function servingConfigurationOf(artifact: EvalArtifactV4): EvalServingConfigurationV1 {
	return (
		artifact.servingConfiguration ?? {
			targetId: artifact.matrix.target,
			runtimeId: null,
			modelId: artifact.matrix.model,
			serverBuild: null,
			total_slots: null,
			thinkingLevel: artifact.matrix.thinking,
			compiledPromptHash: null,
		}
	);
}

function normalizeMetricFilter(metric: string | undefined): string | undefined {
	if (metric === undefined) return undefined;
	const trimmed = metric.trim();
	if (trimmed.startsWith("trackedMetrics.")) return trimmed.slice("trackedMetrics.".length);
	if (trimmed.startsWith("behavioralMetrics.")) return trimmed.slice("behavioralMetrics.".length);
	return trimmed;
}

function trackedMetricDirection(metric: string): "higher" | "lower" {
	return metric === "cacheReadTokens" ? "higher" : "lower";
}

function zeroDistribution(observations: number): EvalMetricDistributionV1 {
	return {
		observations,
		measured: observations,
		unmeasured: 0,
		mean: 0,
		min: 0,
		max: 0,
		p90: 0,
		variance: 0,
		standardDeviation: 0,
		sources: ["ledger"],
	};
}

function subtractNullable(left: number | null, right: number | null): number | null {
	return left === null || right === null ? null : left - right;
}

function formatMetric(value: number | null): string {
	return value === null ? "null" : Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatSignedMetric(value: number | null): string {
	if (value === null) return "null";
	const formatted = formatMetric(value);
	return value > 0 ? `+${formatted}` : formatted;
}
