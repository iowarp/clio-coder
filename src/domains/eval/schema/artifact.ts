import type { EvalClioProvenance, EvalEnvironmentProvenance } from "../types.js";

export interface EvalTokenMetricsV3 {
	input: number;
	output: number;
	total: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface EvalArtifactSummaryV3 {
	runs: number;
	passed: number;
	failed: number;
	passRate: number;
	tokens: EvalTokenMetricsV3;
	wallTimeMs: number;
}

/** Required explicit linkage; null means this runner did not evaluate a dispatch assignment. */
export interface EvalArtifactAssignmentReference {
	assignmentId: string | null;
	terminalReceiptDigest: string | null;
}

export interface EvalArtifactResultV3 extends EvalArtifactAssignmentReference {
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
export interface EvalArtifactV3 {
	version: 3;
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
	summary: EvalArtifactSummaryV3;
	results: EvalArtifactResultV3[];
}

export const ZERO_TOKEN_METRICS_V3: EvalTokenMetricsV3 = {
	input: 0,
	output: 0,
	total: 0,
	cacheRead: 0,
	cacheWrite: 0,
};
