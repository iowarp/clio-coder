export const EVAL_SUITE_V2_VERSION = 2;

export const CANONICAL_METRICS = [
	"tokens.input",
	"tokens.output",
	"tokens.total",
	"tokens.cacheRead",
	"tokens.cacheWrite",
	"latency.wallMs",
	"tools.totalCalls",
	"tools.failed",
	"tools.blocked",
	"context.indexedFiles",
	"context.coverage",
	"context.structuralHash",
	"context.digestTokens",
	"verifier.exitCode",
	"patch.bytes",
	"patch.filesChanged",
	"patch.testFilesModified",
	"result.pass",
	"result.failureClass",
] as const;

export type EvalMetricName = (typeof CANONICAL_METRICS)[number];
export type EvalAssertionOp = "lt" | "lte" | "gt" | "gte" | "eq" | "neq";
export type EvalRunnerKind = "clio-run" | "context-index" | "context-init" | "external-command";
export type EvalWorkspaceKind = "local" | "git" | "temp-copy";

export interface EvalMetricAssertion {
	metric: string;
	op: EvalAssertionOp;
	value: number | string | boolean;
}

export interface EvalSuiteInfoV2 {
	id: string;
	title: string;
	visibility: string;
	description?: string;
	provenance?: Record<string, unknown>;
}

export interface EvalSuiteTargetV2 {
	id: string;
	model?: string;
	thinking?: string;
}

export interface EvalSuiteMatrixV2 {
	targets: EvalSuiteTargetV2[];
	repeats: number;
}

export interface EvalWorkspaceV2 {
	kind: EvalWorkspaceKind;
	path?: string;
	url?: string;
	commit?: string;
	checkout?: string;
	excludes?: string[];
}

export interface EvalRunnerV2 {
	kind: EvalRunnerKind;
	prompt?: string;
	command?: string;
	commands?: string[];
	args?: string[];
	timeoutMs?: number;
}

export interface EvalVerifyV2 {
	commands?: string[];
	assertions?: EvalMetricAssertion[];
	forbidPaths?: string[];
}

export interface EvalMetricsSpecV2 {
	collect: string[];
}

export interface EvalSuiteTaskV2 {
	id: string;
	tags: string[];
	workspace: EvalWorkspaceV2;
	runner: EvalRunnerV2;
	verify: EvalVerifyV2;
	metrics: EvalMetricsSpecV2;
	timeoutMs: number;
}

export interface EvalSuiteThresholdsV2 {
	fail: EvalMetricAssertion[];
}

export interface EvalSuiteV2 {
	version: 2;
	suite: EvalSuiteInfoV2;
	matrix: EvalSuiteMatrixV2;
	tasks: EvalSuiteTaskV2[];
	thresholds?: EvalSuiteThresholdsV2;
}

export interface LoadedEvalSuiteV2 {
	path: string;
	baseDir: string;
	hash: string;
	suite: EvalSuiteV2;
}
