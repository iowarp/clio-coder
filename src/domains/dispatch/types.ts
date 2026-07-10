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
import type { EvidenceTag } from "../evidence/index.js";
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
 * A ledger row is terminal once finalization stamped its end, or once its
 * status left the live pair (covers adopted orphans and dead-marked rows
 * whose endedAt was never written). Shared by monitor wait/collect and the
 * detached-batch nudge so "done" means the same thing everywhere.
 */
export function isTerminalRunEnvelope(run: RunEnvelope): boolean {
	if (run.endedAt !== null) return true;
	return run.status !== "queued" && run.status !== "running";
}

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
 * Provenance for a pipeline step whose worker received the previous step's
 * final output as threaded dynamic input. Absent on step 1 and on every
 * non-pipeline run. `inputBytes` is the UTF-8 byte length of the upstream
 * text before the 12000-char cap; `inputTruncated` records whether the cap
 * clipped it. Follows the optional-field pattern of `lineage`/`identity`.
 */
export interface RunPipelineProvenance {
	fromRunId: string | null; // run whose output was threaded in; null when unknown
	position: number; // 1-based index of this step in the chain
	inputBytes: number; // UTF-8 byte length of the upstream text before capping
	inputTruncated: boolean; // true when the 12000-char cap clipped the input
}

/**
 * Explicit marker for an ad-hoc specialist whose orchestrator-authored persona
 * replaced the recipe body in the stable worker prompt.
 */
export interface RunPersonaOverride {
	promptHash: string; // same hash as staticCompositionHash for the composed prompt
}

/**
 * Effective project-context decision for a run, recorded on every receipt so
 * evidence can prove what a worker saw without rehashing. `tier: "none"` is
 * written explicitly: it distinguishes "policy said none" from a
 * pre-provenance receipt where the whole block is absent. `chars` and
 * `contentHash` describe the rendered dynamic message body when bounded;
 * `sections` lists extra projected sections that actually rendered
 * (currently only "verification-expectations", never for ACP delegation).
 */
export interface RunProjectContextProvenance {
	tier: "none" | "bounded";
	chars?: number;
	contentHash?: string;
	sections?: string[];
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
 * Fleet node the worker process ran on, recorded at dispatch time from the
 * placement decision. Absent on runs dispatched before fleet placement landed
 * and on bundles with no fleet configured; renderers treat absence as the
 * local node. `host` is the configured node address for ssh transports;
 * `identity.host` (detected orchestrator-side) still names the orchestrator.
 */
export interface RunNodeIdentity {
	id: string;
	kind: "local" | "ssh";
	host?: string;
}

/**
 * One dead-node failover hop. Appended when an in-flight or queued dispatch
 * is requeued from a node classified dead onto an eligible survivor, so the
 * receipt chain records the full placement lineage, not just the final node.
 */
export interface RunNodeReroute {
	attempt: number;
	fromNode: string;
	toNode: string;
	reason: string;
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
	version: 1 | 2 | 3;
	algorithm: "sha256";
	digest: string;
}

/**
 * Compact, durable, integrity-covered findings summary folded onto a receipt at
 * record time (the durable half of the v0.2.7 "Both" findings-sink decision).
 * It is computed cheaply from the envelope/outcome/exitCode/toolStats, never by
 * calling buildEvidence (which reads the receipt and would create a cycle). The
 * full forensic bundle is the enriched version; this is the always-present
 * compact half. The v3 integrity branch folds it into the digest, so the
 * payload must stay JSON-clean: tags is a stably ordered array, firstPassSuccess
 * a boolean, findingCount a finite number. No undefined inside.
 */
export interface RunReceiptFindingsSummary {
	tags: EvidenceTag[];
	firstPassSuccess: boolean;
	findingCount: number;
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
	/** Fleet node placement; absent when no fleet placement resolved this run. */
	node?: RunNodeIdentity;
	/** Dead-node failover hops, oldest first; absent when the run was never rerouted. */
	reroutes?: RunNodeReroute[];
	/** Pipeline threading provenance; present only on pipeline steps after the first. */
	pipeline?: RunPipelineProvenance;
	/** Ad-hoc specialist provenance; present only when a persona override composed the stable prompt. */
	personaOverride?: RunPersonaOverride;
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
	/**
	 * The decision axis: how the safety classifier admitted each tool call. It is
	 * distinct from the outcome axis (`blockedAttempts`, plus `toolStats`/
	 * `toolActivity` blocked counts), which records whether a call executed.
	 * `allowed` + `blocked` + `permissionRequested` equals the total tool calls.
	 * `blocked` counts only hard denials by a policy rule or a tool guard
	 * (reason code `guard_block`); a call that required permission and was denied
	 * non-interactively is counted under `permissionRequested`, not `blocked`, so
	 * scripts can tell "approval would have been needed" apart from a policy
	 * block (see docs/safety-model.md). Such a call still appears in
	 * `blockedAttempts` because its outcome was blocked, so `decisions.blocked`
	 * is not a proxy for the number of blocked attempts; use `blockedAttempts`
	 * or the `toolStats`/`toolActivity` blocked counts for that.
	 */
	decisions: {
		allowed: number;
		blocked: number;
		permissionRequested: number;
		/**
		 * Worker permission-escalation tallies. Present only on receipts that saw
		 * at least one escalation (onPermission="escalate"), so deny/fail
		 * receipts stay byte-identical. `requested` counts parked asks handed to
		 * the operator; `approved`/`denied` count operator decisions; `timedOut`
		 * counts asks resolved by the timeout fallback.
		 */
		escalationRequested?: number;
		escalationApproved?: number;
		escalationDenied?: number;
		escalationTimedOut?: number;
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

export type RunAutonomyEnforcementGrade = "mediated" | "approximated" | "bypassed";

export interface RunReceiptAutonomyEnforcement {
	grade: RunAutonomyEnforcementGrade;
	autonomy: string;
	externalMode?: string;
	dangerousBypass?: boolean;
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
	/** Fleet node placement; absent when no fleet placement resolved this run. */
	node?: RunNodeIdentity;
	/** Dead-node failover hops, oldest first; absent when the run was never rerouted. */
	reroutes?: RunNodeReroute[];
	/** Pipeline threading provenance; present only on pipeline steps after the first. */
	pipeline?: RunPipelineProvenance;
	/** Ad-hoc specialist provenance; present only when a persona override composed the stable prompt. */
	personaOverride?: RunPersonaOverride;
	/** Effective project-context tier for this run; absent on receipts written before this field landed. */
	projectContext?: RunProjectContextProvenance;
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
	/** How this runtime enforced the run's captured autonomy level. */
	autonomyEnforcement?: RunReceiptAutonomyEnforcement;
	safety?: RunReceiptSafetySummary;
	reproducibility?: RunReceiptReproducibility;
	/** Effective target/runtime/model/thinking/capability decision for this run. */
	runtimeResolution?: RuntimeTargetSnapshot;
	delegation?: RunReceiptDelegation;
	/** Compact findings summary; absent on receipts written before v3 integrity. */
	findingsSummary?: RunReceiptFindingsSummary;
	sessionId: string | null;
	integrity: RunReceiptIntegrity;
}

export type RunReceiptDraft = Omit<RunReceipt, "integrity">;
