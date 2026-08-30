import { aggregateEvalVerdicts, type EvalMetricDistributionV1 } from "../metrics/aggregate.js";
import { assertComparableTrackedMetricSources } from "../run-compare.js";
import type { EvalArtifactV4 } from "../schema/artifact.js";
import {
	type EvalServingConfigurationV1,
	renderEvalServingConfiguration,
	sameEvalServingConfiguration,
} from "../schema/serving.js";
import { EVAL_TRACKED_METRIC_NAMES } from "../schema/verdict.js";

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
	return {
		baselineEvalId: baseline.evalId,
		candidateEvalId: candidate.evalId,
		baselineServingConfiguration: baselineServing,
		candidateServingConfiguration: candidateServing,
		configDrift,
		passRateDelta: candidate.summary.passRate - baseline.summary.passRate,
		tokenDelta: baselineTokens.measured && candidateTokens.measured ? candidateTokens.total - baselineTokens.total : null,
		wallTimeDelta: candidate.summary.wallTimeMs - baseline.summary.wallTimeMs,
		trackedMetrics: compareTrackedMetrics(baseline, candidate, options.metric),
	};
}

export function renderEvalComparisonV4(summary: EvalCompareV4Summary): string {
	const tracked = summary.trackedMetrics.flatMap((row, index) => [
		...(index === 0
			? [
					"tracked metrics:",
					"scenario metric baseline_mean baseline_p90 candidate_mean candidate_p90 mean_delta p90_delta sources",
				]
			: []),
		[
			row.scenarioId,
			row.metric,
			formatMetric(row.baseline.mean),
			formatMetric(row.baseline.p90),
			formatMetric(row.candidate.mean),
			formatMetric(row.candidate.p90),
			formatSignedMetric(row.meanDelta),
			formatSignedMetric(row.p90Delta),
			`${row.baseline.sources.join("+") || "none"}->${row.candidate.sources.join("+") || "none"}`,
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
		...tracked,
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
			const absent: EvalMetricDistributionV1 = { mean: 0, p90: 0, sources: ["ledger"] };
			rows.push(
				metricComparison(
					scenarioId,
					metric,
					baselineAggregate.trackedMetrics.expectedColdReasons[reason] ?? absent,
					candidateAggregate.trackedMetrics.expectedColdReasons[reason] ?? absent,
				),
			);
		}
	}
	if (metricFilter !== undefined && rows.length === 0) {
		throw new Error(`tracked metric not found: ${metricFilter}`);
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
	return {
		scenarioId,
		metric,
		baseline,
		candidate,
		meanDelta: subtractNullable(candidate.mean, baseline.mean),
		p90Delta: subtractNullable(candidate.p90, baseline.p90),
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
	return trimmed;
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
