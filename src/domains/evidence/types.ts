import type { GateDecisionArtifact, RunEnvelope, RunReceipt, ToolCallStat } from "../dispatch/index.js";
import type { RunPersonaOverride, RunPipelineProvenance, RunReceiptAutonomyEnforcement } from "../dispatch/types.js";
import type { EvalCommandPhase, EvalFailureClass, EvalRunRecord } from "../eval/index.js";
import type { ProtectedArtifact } from "../safety/protected-artifacts.js";
import type { RunEscalationCounts } from "./provenance.js";
import type { CanonicalTrustStatus } from "./trust-status.js";

export const EVIDENCE_VERSION = 1;

export const EVIDENCE_TAGS = [
	"audit-linked",
	"audit-missing",
	"best-effort-link",
	"timeout",
	"context-overflow",
	"provider-transient",
	"missing-dependency",
	"wrong-runtime",
	"proxy-validation",
	"no-validation",
	"destructive-cleanup",
	"blocked-tool",
	"escalation",
	"external-bypass",
	"external-approximation",
	"independent-review",
	"context-provenance",
	"completion-evidence",
	"receipt-integrity",
	"receipt-retired",
	"protected-artifact",
	"tool-loop",
	"test-failure",
	"build-failure",
	"cwd-missing",
	"session-linked",
	"session-missing",
	"auth-failure",
	"unknown",
] as const;

export type EvidenceTag = (typeof EVIDENCE_TAGS)[number];

/**
 * Canonical failure-cause subset for receipt summaries and observability
 * histograms. Provenance/quality tags such as `audit-linked`, `session-linked`,
 * and `no-validation` remain evidence tags, but they are not failure causes.
 */
export const FAILURE_CAUSE_TAG_ORDER = [
	"timeout",
	"auth-failure",
	"missing-dependency",
	"build-failure",
	"test-failure",
	"blocked-tool",
] as const satisfies readonly EvidenceTag[];

export type FailureCauseTag = (typeof FAILURE_CAUSE_TAG_ORDER)[number];

/** Fast membership test for the canonical failure-cause subset. */
export const FAILURE_CAUSE_TAGS: ReadonlySet<EvidenceTag> = new Set(FAILURE_CAUSE_TAG_ORDER);

export type EvidenceSource =
	| { kind: "run"; runId: string }
	| { kind: "session"; sessionId: string }
	| { kind: "eval"; evalId: string };

export interface EvidenceTotals {
	runs: number;
	receipts: number;
	toolCalls: number;
	toolErrors: number;
	blockedToolCalls: number;
	sessionEntries: number;
	auditRows: number;
	toolEvents: number;
	linkedToolEvents: number;
	protectedArtifacts: number;
	tokens: number;
	costUsd: number;
	wallTimeMs: number;
}

export interface EvidenceOverview {
	version: 1;
	evidenceId: string;
	source: EvidenceSource;
	generatedAt: string;
	runIds: string[];
	sessionId: string | null;
	statuses: string[];
	startedAt: string | null;
	endedAt: string | null;
	tasks: string[];
	cwds: string[];
	agentIds: string[];
	targetIds: string[];
	runtimeIds: string[];
	modelIds: string[];
	totals: EvidenceTotals;
	tags: EvidenceTag[];
	files: string[];
	/**
	 * Number of secret-shaped values replaced with `[redacted:<kind>]` across
	 * the bundle's export surfaces (previews, transcript, receipts) at build
	 * time. Additive field: older bundles simply lack it. Zero means the
	 * patterns matched nothing; raw local session files are never touched.
	 */
	redactionCount?: number;
}

export type EvidenceSeverity = "info" | "warn";

export interface EvidenceFinding {
	id: string;
	severity: EvidenceSeverity;
	tag: EvidenceTag;
	runId: string | null;
	message: string;
}

export interface EvidenceFindingsFile {
	version: 1;
	evidenceId: string;
	findings: EvidenceFinding[];
}

export interface EvidenceGateDecisionsFile {
	version: 1;
	evidenceId: string;
	decisions: GateDecisionArtifact[];
}

export interface EvidenceBuildResult {
	evidenceId: string;
	directory: string;
	overview: EvidenceOverview;
	findings: EvidenceFinding[];
	trustStatus: EvidenceTrustStatusFile;
}

export interface EvidenceInspectable {
	overview: EvidenceOverview;
	findings: EvidenceFinding[];
	trustStatus: EvidenceTrustStatusView;
}

export interface EvidenceRunTrustStatus {
	runId: string;
	status: CanonicalTrustStatus;
}

/** Canonical per-run projection persisted by current evidence builders. */
export interface EvidenceTrustStatusFile {
	version: 1;
	evidenceId: string;
	projection: "canonical";
	runs: EvidenceRunTrustStatus[];
}

/** Explicit compatibility result for a bundle built before the projection existed. */
export interface HistoricalEvidenceTrustStatus {
	version: 1;
	evidenceId: string;
	projection: "historical_format";
	runs: [];
}

export type EvidenceTrustStatusView = EvidenceTrustStatusFile | HistoricalEvidenceTrustStatus;

export interface EvidenceRunSource {
	envelope: RunEnvelope;
	receipt: RunReceipt | null;
	receiptError: string | null;
	/** True when the receipt was readable but failed cryptographic/ledger integrity verification. */
	receiptIntegrityFailed: boolean;
}

export type EvidenceLinkConfidence = "exact" | "best-effort";

/**
 * How a row's `runId` was derived. `entry-run-id` is the run id the producer
 * stamped on the record at write time and is exact. The others are timestamp
 * windowing, which is a fallback: concurrent runs share one clock, so their
 * windows overlap and containment cannot name an owner. A row inside more than
 * one window is `ambiguous-timestamp-window`, reports a null `runId`, and lists
 * every run it may belong to instead of picking one.
 */
export interface EvidenceRunLink {
	kind: "entry-run-id" | "timestamp-window" | "ambiguous-timestamp-window" | "no-run-window";
	confidence: EvidenceLinkConfidence;
	candidateRunIds?: string[];
}

export type EvidenceToolEventSource = "session-entry" | "audit-row" | "receipt-aggregate" | "eval-command";

export interface EvidenceToolEvent {
	source: EvidenceToolEventSource;
	runId: string | null;
	sessionId: string | null;
	tool: string;
	count: number;
	ok: number;
	errors: number;
	blocked: number;
	totalDurationMs: number;
	timestamp?: string;
	toolCallId?: string;
	linkKind?: string;
	confidence?: EvidenceLinkConfidence;
	decision?: string;
	actionClass?: string;
	argsPreview?: string;
	resultPreview?: string;
	/** How `runId` was derived. Present on events built from session ledger entries. */
	runLink?: EvidenceRunLink;
}

export interface EvidenceAuditLinkedRow {
	kind: "audit-linked";
	auditKind: string;
	ts: string | null;
	runId: string | null;
	sessionId: string | null;
	linkKind: string;
	confidence: EvidenceLinkConfidence;
	reasons: string[];
	candidateRunIds?: string[];
	row: Record<string, unknown>;
}

export interface EvidenceTraceRunRow {
	kind: "run";
	runId: string;
	task: string;
	status: string;
	exitCode: number | null;
	startedAt: string;
	endedAt: string | null;
	wallTimeMs: number;
	cwd: string;
	agentId: string;
	targetId: string;
	runtimeId: string;
	wireModelId: string;
	tokenCount: number;
	costUsd: number;
	/** Pipeline threading provenance; present only for pipeline steps after the first. */
	pipeline?: RunPipelineProvenance;
	/** Ad-hoc specialist provenance; present only when a persona override composed the prompt. */
	personaOverride?: RunPersonaOverride;
	/** Worker permission-escalation counters; present only when the run saw an escalation. */
	escalation?: RunEscalationCounts;
	/** Autonomy enforcement grade recorded by the run receipt. */
	autonomyEnforcement?: RunReceiptAutonomyEnforcement;
}

export interface EvidenceTraceToolRow extends EvidenceToolEvent {
	kind: "tool-summary";
}

export interface EvidenceTraceFindingRow extends EvidenceFinding {
	kind: "finding";
}

export interface EvidenceEvalTraceRow {
	kind: "eval-result";
	evalId: string;
	runId: string;
	taskId: string;
	pass: boolean;
	exitCode: number;
	failureClass: EvalFailureClass | null;
	wallTimeMs: number;
	tokens: number;
	costUsd: number;
	cwd: string;
	tags: string[];
	evidenceId: string | null;
}

export interface EvidenceEvalCommandTraceRow {
	kind: "eval-command";
	evalId: string;
	runId: string;
	taskId: string;
	phase: EvalCommandPhase;
	index: number;
	command: string;
	exitCode: number;
	timedOut: boolean;
	wallTimeMs: number;
}

export type EvidenceCleanTraceRow =
	| EvidenceTraceRunRow
	| EvidenceTraceToolRow
	| EvidenceTraceFindingRow
	| EvidenceEvalTraceRow
	| EvidenceEvalCommandTraceRow;

export interface EvidenceReceiptFile {
	version: 1;
	receipts: RunReceipt[];
}

export interface EvidenceProtectedArtifactEvent {
	kind: "protected-artifact";
	sessionId: string;
	runId: string | null;
	timestamp: string;
	turnId: string;
	parentTurnId: string | null;
	action: "protect";
	artifact: ProtectedArtifact;
	toolName?: string;
	toolCallId?: string;
	/** Run id the session ledger recorded on the entry itself at write time. */
	sourceRunId?: string;
	correlationId?: string;
	/** How `runId` was derived. */
	runLink?: EvidenceRunLink;
}

export interface EvidenceProtectedArtifactsFile {
	version: 1;
	artifacts: ProtectedArtifact[];
	events: EvidenceProtectedArtifactEvent[];
}

export type EvidenceRawTraceRow =
	| {
			kind: "run-ledger";
			runId: string;
			envelope: RunEnvelope;
	  }
	| {
			kind: "receipt";
			runId: string;
			receipt: RunReceipt;
	  }
	| {
			kind: "receipt-error";
			runId: string;
			error: string;
	  };

export interface EvidenceEvalRawTraceRow {
	kind: "eval-result";
	evalId: string;
	runId: string;
	result: EvalRunRecord;
}

export type EvidenceToolStat = ToolCallStat;
