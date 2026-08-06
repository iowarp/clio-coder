import type { EvalClioProvenance, EvalEnvironmentProvenance } from "../types.js";

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
	summary: EvalArtifactSummaryV4;
	results: EvalArtifactResultV4[];
}

export const ZERO_TOKEN_METRICS_V4: EvalTokenMetricsV4 = {
	input: 0,
	output: 0,
	total: 0,
	cacheRead: 0,
	cacheWrite: 0,
};
