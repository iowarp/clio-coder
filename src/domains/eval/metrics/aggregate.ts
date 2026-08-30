import {
	EVAL_TRACKED_METRIC_NAMES,
	type EvalMetricSource,
	type EvalTrackedMetricName,
	type EvalVerdictEnvelopeV1,
} from "../schema/verdict.js";

export interface EvalMetricDistributionV1 {
	mean: number | null;
	p90: number | null;
	sources: EvalMetricSource[];
}

export type EvalTrackedMetricDistributionsV1 = Record<EvalTrackedMetricName, EvalMetricDistributionV1> & {
	expectedColdReasons: Record<string, EvalMetricDistributionV1>;
};

export interface EvalScenarioAggregateV1 {
	scenarioId: string;
	trials: number;
	k: number;
	passed: number;
	failed: number;
	unmeasured: number;
	machineryFailures: number;
	passAtK: number;
	passPowK: number;
	trackedMetrics: EvalTrackedMetricDistributionsV1;
}

/** Aggregate each scenario independently so trial outcomes never cross tasks. */
export function aggregateEvalVerdicts(verdicts: ReadonlyArray<EvalVerdictEnvelopeV1>): EvalScenarioAggregateV1[] {
	const byScenario = new Map<string, EvalVerdictEnvelopeV1[]>();
	for (const verdict of verdicts) {
		const group = byScenario.get(verdict.scenarioId) ?? [];
		group.push(verdict);
		byScenario.set(verdict.scenarioId, group);
	}
	return [...byScenario.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([scenarioId, group]) => aggregateScenario(scenarioId, group));
}

function aggregateScenario(
	scenarioId: string,
	verdicts: ReadonlyArray<EvalVerdictEnvelopeV1>,
): EvalScenarioAggregateV1 {
	const ordered = [...verdicts].sort((left, right) => left.trialIndex - right.trialIndex);
	const passed = ordered.filter((verdict) => verdict.outcome === "pass").length;
	const failed = ordered.filter((verdict) => verdict.outcome === "fail").length;
	const unmeasured = ordered.filter((verdict) => verdict.outcome === "unmeasured").length;
	const machineryFailures = ordered.filter((verdict) => verdict.machinery === "infrastructure_failure").length;
	const fixed = Object.fromEntries(
		EVAL_TRACKED_METRIC_NAMES.map((name) => [name, distribution(ordered.map((verdict) => verdict.trackedMetrics[name]))]),
	) as Record<EvalTrackedMetricName, EvalMetricDistributionV1>;
	const reasons = new Set(ordered.flatMap((verdict) => Object.keys(verdict.trackedMetrics.expectedColdReasons)));
	const expectedColdReasons = Object.fromEntries(
		[...reasons]
			.sort((left, right) => left.localeCompare(right))
			.map((reason) => [
				reason,
				distribution(
					ordered.map(
						(verdict) => verdict.trackedMetrics.expectedColdReasons[reason] ?? { value: 0, source: "ledger" as const },
					),
				),
			]),
	);
	const k = ordered.length;
	return {
		scenarioId,
		trials: k,
		k,
		passed,
		failed,
		unmeasured,
		machineryFailures,
		passAtK: k > 0 && passed > 0 ? 1 : 0,
		passPowK: k > 0 && passed === k ? 1 : 0,
		trackedMetrics: { ...fixed, expectedColdReasons },
	};
}

function distribution(
	metrics: ReadonlyArray<{ value: number | null; source: EvalMetricSource }>,
): EvalMetricDistributionV1 {
	const values = metrics.flatMap((metric) => (metric.value === null ? [] : [metric.value]));
	const sources = [...new Set(metrics.map((metric) => metric.source))].sort(compareSources);
	if (values.length === 0) return { mean: null, p90: null, sources };
	const ordered = [...values].sort((left, right) => left - right);
	const p90Index = Math.max(0, Math.ceil(ordered.length * 0.9) - 1);
	return {
		mean: ordered.reduce((sum, value) => sum + value, 0) / ordered.length,
		p90: ordered[p90Index] ?? null,
		sources,
	};
}

function compareSources(left: EvalMetricSource, right: EvalMetricSource): number {
	return sourceOrder(left) - sourceOrder(right);
}

function sourceOrder(source: EvalMetricSource): number {
	if (source === "ledger") return 0;
	if (source === "receipt") return 1;
	return 2;
}
