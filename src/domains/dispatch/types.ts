/**
 * Shared run + receipt types for the dispatch domain (Phase 6 slice 2).
 *
 * RunEnvelope is the live record kept in the ledger (runs.json). RunReceipt is
 * the per-run artifact written under receipts/<runId>.json on completion. Both
 * are pure data: no class methods, no engine refs.
 */

import type { GatewayRoutingObservation } from "../../core/gateway-routing.js";
import type { ResponseModelIdObservation } from "../../core/response-model-id.js";
import type { SkillActivation } from "../../core/skill-activation.js";
import type { ToolProfileName } from "../../tools/profiles.js";
import type { AgentAudience } from "../agents/spec.js";
import type { EvidenceTag } from "../evidence/index.js";
import type { CostProvenance, RuntimeTargetSnapshot } from "../providers/index.js";
import type { RunToolBudgetEnvelope } from "./budget-envelope.js";
import type { ExecutionRole, GateTopologyRole } from "./execution-role.js";
import type { DispatchIntent } from "./intent.js";
import type { DispatchPathScopeProvenance } from "./path-scope.js";
import type { RouteDecisionV1 } from "./route-decision.js";
import type { RoutingIntent } from "./routing-intent.js";

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

/** Stable machine classifications for terminal conditions that drive policy. */
export type RunOutcomeCode =
	| "vram_capacity_fit_failure"
	| "worker_tool_call_cap_exhausted"
	| "loop_guard_tools_disabled_exhausted"
	| "result_contract_exhausted"
	| "worker_final_output_missing"
	| "host_verification_rejected";

export function isRunOutcomeCode(value: unknown): value is RunOutcomeCode {
	return (
		value === "vram_capacity_fit_failure" ||
		value === "worker_tool_call_cap_exhausted" ||
		value === "loop_guard_tools_disabled_exhausted" ||
		value === "result_contract_exhausted" ||
		value === "worker_final_output_missing" ||
		value === "host_verification_rejected"
	);
}

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

/** Integrity-covered proof of the exact bounded briefing content sent to a worker. */
export interface RunBriefingProvenance {
	bytes: number;
	contentHash: string;
}

/**
 * Integrity-covered proof that one canonical steering message was written to
 * the native worker channel, without retaining the steering prose itself.
 * Acknowledgements are matched to sent entries in stable sequence order.
 */
export interface RunSteeringProvenance {
	sequence: number;
	bytes: number;
	contentHash: string;
	sentAt: string;
	acknowledged: boolean;
	acknowledgedAt?: string;
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
 * evidence can prove what a worker saw without rehashing. `tier` is the
 * recipe's CLIO-CODER.md handbook policy and is written explicitly: `none`
 * distinguishes "policy said none" from a pre-provenance receipt where the
 * whole block is absent. `chars` and `contentHash` describe every structured
 * message that was actually sent, whatever the tier, and `sections` names
 * them: `workspace-root` (sent under both tiers, so a none-tier run still
 * records characters), `clio-md` (bounded only), and
 * `verification-expectations` (bounded only, never for ACP delegation). A
 * none-tier block naming only `workspace-root` is a consistent record; the
 * trust adapter treats any other none-tier content as contradictory.
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
 * Bounded projection of a worker's attestation into the receipt.
 *
 * Endpoints appear only as an identity hash, so a receipt names which endpoint
 * served a run without carrying its URL or credentials. Unknown resource facts
 * are null rather than zero: the receipt records that the node could not
 * observe the value, not that the value was absent.
 */
export interface RunReceiptAttestation {
	protocolVersion: number;
	/** Host identity as the executing node reported it, not as the orchestrator assumed. */
	host: string;
	pid: number;
	processGroupId: number | null;
	settingsFingerprint: string;
	specDigest: string;
	targetId: string;
	endpointIdentityHash: string;
	wireModelId: string;
	runtimeId: string;
	toolSignature: string;
	resources: {
		labels: string[];
		cpuCount: number | null;
		totalMemoryBytes: number | null;
		gpuCount: number | null;
		vramBytes: number | null;
	};
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
 * One receipt-chain reference to another run in the same gate group. `digest`
 * is the referenced run's receipt integrity digest at reference time (null
 * when the referenced run sealed no receipt, e.g. a spawn failure).
 */
export interface RunGateSubjectRef {
	runId: string;
	digest: string | null;
}

/** Storage route used for one compete candidate's isolated checkout. */
export interface RunGateWorktreeProvenance {
	backend: "herdr" | "native";
	path: string;
	branch: string;
	/** Herdr workspace created around the worktree; absent for the native route. */
	workspaceId?: string;
	/** Why the native route was selected when mux was configured. */
	fallback?: "mux-unavailable" | "mux-operation-failed";
}

/**
 * Review/compete gate provenance, carried on the request and sealed into the
 * receipt. References point backward only: a reviewer references the builder
 * it reviewed, a revise builder references the reviewer whose findings it
 * received, a judge references every candidate it ranked. The chain is
 * reconstructed newest-to-oldest from these links; verdicts are evidenced on
 * the run they caused (`verdict` on a revise builder is the reviewer verdict
 * that triggered it).
 */
export interface RunGateProvenance {
	role: GateTopologyRole;
	/** Gate group id shared by every run of one gated dispatch. */
	group: string;
	/** 1-based review cycle, or candidate ordinal for compete candidates. */
	cycle: number;
	/** Runs this run reviews, revises from, or judges; absent on the first builder. */
	subjects?: RunGateSubjectRef[];
	/** Reviewer verdict that caused this run; only on revise builders. */
	verdict?: "pass" | "fail" | "revise";
	/** Compete-only worktree route, sealed into the run receipt with the gate. */
	worktree?: RunGateWorktreeProvenance;
}

export interface RunCouncilProvenance {
	group: string;
	label: string;
	color?: string;
	round: number;
}

/**
 * Plan-approval provenance for multi-task, compete, or remote dispatch.
 * `approval: "operator"` records that a supervised autonomy level parked the
 * dispatch call and an operator approved the plan; `"full-auto"` records that
 * full-auto skipped the stop and the plan was logged instead. The hash covers
 * the rendered plan artifact so every run of the plan chains to the same
 * approved text.
 */
export interface RunPlanProvenance {
	hash: string;
	topology: "parallel" | "sequential" | "pipeline" | "review" | "compete" | "council" | "detached" | "fleet";
	taskCount: number;
	approval: "operator" | "full-auto";
	source: null | {
		kind: "scout-transition";
		runId: string;
		receiptDigest: string;
		executionPlanHash: string;
	};
	/** Registry-issued identity of the one-shot operator approval, when applicable. */
	approvalRequestId?: string;
	approvalRequestedBy?: string;
	costCeilingUsd?: number;
}

/**
 * Runtime kind recorded on a run envelope/receipt. "http" covers Clio-owned
 * pi-agent model runtimes; "sdk" and "subprocess" cover sanctioned worker
 * runtimes with dedicated worker runners; "acp-delegation" covers external
 * Agent Client Protocol harnesses that Clio supervises as delegated coding
 * agents.
 */
export type RunKind = "http" | "sdk" | "subprocess" | "acp-delegation";

/** True only for worker runtimes whose live agent API can consume guidance. */
export function runKindSupportsLiveSteering(kind: RunKind): boolean {
	return kind === "http" || kind === "sdk";
}
export type DispatchRequestOrigin = "user" | "agent" | "internal";

/** Durable routing-system phase marks. They live on the ledger envelope, not the sealed receipt. */
export interface RunPhaseMarks {
	requestedAt: string;
	decisionStartedAt: string;
	decisionCompletedAt?: string;
	queuedAt?: string;
	admittedAt?: string;
	workerSpawnedAt?: string;
	firstModelTokenAt?: string;
	firstToolAt?: string;
	endedAt?: string;
}

/** Derived durations keep execution and user-observed end-to-end time explicitly distinct. */
export interface RunPhaseDurations {
	requestToDecisionMs: number | null;
	decisionMs: number | null;
	admissionWaitMs: number | null;
	queueWaitMs: number | null;
	spawnSetupMs: number | null;
	timeToFirstModelTokenMs: number | null;
	timeToFirstToolMs: number | null;
	executionMs: number | null;
	totalEndToEndMs: number | null;
}

/**
 * The one receipt integrity version. Clio is pre-1.0 with no installed base, so
 * there is nothing to keep verifying: a receipt is this version or it is not a
 * receipt. `receipt-integrity.ts` annotates its constant against this type, so
 * bumping one without the other is a compile error.
 */
export interface RunReceiptIntegrity {
	version: 20;
	algorithm: "sha256";
	digest: string;
}

/** One correctness-bearing validation result sealed at receipt finalization. */
export interface RunReceiptTypedValidationFact {
	sourceId: string;
	validatorDigest: string;
	passed: boolean;
}

/** The exact response-schema enforcement fact, distinct from answer correctness. */
export interface RunReceiptResponseSchemaFact {
	sourceId: string | null;
	schemaDigest: string | null;
	runtimeEnforceable: boolean;
	enforcementPassed: boolean | null;
}

/** Typed result-contract conformance and its separately eligible quality label. */
export interface RunReceiptResultContractFact {
	sourceId: string;
	validatorDigest: string;
	/** `not-reached` means the run never produced a terminal result to judge. */
	conformance: "pass" | "fail" | "not-reached";
	quality: "pass" | "fail" | "unmeasured";
}

/**
 * A terminal result's passing validation claims, measured against the commands
 * the run's own tool calls show it ran. Present only when the result carried at
 * least one passing claim under a contract kind that can be grounded, so a
 * receipt that claims nothing digests exactly as it did before this landed.
 */
export interface RunValidationGrounding {
	claimed: number;
	grounded: number;
	/** Claim names with no matching execution, stably ordered and bounded. */
	ungrounded: string[];
	/**
	 * `no-command-executed` is the hard case: the run claimed a passing check and
	 * ran nothing that could have produced one, so the quality label does not
	 * rest on it. `unmatched-command` means it ran commands the canonical
	 * detector does not enumerate, which is reported and nothing more.
	 */
	basis: "no-command-executed" | "unmatched-command";
}

/**
 * One run's sealed contribution to the agent ledger its dispatch coordinated
 * on. Sealed orchestrator-side from the stored entries; a worker reports
 * nothing about its own contribution.
 */
export interface RunLedgerContribution {
	ledgerId: string;
	posted: number;
	refused: number;
	/** sha256 over canonicalJson of this run's attributed entries in sequence order. */
	digest: string;
}

/**
 * The pairing of a read-only recipe with a task that needs a write, decided at
 * admission. Present only on a run the harness admitted with the mismatch
 * flagged; a refused pairing never becomes a run at all.
 */
export interface RunCapabilityMismatch {
	agentId: string;
	capabilityClass: string;
	taskType: string;
	suggestedAgentId: string | null;
}

/**
 * Required run-local quality facts. Later gate and evaluation artifacts link to
 * the sealed receipt digest rather than mutating this block after finalization.
 */
export interface RunReceiptQuality {
	version: 1;
	typedValidations: RunReceiptTypedValidationFact[];
	responseSchema: RunReceiptResponseSchemaFact;
	resultContract: RunReceiptResultContractFact | null;
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
	/** Semantic role this attempt's route statistics belong to. */
	executionRole: ExecutionRole;
	agentAudience?: AgentAudience;
	requestOrigin?: DispatchRequestOrigin;
	task: string;
	/** Immutable recipe policy, invocation request, effective phase, and admission reasons. */
	budget?: RunToolBudgetEnvelope;
	/** Present only when a bounded parent briefing was sent as dynamic task data. */
	briefing?: RunBriefingProvenance;
	/** Sent steering provenance in stable per-run sequence order; prose is never persisted. */
	steering?: ReadonlyArray<RunSteeringProvenance>;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	runtimeKind: RunKind;
	/** Durable side-channel timing; intentionally outside receipt integrity and optional on historical rows. */
	timing?: RunPhaseMarks;
	startedAt: string;
	endedAt: string | null;
	status: RunStatus;
	/** Terminal outcome; null until the run finalizes. Absent on pre-taxonomy rows. */
	outcome?: RunOutcome | null;
	outcomeDetail?: string | null;
	outcomeCode?: RunOutcomeCode | null;
	lineage?: RunLineage;
	identity?: RunIdentity;
	/** Fleet node placement; absent when no fleet placement resolved this run. */
	node?: RunNodeIdentity;
	/** Dead-node failover hops, oldest first; absent when the run was never rerouted. */
	reroutes?: RunNodeReroute[];
	/** Pipeline threading provenance; present only on pipeline steps after the first. */
	pipeline?: RunPipelineProvenance;
	/** Review/compete gate provenance; present only on runs of a gated dispatch. */
	gate?: RunGateProvenance;
	council?: RunCouncilProvenance;
	/** Plan-approval provenance; present only on runs of an approval-gated plan. */
	plan?: RunPlanProvenance;
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
	costProvenance?: CostProvenance;
}

/**
 * Per-tool aggregates folded into a receipt at run completion. Sourced from
 * the worker's ToolTelemetry stream (`clio_coder_tool_finish` IPC events). Sorted
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
	toolGovernance: "clio-coder-policy" | "agent-managed" | "deny-all";
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
	 * block (see docs/architecture/safety-model.md). Such a call still appears in
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
	/**
	 * Whether Clio observed a complete start/finish stream for this runtime's
	 * tool activity. Retry admission consumes this sealed fact before reusing
	 * the same checkout after a failed attempt.
	 */
	toolTelemetry?: {
		coverage: "complete" | "partial" | "unavailable";
		ingestionErrors: number;
		unfinished: ReadonlyArray<{ tool: string; count: number }>;
		workspaceMutationPossible: boolean;
	};
	/** Frozen parent-session hard blocks enforced by this worker specification. */
	protectedArtifacts?: {
		version: 1;
		count: number;
		stateHash: string;
	};
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
	requestedModelId: string | null;
	responseModelIdObservation: ResponseModelIdObservation;
	differingResponseModelId: string | null;
	providerResponseId: string | null;
	/** Physical route and proxy attempts reported by LiteLLM, when this call used that gateway. */
	gatewayRouting?: GatewayRoutingObservation;
}

/**
 * Bounded assistant output captured by the dispatch event pump and sealed into
 * the receipt so the worker's answer survives process exit and session resume.
 * `state: "final"` means the text is a completed assistant message (the last
 * `message_end`); `state: "partial"` means mid-stream text from a message that
 * never completed (abort, stall, kill) and must never be presented as final.
 * `bytes` is the UTF-8 length of the full captured text before the
 * WORKER_OUTPUT_MAX_BYTES bound; `truncated` records that the bound clipped
 * `text`, so truncation is always explicit. Absent when no assistant text was
 * captured. Covered by the receipt integrity digest like every other field.
 */
export interface RunReceiptOutput {
	state: "final" | "partial";
	text: string;
	bytes: number;
	truncated: boolean;
}

export type RunAutonomyEnforcementGrade = "mediated" | "approximated" | "bypassed";

export interface RunReceiptAutonomyEnforcement {
	grade: RunAutonomyEnforcementGrade;
	/** Effective authority enforced by the runtime. */
	autonomy: string;
	/** Request-level narrowing, present when the caller supplied one. */
	requestedAutonomy?: string;
	/** Session ceiling against which a request-level value was clamped. */
	sessionAutonomy?: string;
	externalMode?: string;
	dangerousBypass?: boolean;
}

/**
 * Evidence confidence is descriptive receipt provenance, orthogonal to the
 * execution outcome. It must never drive retry, reroute, or finish gating.
 */
export type ReceiptVerificationState = "verified" | "unverified" | "not_applicable" | "unknown";

export interface RunReceiptVerification {
	state: ReceiptVerificationState;
	basis:
		| "validation-tool"
		| "read-only-agent"
		| "no-validation-tool"
		| "acp-external-unobserved"
		/** No sealed receipt to read: it is missing, unreadable, or failed integrity. */
		| "receipt-unavailable";
}

export interface RunHostVerificationCheck {
	check: string;
	argv: string[];
	cwd: string;
	exitCode: number;
	durationMs: number;
	memo: boolean;
	outputTail: string;
	artifactPath?: string;
	/** Run that owns the evidence when it did not come from this run: a memo hit, or the batch member the shared check ran under. */
	evidenceRunId?: string;
}

/**
 * Why a batch-settled failing check was or was not charged to a run. It is a
 * batch-wide fact and is sealed identically on every receipt in the batch; each
 * receipt's own `status` is what that run is judged by.
 */
export interface RunHostVerificationAttribution {
	/** Declared check id that failed. */
	check: string;
	/**
	 * Absolute repository paths the check's own output named, capped at 32. The
	 * paths that decided the charge come first so a truncated list still contains
	 * the evidence behind the verdict; each group is sorted.
	 */
	implicated: string[];
	/** Run ids the failure is charged to, sorted; empty when every named path belongs to a run that did not declare the check. */
	charged: string[];
	/**
	 * The weakest evidence behind the charge set, never the strongest, so the
	 * record cannot claim a certainty it does not have.
	 *
	 * `write_roots`: every charged run has an implicated path inside its own
	 * declared write roots. `attributed_elsewhere`: nothing is charged because
	 * every implicated path falls inside the write roots of a live batch member
	 * that did not declare this check. `unattributable`: the charge is not backed
	 * by per-run path evidence, which covers a failure that named no path, one
	 * that named only paths no member claims, and one charged to a run that
	 * declared no write roots at all. The first two of those charge every run that
	 * declared the check: a real failure with no owner is charged to everyone
	 * rather than excused for everyone.
	 */
	basis: "write_roots" | "attributed_elsewhere" | "unattributable";
}

export interface RunHostVerification {
	/**
	 * `verified` states that every declared check passed, which is the claim
	 * `trust-status.ts:619` turns into "validated by host-verification".
	 * `not_implicated` is the batch-settled exculpation: a declared check failed
	 * for the batch and this run's `checks` carries its non-zero exit code, but
	 * the failure was charged elsewhere, so no validator speaks for this run.
	 */
	status: "verified" | "rejected" | "skipped" | "not_implicated";
	reason?: string;
	checks: RunHostVerificationCheck[];
	/**
	 * How the declared checks were run. Absent means the single-run strategy every
	 * receipt carried before batch settlement existed: the checks ran for this run
	 * alone, straight after it finished. `batch-settled` means they ran once for
	 * the whole parallel batch after every live member had finished. The field is
	 * omitted rather than stamped `"single"` so a single-task receipt digests
	 * exactly as it did before (`receipt-integrity.ts:145-147` is the same
	 * reasoning applied one field over).
	 */
	strategy?: "batch-settled";
	/** Per-failing-check attribution for a batch-settled run; absent when nothing failed. */
	attribution?: RunHostVerificationAttribution[];
}

export interface RunReceipt {
	runId: string;
	agentId: string;
	/** Semantic role this attempt's route statistics belong to. */
	executionRole: ExecutionRole;
	agentAudience?: AgentAudience;
	requestOrigin?: DispatchRequestOrigin;
	task: string;
	/** Normalized dispatch intent admitted before worker execution. */
	intent?: DispatchIntent;
	/** Resolved policy-bearing paths with field source and confidence, without source prose. */
	pathScope?: DispatchPathScopeProvenance;
	/** Integrity-sealed recipe policy, invocation request, effective phase, and admission reasons. */
	budget?: RunToolBudgetEnvelope;
	/** Proof of briefing content without copying its prose into the receipt. */
	briefing?: RunBriefingProvenance;
	/** Sent steering provenance in stable per-run sequence order; prose is never persisted. */
	steering?: ReadonlyArray<RunSteeringProvenance>;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	runtimeKind: RunKind;
	startedAt: string;
	endedAt: string;
	/** Terminal outcome. Sealed on every receipt. */
	outcome: RunOutcome;
	outcomeDetail?: string | null;
	outcomeCode?: RunOutcomeCode | null;
	lineage?: RunLineage;
	identity?: RunIdentity;
	/** Fleet node placement; absent when no fleet placement resolved this run. */
	node?: RunNodeIdentity;
	/**
	 * Route and node identity attested by the worker process that executed the
	 * run. Absent only when no worker announced, which is the stubbed-spawn path
	 * contract tests use; every native and remote transport attests.
	 */
	attestation?: RunReceiptAttestation;
	/** Dead-node failover hops, oldest first; absent when the run was never rerouted. */
	reroutes?: RunNodeReroute[];
	/** Pipeline threading provenance; present only on pipeline steps after the first. */
	pipeline?: RunPipelineProvenance;
	/** Review/compete gate provenance; present only on runs of a gated dispatch. */
	gate?: RunGateProvenance;
	council?: RunCouncilProvenance;
	/** Plan-approval provenance; present only on runs of an approval-gated plan. */
	plan?: RunPlanProvenance;
	/** Version 5 fleet gate artifact authored by this run. */
	fleetGate?: { path: string; pathHash: string };
	/** Ad-hoc specialist provenance; present only when a persona override composed the stable prompt. */
	personaOverride?: RunPersonaOverride;
	/** Effective project-context tier for this run; absent on receipts written before this field landed. */
	projectContext?: RunProjectContextProvenance;
	/**
	 * Repo-relative `.clio-coder/rules/**` ids selected into this run's worker
	 * prompt, in load order; `[]` when the run had none. Always present on
	 * receipts written after this field landed (#104); absent on older
	 * receipts, which readers must treat as unknown, never as "no rules".
	 */
	rulesApplied?: string[];
	/**
	 * Whether the operator profile rendered non-empty content into this run's
	 * worker prompt. Always present on receipts written after this field
	 * landed (#104); absent on older receipts, which readers must treat as
	 * unknown, never as false.
	 */
	operatorProfileApplied?: boolean;
	exitCode: number;
	failureMessage?: string;
	tokenCount: number;
	inputTokenCount?: number;
	outputTokenCount?: number;
	cacheReadTokenCount?: number;
	cacheWriteTokenCount?: number;
	reasoningTokenCount?: number;
	upstreamResponses?: RunReceiptUpstreamResponse[];
	/** Bounded final/partial assistant output; absent when none was captured. */
	output?: RunReceiptOutput;
	costUsd: number;
	/** Pricing-source truth. Sealed on every receipt; unknown pricing says so. */
	costProvenance: CostProvenance;
	compiledPromptHash: string | null;
	staticCompositionHash: string | null;
	staticShellHash?: string | null;
	sessionShellHash?: string | null;
	dynamicHash?: string | null;
	promptSignature?: string | null;
	toolSignature?: string | null;
	clioCoderVersion: string;
	piMonoVersion: string;
	platform: string;
	nodeVersion: string;
	toolCalls: number;
	toolStats: ToolCallStat[];
	toolActivity?: ToolActivitySummary;
	/** Integrity-sealed evidence confidence. Sealed on every receipt. */
	verification: RunReceiptVerification;
	/** Orchestrator-executed declared checks. Worker self-report never populates this field. */
	hostVerification?: RunHostVerification;
	/** Isolated writer checkout and its collect-time application result. */
	worktree?: {
		path: string;
		branch: string;
		diffHash: string;
		apply: "merge" | "preserve";
		applied: boolean;
		reason?: string;
	};
	/** Required normalized routing request, sealed without task or prompt data. */
	routingIntent: RoutingIntent;
	/** Required routing-quality facts known at receipt finalization. */
	quality: RunReceiptQuality;
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
	/** Passing validation claims measured against executed commands; absent when none were claimed. */
	validationGrounding?: RunValidationGrounding;
	/** Read-only recipe admitted against a mutating task; absent when the pairing was sound. */
	capabilityMismatch?: RunCapabilityMismatch;
	/**
	 * What this run contributed to its dispatch's agent ledger. Optional and
	 * absent unless the run had a ledger, following validationGrounding and
	 * capabilityMismatch: receiptDigestFields skips undefined, so a receipt
	 * without one omits the field from canonical serialization.
	 */
	ledgerContribution?: RunLedgerContribution;
	/**
	 * Sealed route decision: the candidates, their estimates, the hard filters
	 * that rejected some of them, and the tuple selected by the routing policy.
	 * Absent only when the route observer is disabled, which is a test-bundle
	 * option; every production dispatch seals one, which is what lets route
	 * regret be recomputed offline from receipts alone.
	 */
	routeDecision?: RouteDecisionV1;
	sessionId: string | null;
	integrity: RunReceiptIntegrity;
}

export type RunReceiptDraft = Omit<RunReceipt, "integrity" | "routingIntent"> &
	Partial<Pick<RunReceipt, "routingIntent">>;
