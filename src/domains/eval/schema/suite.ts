import type { EvalBehaviorScenarioV1 } from "./behavioral.js";
import type { EvalExecutionMatrixDimensionV1 } from "./execution-envelope.js";

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
	"tools.read.distinctPaths",
	"tools.read.outsideAllowed",
	"tools.read.decoyHits",
	"tools.calls.dispatch",
	"tools.blocked.bash",
	"claims.unsupported",
	"completion.reported",
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
	"ledger.formatVersion",
	"ledger.toolPairsUnmatched",
	"ledger.assistantBetweenCallAndResult",
	"ledger.sessionCount",
	"continuity.compactionSummaryPresent",
	"continuity.answeredFromPreCompaction",
	"continuity.turnsAfterCompaction",
	"process.attestedWorkers",
	"process.orphanedChildren",
	// Write-boundary enforcement, read from the verdicts the run sealed. The
	// promise is not that nothing escaped the allowlist; it is that Clio saw what
	// did, named it, rolled back what git could restore, and left a signed record
	// against the baseline it measured.
	"boundary.verdictCount",
	"boundary.verdictSealed",
	"boundary.violationsDetected",
	"boundary.violationsRolledBack",
	"boundary.rollbackIncomplete",
	// Bounded loops. The declared bound is the promise: attempts never exceed it,
	// every attempt after the first seals its own recovery receipt, and a bound
	// spent without a pass reports loop_bound_exhausted rather than a false green.
	// `loop.resolved` is the model's result, measured beside them and never a gate.
	"loop.count",
	"loop.attemptsSpent",
	"loop.repairsSpent",
	"loop.resolved",
	"loop.reasonExhausted",
	// The terminal reason is one Clio declares and agrees with `resolved`. This
	// is the promise that holds across every ending, including the ones that
	// never spend the bound, so it is the one a suite can gate unconditionally.
	"loop.reasonDeclared",
	"loop.unneededNodes",
	"loop.skippedNodes",
	"loop.receiptsMatchRepairs",
	"receipt.recoveryCount",
	// Receipt-derived accounting. A different observation from `tokens.*` above,
	// with a different provenance: what Clio sealed and authenticated, rather
	// than what a provider was watched reporting on the runner's own stdout. A
	// surface that publishes no usage stream (`clio-coder fleet run --json` drains its
	// workers' events) still seals the cost, so this is how a bounded loop's cost
	// is read. The two are never merged, and this family never enters
	// `summary.tokens`. Counts appear only beside `measured: true`; an
	// incomplete or unauthenticated receipt set reports false and no counts.
	"receiptUsage.measured",
	"receiptUsage.receiptCount",
	"receiptUsage.totalTokens",
	"receiptUsage.costUsd",
	"stream.messageUpdateCount",
	"stream.usageDoubleCounted",
	"stream.segmentUsageMatchesMessages",
	// The task outcome: whether the model solved the workload. Its exit code is
	// recorded beside the machinery invariants so a failed final result can still
	// say "the grader failed and Clio behaved" rather than conflating the two.
	"task.exitCode",
	"task.solved",
] as const;

/**
 * Per-tool call and block counters use a dynamic suffix because extension tool
 * ids are not closed at build time. They otherwise have the same scalar,
 * observable-event semantics as the fixed canonical metrics above.
 */
export const CANONICAL_METRIC_PREFIXES = ["tools.calls.", "tools.blocked."] as const;

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
	/** Execution-envelope fields this suite intentionally varies. All other fields must match for comparison. */
	dimensions?: EvalExecutionMatrixDimensionV1[];
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
	/** One-run headless authority used to exercise allow and deny recovery. */
	autonomy?: "read-only" | "suggest" | "auto-edit" | "full-auto";
	/**
	 * Fleet agent recipe id for the clio-run runner. When set the runner
	 * invokes `clio-coder run --agent <id> --json`, whose stream ends with the full
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
	 * Commands that grade the task outcome. They run in the workspace before the
	 * machinery verifiers and record `task.exitCode` and `task.solved`; a nonzero
	 * exit fails the final result while the verdict keeps machinery `ok`. This is
	 * what keeps "the model did not solve it" distinct from "Clio broke".
	 */
	measure?: string[];
	assertions?: EvalMetricAssertion[];
	forbidPaths?: string[];
}

export interface EvalMetricsSpecV2 {
	collect: string[];
	/**
	 * Public fixture paths used to reduce read events to bounded counters. Raw
	 * paths stay out of behavioral fact values and evidence excerpts; the metric
	 * map records only distinct, outside-allowlist, and declared-decoy counts.
	 */
	readObservation?: { allowedPaths: string[]; decoyPaths: string[] };
}

export interface EvalSuiteTaskV2 {
	id: string;
	tags: string[];
	/** Additive behavioral contract evaluated against observable run facts. */
	behavioral?: EvalBehaviorScenarioV1;
	workspace: EvalWorkspaceV2;
	runner: EvalRunnerV2;
	verify: EvalVerifyV2;
	metrics: EvalMetricsSpecV2;
	timeoutMs: number;
}

export interface EvalSuiteThresholdsV2 {
	fail: EvalMetricAssertion[];
	/** Budget notices are reported but never change the command exit status. */
	informational?: EvalMetricAssertion[];
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
