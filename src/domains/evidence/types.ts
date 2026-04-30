import type { RunEnvelope, RunReceipt, ToolCallStat } from "../dispatch/index.js";
import type { EvalCommandPhase, EvalFailureClass, EvalRunRecord } from "../eval/index.js";
import type { ProtectedArtifact } from "../safety/protected-artifacts.js";

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
	endpointIds: string[];
	runtimeIds: string[];
	modelIds: string[];
	totals: EvidenceTotals;
	tags: EvidenceTag[];
	files: string[];
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

export interface EvidenceBuildResult {
	evidenceId: string;
	directory: string;
	overview: EvidenceOverview;
	findings: EvidenceFinding[];
}

export interface EvidenceInspectable {
	overview: EvidenceOverview;
	findings: EvidenceFinding[];
}

export interface EvidenceRunSource {
	envelope: RunEnvelope;
	receipt: RunReceipt | null;
	receiptError: string | null;
}

export type EvidenceLinkConfidence = "exact" | "best-effort";

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
	endpointId: string;
	runtimeId: string;
	wireModelId: string;
	tokenCount: number;
	costUsd: number;
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
	sourceRunId?: string;
	correlationId?: string;
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
