import type { EvalScenarioAggregateV1 } from "../metrics/aggregate.js";
import type { EvalClioProvenance, EvalEnvironmentProvenance } from "../types.js";
import type { EvalBehaviorVerdictV1 } from "./behavioral.js";
import type { EvalBehaviorMetricsV1 } from "./behavioral-metrics.js";
import type { EvalServingConfigurationV1 } from "./serving.js";
import type { EvalVerdictEnvelopeV1 } from "./verdict.js";

export interface EvalTokenMetricsV4 {
	input: number;
	output: number;
	total: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Whole-artifact token accounting. The counts exist only when at least one run
 * reported provider usage, because a run whose Clio work happened out of the
 * harness's sight has no count and a numeric zero would claim it cost nothing.
 * `measuredRuns` of `runs` is the coverage the counts are true for.
 */
export type EvalTokenAccountingV4 =
	| { measured: false; runs: number; measuredRuns: 0 }
	| ({ measured: true; runs: number; measuredRuns: number } & EvalTokenMetricsV4);

export interface EvalArtifactSummaryV4 {
	runs: number;
	passed: number;
	failed: number;
	passRate: number;
	tokens: EvalTokenAccountingV4;
	wallTimeMs: number;
}

/** Required explicit linkage; null means this runner did not evaluate a dispatch assignment. */
export interface EvalArtifactAssignmentReference {
	assignmentId: string | null;
	terminalReceiptDigest: string | null;
}

export interface EvalArtifactResultV4 extends EvalArtifactAssignmentReference {
	taskId: string;
	repeatIndex: number;
	target: {
		id: string;
		model: string | null;
		thinking: string | null;
	};
	pass: boolean;
	failureClass: string | null;
	metrics: Record<string, number | string | boolean | null>;
	artifacts: Record<string, string | string[] | null>;
	/** Additive Suite v2 adapter output. Current runners always populate it. */
	verdict?: EvalVerdictEnvelopeV1;
	/** Optional sibling document that references the unchanged verdict v1 identity. */
	behavioral?: EvalBehaviorVerdictV1;
	/** Additive, typed multi-metric projection for behavioral comparison. */
	behavioralMetrics?: EvalBehaviorMetricsV1;
}

/** The only current eval artifact format. Routing accepts this version only. */
export interface EvalArtifactV4 {
	version: 4;
	evalId: string;
	suite: {
		id: string;
		hash: string;
	};
	clio: EvalClioProvenance;
	environment: EvalEnvironmentProvenance;
	matrix: {
		target: string;
		model: string | null;
		thinking: string | null;
	};
	/** Exact serving facts used to decide whether two eval runs are comparable. */
	servingConfiguration?: EvalServingConfigurationV1;
	summary: EvalArtifactSummaryV4;
	/** Scenario reductions over the versioned per-trial verdicts. */
	aggregates?: EvalScenarioAggregateV1[];
	results: EvalArtifactResultV4[];
}

export const ZERO_TOKEN_METRICS_V4: EvalTokenMetricsV4 = {
	input: 0,
	output: 0,
	total: 0,
	cacheRead: 0,
	cacheWrite: 0,
};
