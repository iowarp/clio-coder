/**
 * Shared run + receipt types for the dispatch domain (Phase 6 slice 2).
 *
 * RunEnvelope is the live record kept in the ledger (runs.json). RunReceipt is
 * the per-run artifact written under receipts/<runId>.json on completion. Both
 * are pure data: no class methods, no engine refs.
 */

import type { SkillActivation } from "../../core/skill-activation.js";
import type { ToolProfileName } from "../../tools/profiles.js";
import type { AgentAudience } from "../agents/spec.js";
import type { RuntimeTargetSnapshot } from "../providers/index.js";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "stale" | "dead";

/**
 * Terminal outcome taxonomy. Every run that reaches finalization gets exactly
 * one outcome, resolved at the single finalization point in extension.ts via
 * resolveRunOutcome(). No call site assigns an outcome literal directly.
 * Retry policy and audit semantics branch on the outcome, not on RunStatus,
 * which is kept for backward compatibility with pre-existing ledgers.
 */
export type RunOutcome =
	| "succeeded" // worker exited 0, receipt complete
	| "failed" // worker exited nonzero or threw
	| "timed_out" // exceeded turn/run timeout
	| "stalled" // heartbeat dead or ACP event-inactivity exceeded
	| "canceled" // operator abort (SIGINT, /abort, batch cancel)
	| "denied_by_policy" // admission, budget, scope, or cooldown rejection
	| "spawn_failed"; // process never reached a live session

export const RETRYABLE_OUTCOMES: ReadonlySet<RunOutcome> = new Set(["failed", "timed_out", "stalled", "spawn_failed"]);

/**
 * Proof-of-work lineage. Retries inherit rootRunId, increment attempt, keep
 * depth. Nested dispatch (a fleet step, a worker that dispatches) increments
 * depth, resets attempt, and points parentRunId at the dispatching run.
 */
export interface RunLineage {
	parentRunId: string | null; // run that dispatched or retried this one
	rootRunId: string; // first ancestor; equals runId for roots
	attempt: number; // 0 for first attempt, increments per retry
	depth: number; // 0 for operator-initiated, +1 per nesting level
}

/**
 * Host and HPC-scheduler identity captured at run start. A receipt produced
 * inside a Slurm/PBS/LSF allocation carries the allocation identity so the
 * provenance chain anchors to the scheduler job, not folklore.
 */
export interface RunIdentity {
	host: string;
	user: string;
	hpc: {
		scheduler: "slurm" | "pbs" | "lsf";
		jobId: string;
		jobName: string | null;
		cluster: string | null;
	} | null;
}

/**
 * Runtime kind recorded on a run envelope/receipt. "http" covers Clio-owned
 * pi-agent model runtimes; "sdk" and "subprocess" cover sanctioned worker
 * runtimes with dedicated worker runners; "acp-delegation" covers external
 * Agent Client Protocol harnesses that Clio supervises as delegated coding
 * agents.
 */
export type RunKind = "http" | "sdk" | "subprocess" | "acp-delegation";
export type DispatchRequestOrigin = "user" | "agent" | "internal";

export interface RunReceiptIntegrity {
	version: 1 | 2;
	algorithm: "sha256";
	digest: string;
}

export interface RunEnvelope {
	id: string;
	agentId: string;
	agentAudience?: AgentAudience;
	requestOrigin?: DispatchRequestOrigin;
	task: string;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	runtimeKind: RunKind;
	startedAt: string;
	endedAt: string | null;
	status: RunStatus;
	/** Terminal outcome; null until the run finalizes. Absent on pre-taxonomy rows. */
	outcome?: RunOutcome | null;
	outcomeDetail?: string | null;
	lineage?: RunLineage;
	identity?: RunIdentity;
	exitCode: number | null;
	pid: number | null;
	heartbeatAt: string | null;
	receiptPath: string | null;
	sessionId: string | null;
	cwd: string;
	tokenCount: number;
	/** Input/output token split; written at finalization, absent on pre-split ledgers. */
	inputTokenCount?: number;
	outputTokenCount?: number;
	reasoningTokenCount?: number;
	cacheReadTokenCount?: number;
	cacheWriteTokenCount?: number;
	staticShellHash?: string | null;
	sessionShellHash?: string | null;
	dynamicHash?: string | null;
	promptSignature?: string | null;
	toolSignature?: string | null;
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

/**
 * Deterministic activity totals aggregated from toolStats at finalization.
 * `mutatingSucceeded` reports whether any successful call's action class can
 * change state, using the safety domain's classifier; it is mechanical
 * bookkeeping, not a judgment about whether the task was accomplished.
 */
export interface ToolActivitySummary {
	calls: number;
	succeeded: number;
	failed: number;
	blocked: number;
	mutatingSucceeded: boolean;
}

export interface SafetyBlockedAttempt {
	tool: string;
	posture?: string;
	actionClass?: string;
	ruleId?: string;
	reasonCode?: string;
	policySource?: string;
	reason?: string;
}

export interface DelegationToolCallLogEntry {
	callId: string;
	tool: string;
	arguments: Record<string, unknown>;
	decision: "approved" | "denied" | "cancelled" | "error";
	reason?: string;
	safetyDecision?: {
		kind: "allow" | "ask" | "block";
		reasonCode?: string;
		policySource?: string;
		ruleId?: string;
	};
	durationMs: number;
	timestamp: string;
}

export interface RunReceiptDelegation {
	agentConfigId: string;
	command: string;
	args: string[];
	acpSessionId: string | null;
	acpProtocolVersion: number | null;
	acpAgentName: string | null;
	acpAgentVersion: string | null;
	agentCapabilities: Record<string, unknown>;
	toolCallsRequested: number;
	toolCallsApproved: number;
	toolCallsDenied: number;
	toolGovernance: "clio-policy" | "agent-managed" | "deny-all";
	toolCallLog: DelegationToolCallLogEntry[];
}

export interface RunReceiptSafetySummary {
	decisions: {
		allowed: number;
		blocked: number;
		permissionRequested: number;
	};
	blockedAttempts: SafetyBlockedAttempt[];
	requestedActions: ReadonlyArray<string>;
	toolProfile?: ToolProfileName;
	runtimeLimitations: ReadonlyArray<string>;
}

export interface RunReceiptReproducibility {
	cwd: string;
	git: {
		branch: string | null;
		commit: string | null;
		dirty: boolean | null;
		dirtyEntries: number | null;
		statusHash: string | null;
	};
	safetyPolicy: {
		version: number;
		rulePackHash: string | null;
		rulePackVersion: number | null;
		projectPolicyPath: string | null;
		projectPolicyHash: string | null;
		projectPolicyValid: boolean | null;
	};
}

export interface RunReceiptUpstreamResponse {
	model: string | null;
	responseModel: string | null;
	responseId: string | null;
}

export interface RunReceipt {
	runId: string;
	agentId: string;
	agentAudience?: AgentAudience;
	requestOrigin?: DispatchRequestOrigin;
	task: string;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	runtimeKind: RunKind;
	startedAt: string;
	endedAt: string;
	/** Terminal outcome; present on every receipt written after the taxonomy landed. */
	outcome?: RunOutcome;
	outcomeDetail?: string | null;
	lineage?: RunLineage;
	identity?: RunIdentity;
	exitCode: number;
	failureMessage?: string;
	tokenCount: number;
	inputTokenCount?: number;
	outputTokenCount?: number;
	cacheReadTokenCount?: number;
	cacheWriteTokenCount?: number;
	reasoningTokenCount?: number;
	upstreamResponses?: RunReceiptUpstreamResponse[];
	costUsd: number;
	compiledPromptHash: string | null;
	staticCompositionHash: string | null;
	staticShellHash?: string | null;
	sessionShellHash?: string | null;
	dynamicHash?: string | null;
	promptSignature?: string | null;
	toolSignature?: string | null;
	clioVersion: string;
	piMonoVersion: string;
	platform: string;
	nodeVersion: string;
	toolCalls: number;
	toolStats: ToolCallStat[];
	toolActivity?: ToolActivitySummary;
	skillActivations?: SkillActivation[];
	safety?: RunReceiptSafetySummary;
	reproducibility?: RunReceiptReproducibility;
	/** Effective target/runtime/model/thinking/capability decision for this run. */
	runtimeResolution?: RuntimeTargetSnapshot;
	delegation?: RunReceiptDelegation;
	sessionId: string | null;
	integrity: RunReceiptIntegrity;
}

export type RunReceiptDraft = Omit<RunReceipt, "integrity">;
