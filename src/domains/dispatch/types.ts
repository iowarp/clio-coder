/**
 * Shared run + receipt types for the dispatch domain (Phase 6 slice 2).
 *
 * RunEnvelope is the live record kept in the ledger (runs.json). RunReceipt is
 * the per-run artifact written under receipts/<runId>.json on completion. Both
 * are pure data: no class methods, no engine refs.
 */

export type RunStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "stale" | "dead";

export type RunKind = "http" | "subprocess" | "sdk";

export interface RunReceiptIntegrity {
	version: 1;
	algorithm: "sha256";
	digest: string;
}

export interface RunEnvelope {
	id: string;
	agentId: string;
	task: string;
	endpointId: string;
	wireModelId: string;
	runtimeId: string;
	runtimeKind: RunKind;
	startedAt: string;
	endedAt: string | null;
	status: RunStatus;
	exitCode: number | null;
	pid: number | null;
	heartbeatAt: string | null;
	receiptPath: string | null;
	sessionId: string | null;
	cwd: string;
	tokenCount: number;
	costUsd: number;
}

/**
 * Per-tool aggregates folded into a receipt at run completion. Sourced from
 * the worker's ToolTelemetry stream (`clio_tool_finish` IPC events). Sorted
 * by tool name on write so digests are deterministic across runs.
 */
export interface ToolCallStat {
	tool: string;
	count: number;
	ok: number;
	errors: number;
	blocked: number;
	totalDurationMs: number;
}

export interface RunReceipt {
	runId: string;
	agentId: string;
	task: string;
	endpointId: string;
	wireModelId: string;
	runtimeId: string;
	runtimeKind: RunKind;
	startedAt: string;
	endedAt: string;
	exitCode: number;
	tokenCount: number;
	costUsd: number;
	compiledPromptHash: string | null;
	staticCompositionHash: string | null;
	clioVersion: string;
	piMonoVersion: string;
	platform: string;
	nodeVersion: string;
	toolCalls: number;
	toolStats: ToolCallStat[];
	sessionId: string | null;
	integrity: RunReceiptIntegrity;
}

export type RunReceiptDraft = Omit<RunReceipt, "integrity">;
