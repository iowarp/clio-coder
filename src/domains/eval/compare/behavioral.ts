import type { EvalArtifactResultV4, EvalArtifactV4 } from "../schema/artifact.js";
import {
	EVAL_BEHAVIOR_METRIC_DEFINITIONS_V1,
	type EvalBehaviorMetricDefinitionV1,
	type EvalBehaviorMetricFamilyV1,
	type EvalBehaviorMetricNameV1,
	type EvalBehaviorMetricSourceV1,
} from "../schema/behavioral-metrics.js";
import type { EvalExecutionMatrixDimensionV1 } from "../schema/execution-envelope.js";
import {
	compareEvalExecutionEnvelopesV1,
	type EvalEnvelopeComparabilityV1,
	type EvalEnvelopeMismatchV1,
} from "./envelope.js";

export type EvalMetricChangeV1 = "improved" | "regressed" | "unchanged" | "incomparable";

export interface EvalBehaviorMetricDistributionV1 {
	observations: number;
	measured: number;
	unmeasured: number;
	mean: number | null;
	min: number | null;
	max: number | null;
	p90: number | null;
	variance: number | null;
	standardDeviation: number | null;
	source: EvalBehaviorMetricSourceV1;
}

export interface EvalBehaviorMetricComparisonV1 {
	scenarioId: string;
	role: string;
	target: { id: string; model: string | null };
	metric: EvalBehaviorMetricNameV1;
	family: EvalBehaviorMetricFamilyV1;
	direction: "higher" | "lower";
	hardGate: boolean;
	baseline: EvalBehaviorMetricDistributionV1;
	candidate: EvalBehaviorMetricDistributionV1;
	change: EvalMetricChangeV1;
	meanDelta: number | null;
	varianceChange: EvalMetricChangeV1;
	varianceDelta: number | null;
	comparability: EvalEnvelopeComparabilityV1;
}

export interface EvalBehaviorHardGateV1 {
	pass: boolean;
	envelopeFailures: EvalEnvelopeMismatchV1[];
	failures: Array<{
		scenarioId: string;
		role: string;
		target: { id: string; model: string | null };
		metric: EvalBehaviorMetricNameV1;
		change: "regressed" | "incomparable";
	}>;
}

interface BehaviorGroup {
	scenarioId: string;
	role: string;
	target: { id: string; model: string | null };
	results: EvalArtifactResultV4[];
}

export function compareEvalBehaviorMetricsV1(
	baseline: EvalArtifactV4,
	candidate: EvalArtifactV4,
): {
	comparisons: EvalBehaviorMetricComparisonV1[];
	hardGate: EvalBehaviorHardGateV1;
	envelopeMismatches: EvalEnvelopeMismatchV1[];
} {
	const baselineGroups = behaviorGroups(baseline);
	const candidateGroups = behaviorGroups(candidate);
	const keys = new Set([...baselineGroups.keys(), ...candidateGroups.keys()]);
	const comparisons: EvalBehaviorMetricComparisonV1[] = [];
	const envelopeMismatches: EvalEnvelopeMismatchV1[] = [];
	const baselineDimensions = baseline.matrix.dimensions ?? ([] as EvalExecutionMatrixDimensionV1[]);
	const candidateDimensions = candidate.matrix.dimensions ?? ([] as EvalExecutionMatrixDimensionV1[]);
	for (const key of [...keys].sort((left, right) => left.localeCompare(right))) {
		const baselineGroup = baselineGroups.get(key);
		const candidateGroup = candidateGroups.get(key);
		const identity = baselineGroup ?? candidateGroup;
		if (identity === undefined) continue;
		const envelopeMismatch = compareEvalExecutionEnvelopesV1(
			identity,
			baselineGroup?.results ?? [],
			candidateGroup?.results ?? [],
			baselineDimensions,
			candidateDimensions,
		);
		if (envelopeMismatch !== null) envelopeMismatches.push(envelopeMismatch);
		const comparability: EvalEnvelopeComparabilityV1 = {
			comparable: envelopeMismatch === null,
			mismatchedFields: envelopeMismatch?.fields ?? [],
		};
		for (const definition of EVAL_BEHAVIOR_METRIC_DEFINITIONS_V1) {
			const baselineDistribution = behaviorDistribution(baselineGroup?.results ?? [], definition);
			const candidateDistribution = behaviorDistribution(candidateGroup?.results ?? [], definition);
			comparisons.push({
				scenarioId: identity.scenarioId,
				role: identity.role,
				target: identity.target,
				metric: definition.name,
				family: definition.family,
				direction: definition.direction,
				hardGate: definition.hardGate,
				baseline: baselineDistribution,
				candidate: candidateDistribution,
				change:
					envelopeMismatch === null
						? classifyChange(baselineDistribution.mean, candidateDistribution.mean, definition.direction)
						: "incomparable",
				meanDelta: subtractNullable(candidateDistribution.mean, baselineDistribution.mean),
				varianceChange:
					envelopeMismatch === null
						? classifyChange(baselineDistribution.variance, candidateDistribution.variance, "lower")
						: "incomparable",
				varianceDelta: subtractNullable(candidateDistribution.variance, baselineDistribution.variance),
				comparability,
			});
		}
	}
	const failures = comparisons.flatMap((comparison) =>
		comparison.hardGate &&
		(comparison.change === "regressed" ||
			(comparison.change === "incomparable" && comparison.baseline.mean !== null && comparison.candidate.mean === null))
			? [
					{
						scenarioId: comparison.scenarioId,
						role: comparison.role,
						target: comparison.target,
						metric: comparison.metric,
						change: comparison.change,
					},
				]
			: [],
	);
	return {
		comparisons,
		hardGate: {
			pass: failures.length === 0 && envelopeMismatches.length === 0,
			failures,
			envelopeFailures: envelopeMismatches,
		},
		envelopeMismatches,
	};
}

export function classifyChange(
	baseline: number | null,
	candidate: number | null,
	direction: "higher" | "lower",
): EvalMetricChangeV1 {
	if (baseline === null || candidate === null) return "incomparable";
	if (baseline === candidate) return "unchanged";
	if (direction === "higher") return candidate > baseline ? "improved" : "regressed";
	return candidate < baseline ? "improved" : "regressed";
}

function behaviorGroups(artifact: EvalArtifactV4): Map<string, BehaviorGroup> {
	const groups = new Map<string, BehaviorGroup>();
	for (const result of artifact.results) {
		const behavioral = result.behavioralMetrics;
		if (behavioral === undefined) continue;
		const key = groupKey(behavioral.scenarioId, behavioral.role, behavioral.target);
		const group = groups.get(key) ?? {
			scenarioId: behavioral.scenarioId,
			role: behavioral.role,
			target: behavioral.target,
			results: [],
		};
		group.results.push(result);
		groups.set(key, group);
	}
	return groups;
}

function behaviorDistribution(
	results: ReadonlyArray<EvalArtifactResultV4>,
	definition: EvalBehaviorMetricDefinitionV1,
): EvalBehaviorMetricDistributionV1 {
	const observations = results.map((result) => result.behavioralMetrics?.metrics[definition.name].value ?? null);
	const values = observations.flatMap((value) => (value === null ? [] : [value]));
	if (values.length === 0) {
		return {
			observations: observations.length,
			measured: 0,
			unmeasured: observations.length,
			mean: null,
			min: null,
			max: null,
			p90: null,
			variance: null,
			standardDeviation: null,
			source: definition.source,
		};
	}
	const ordered = [...values].sort((left, right) => left - right);
	const mean = ordered.reduce((sum, value) => sum + value, 0) / ordered.length;
	const variance = ordered.reduce((sum, value) => sum + (value - mean) ** 2, 0) / ordered.length;
	return {
		observations: observations.length,
		measured: values.length,
		unmeasured: observations.length - values.length,
		mean,
		min: ordered[0] ?? null,
		max: ordered.at(-1) ?? null,
		p90: ordered[Math.max(0, Math.ceil(ordered.length * 0.9) - 1)] ?? null,
		variance,
		standardDeviation: Math.sqrt(variance),
		source: definition.source,
	};
}

function groupKey(scenarioId: string, role: string, target: { id: string; model: string | null }): string {
	return JSON.stringify([scenarioId, role, target.id, target.model]);
}

function subtractNullable(left: number | null, right: number | null): number | null {
	return left === null || right === null ? null : left - right;
}
