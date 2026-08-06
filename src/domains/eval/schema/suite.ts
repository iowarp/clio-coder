export const EVAL_SUITE_V2_VERSION = 2;

export const CANONICAL_METRICS = [
	"tokens.input",
	"tokens.output",
	"tokens.total",
	"tokens.cacheRead",
	"tokens.cacheWrite",
	// False when the runner observed no provider usage at all. The counts above
	// are absent in that case rather than zero, so a gate on cost can require
	// measurement instead of reading silence as free.
	"tokens.measured",
	"latency.wallMs",
	"latency.modelMs",
	"tools.totalCalls",
	"tools.failed",
	"tools.blocked",
	"context.indexedFiles",
	"context.coverage",
	"context.structuralHash",
	"context.digestTokens",
	"context.clioMdBytes",
	"context.initMode",
	"context.initParserOutcome",
	"context.initFallback",
	"context.initPromptBytes",
	"context.initOutputBytes",
	"context.initTargetId",
	"context.initModelId",
	"context.initRuntimeId",
	"context.initRuntimeKind",
	"context.initThinkingLevel",
	"context.initStructuredOutputMode",
	"verifier.exitCode",
	"patch.bytes",
	"patch.filesChanged",
	"patch.testFilesModified",
	"result.pass",
	"result.failureClass",
	// Receipt-derived evidence metrics. Sourced only from the sealed receipt
	// (never dispatch/monitor prose labels); absent receipt leaves them
	// unresolved so gates fail closed.
	"evidence.verification",
	"evidence.firstPassSuccess",
	"cost.usd",
	// Behavioral checkpoints for the bounded reconnaissance live suite.
	"dispatch.count",
	"wiki.staleAcknowledged",
	// Invariant checks: what Clio promised about its own machinery, read from
	// the journal the item's run left behind. These are true or false about
	// Clio and say nothing about whether the model solved the task. A check
	// the runner could not compute is absent, so a threshold on it fails
	// closed rather than reading silence as compliance.
	"receipt.count",
	"receipt.rootCount",
	"receipt.sealed",
	"receipt.integrityValid",
	"receipt.outcomeMatchesExit",
	"process.attestedWorkers",
	"process.orphanedChildren",
	"stream.messageUpdateCount",
	"stream.usageDoubleCounted",
	"stream.segmentUsageMatchesMessages",
	// The task outcome, measured and never gated: whether the model solved the
	// workload. Reported beside the invariants above so a report can say "the
	// model failed and Clio behaved" instead of one number for both.
	"task.exitCode",
	"task.solved",
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
	/**
	 * Cumulative receipt-cost ceiling in USD for the whole matrix. Once the
	 * summed `cost.usd` of finished items exceeds it, remaining items fail
	 * closed as budget_exhausted instead of running. Runs without a receipt
	 * contribute zero; the ceiling bounds known cost, it does not price
	 * unpriced runs.
	 */
	maxCostUsd?: number;
}

export interface EvalWorkspaceV2 {
	kind: EvalWorkspaceKind;
	path?: string;
	url?: string;
	commit?: string;
	checkout?: string;
	excludes?: string[];
	/**
	 * Commands that seed the prepared workspace before the runner starts, so a
	 * fixture can pin a baseline commit the patch metrics and write-boundary
	 * enforcement measure against. A failing setup fails the item: an item whose
	 * fixture never came up measured nothing.
	 */
	setup?: string[];
}

export interface EvalRunnerV2 {
	kind: EvalRunnerKind;
	prompt?: string;
	/**
	 * Fleet agent recipe id for the clio-run runner. When set the runner
	 * invokes `clio run --agent <id> --json`, whose stream ends with the full
	 * sealed RunReceipt, so receipt-derived evidence metrics resolve. Without
	 * it the main-agent headless path runs and emits no receipt.
	 */
	agent?: string;
	command?: string;
	commands?: string[];
	args?: string[];
	timeoutMs?: number;
}

export interface EvalVerifyV2 {
	commands?: string[];
	/**
	 * Commands that measure the task outcome without gating on it. They run in
	 * the workspace before the gating verifiers and record `task.exitCode` and
	 * `task.solved`; a nonzero exit is data, never a failure. This is what keeps
	 * "the model did not solve it" from being reported as "Clio broke", which
	 * `commands` above cannot express because a failing verifier fails the item.
	 */
	measure?: string[];
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
