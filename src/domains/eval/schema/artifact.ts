import type { EvalClioProvenance, EvalEnvironmentProvenance } from "../types.js";

export interface EvalTokenMetricsV2 {
	input: number;
	output: number;
	total: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface EvalArtifactSummaryV2 {
	runs: number;
	passed: number;
	failed: number;
	passRate: number;
	tokens: EvalTokenMetricsV2;
	wallTimeMs: number;
}

export interface EvalArtifactResultV2 {
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

export interface EvalArtifactV2 {
	version: 2;
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
	summary: EvalArtifactSummaryV2;
	results: EvalArtifactResultV2[];
}

export const ZERO_TOKEN_METRICS_V2: EvalTokenMetricsV2 = {
	input: 0,
	output: 0,
	total: 0,
	cacheRead: 0,
	cacheWrite: 0,
};
