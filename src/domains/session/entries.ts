/**
 * Rich session entry union.
 *
 * Entries are the persistence vocabulary for session events. Each entry
 * carries its `kind` discriminant, a `turnId` (uuid v7 where possible so
 * entries sort by creation), a parent pointer, and an ISO timestamp.
 *
 * Later slices extend this union:
 *   - compactionSummary is produced by compaction/compact.ts (slice 12c).
 *   - branchSummary is produced by the fork path (slice 12b).
 *   - bashExecution / fileEntry become the wire shape for Phase 14 extensions.
 */

import { isSkillActivation, type SkillActivation } from "../../core/skill-activation.js";
import type { ClioTurnRecord } from "../../engine/session.js";

export interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	parentTurnId?: string;
}

export interface BaseSessionEntry {
	kind: string;
	turnId: string;
	parentTurnId: string | null;
	timestamp: string;
}

export type MessageRole = ClioTurnRecord["kind"];

export interface MessageEntry extends BaseSessionEntry {
	kind: "message";
	role: MessageRole;
	payload: unknown;
}

export interface BashExecutionEntry extends BaseSessionEntry {
	kind: "bashExecution";
	command: string;
	output: string;
	exitCode: number | null;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	excludeFromContext?: boolean;
}

export interface CustomEntry<T = unknown> extends BaseSessionEntry {
	kind: "custom";
	customType: string;
	data?: T;
	display?: boolean;
}

export interface ModelChangeEntry extends BaseSessionEntry {
	kind: "modelChange";
	provider: string;
	modelId: string;
	target?: string;
}

export interface ThinkingLevelChangeEntry extends BaseSessionEntry {
	kind: "thinkingLevelChange";
	thinkingLevel: string;
}

export interface FileEntryEntry extends BaseSessionEntry {
	kind: "fileEntry";
	path: string;
	operation: "read" | "write" | "edit" | "create" | "delete";
	bytes?: number;
	hash?: string;
}

export interface BranchSummaryEntry extends BaseSessionEntry {
	kind: "branchSummary";
	fromTurnId: string;
	summary: string;
}

/**
 * Why a compaction run fired. Persisted on CompactionSummaryEntry so post-mortem
 * tools can distinguish a threshold-driven shrink from a user-issued `/context compact`
 * and from a context-overflow retry.
 *   - "auto"      : pre-submit context-pressure trigger via shouldCompact().
 *   - "force"     : explicit `/context compact` command or CLIO_CODER_FORCE_COMPACT=1.
 *   - "overflow"  : compact-and-retry path after a context overflow error.
 */
export type CompactionTrigger = "auto" | "force" | "overflow";

/**
 * Provider usage for the summarization call a compaction ran, summed over the
 * one or two streams it takes. A compaction is a model call like any other and
 * is billed like one, so it carries the same fields the assistant payload's
 * `usage` carries and the ledger usage fold reads both from one place.
 */
export interface CompactionUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	cost: { total: number };
	/** How many summarization streams this compaction ran (1, or 2 on a split turn). */
	apiCalls: number;
}

export interface CompactionSummaryEntry extends BaseSessionEntry {
	kind: "compactionSummary";
	summary: string;
	tokensBefore: number;
	firstKeptTurnId: string;
	/** Provider usage for the summarization call. Absent when the provider reported none. */
	usage?: CompactionUsage;
	/** What kicked off this compaction. Optional so v1 entries written before the field existed still parse. */
	trigger?: CompactionTrigger;
	/** Estimated context tokens after the compaction bridge message replaced the older turns. */
	tokensAfter?: number;
	/** Count of session entries that fed the summarization prompt. Mirrors CompactResult.messagesSummarized. */
	messagesSummarized?: number;
	/** True when the cut split a turn (caller may want to render a banner). */
	isSplitTurn?: boolean;
}

export interface SessionInfoEntry extends BaseSessionEntry {
	kind: "sessionInfo";
	/** Optional human-readable session name. */
	name?: string;
	/**
	 * When present, this entry labels an earlier turn. Readers scan
	 * `sessionInfo` entries whose `targetTurnId` matches a turn id; the
	 * last-wins `label` becomes that turn's display label in /tree.
	 * Empty string clears the label.
	 */
	targetTurnId?: string;
	label?: string;
}

export interface LabelEntry extends BaseSessionEntry {
	kind: "label";
	targetTurnId: string;
	label?: string;
}

export type ProtectedArtifactEntrySource = "validation" | "middleware" | "user" | "session";

export interface ProtectedArtifactEntryArtifact {
	path: string;
	protectedAt: string;
	reason: string;
	validationCommand?: string;
	validationExitCode?: number;
	source: ProtectedArtifactEntrySource;
}

export interface ProtectedArtifactEntry extends BaseSessionEntry {
	kind: "protectedArtifact";
	action: "protect";
	artifact: ProtectedArtifactEntryArtifact;
	toolName?: string;
	toolCallId?: string;
	runId?: string;
	correlationId?: string;
}

export interface SkillActivationEntry extends BaseSessionEntry {
	kind: "skillActivation";
	activation: SkillActivation;
}

export type TaskLedgerStatus = "pending" | "active" | "completed" | "blocked" | "cancelled";
export type TaskLedgerEvidenceStatus = "required" | "pending" | "passed" | "failed" | "missing";

export interface TaskLedgerGoal {
	id: string;
	title: string;
	status: TaskLedgerStatus;
	parentGoalId?: string | null;
	description?: string;
	origin?: "agent" | "user";
	userTaskId?: string;
}

export interface TaskLedgerValidationEvidence {
	id: string;
	description: string;
	status: TaskLedgerEvidenceStatus;
	command?: string;
	artifactPath?: string;
	observedAt?: string;
	notes?: string;
}

export interface TaskLedgerEntry extends BaseSessionEntry {
	kind: "taskLedger";
	boardId?: string;
	goals: TaskLedgerGoal[];
	subgoals: TaskLedgerGoal[];
	activeRunIds: string[];
	requiredValidationEvidence: TaskLedgerValidationEvidence[];
}

export type DecisionStatus = "active" | "superseded";

export interface DecisionRecord {
	key: string;
	value: string;
	label?: string;
	source_question?: string;
	status: DecisionStatus;
	decidedAt: string;
	revisedAt?: string;
	correction?: string;
}

/** One complete, branch-anchored snapshot of a settled operator interview. */
export interface DecisionLedgerEntry extends BaseSessionEntry {
	kind: "decisionLedger";
	interviewId: string;
	interviewStatus: "complete" | "cancelled";
	startedAt: string;
	endedAt: string;
	roundCount: number;
	summary?: string;
	transcriptPath?: string;
	decisions: DecisionRecord[];
}

/** Who asked for a dispatched run. Internal runs never reach the transcript, so they never reach this entry. */
export type WorkerRunOrigin = "user" | "agent";

/** Runtime family a dispatched worker ran under; the transcript header names it. */
export type WorkerRunRuntimeKind = "clio" | "acp" | "claude-sdk" | "claude-code";

export interface WorkerRunRuntime {
	kind: WorkerRunRuntimeKind;
	/** Route facts for the runtimes that have one; an ACP peer has none. */
	targetId?: string;
	wireModelId?: string;
	/** Delegation peer id; ACP only. */
	peerId?: string;
}

/**
 * A dispatched worker's block, as the session remembers it.
 *
 * Written where the block opens, on DispatchStarted, once per attempt: a
 * failover writes a second entry under the same `assignmentId` so a resumed
 * transcript can rebuild the attempt trail it showed live. The entry holds
 * identity only. The answer lives in the sealed receipt under
 * `receipts/<runId>.json`, which is the terminal truth for it either way, so
 * streamed prose is never persisted here and a session file never grows with
 * worker output.
 *
 * Context-free by construction. Like a notice, it estimates at zero tokens, is
 * not a cut point, and never becomes a model message: a worker's answer reaches
 * the model only when an operator shares it, which travels the user-turn path
 * as ordinary text.
 */
export interface WorkerRunEntry extends BaseSessionEntry {
	kind: "workerRun";
	/** Logical work item. Retries and failovers of one run share it. */
	assignmentId: string;
	/** This attempt's run id, which is also its receipt id. */
	runId: string;
	origin: WorkerRunOrigin;
	agentId: string;
	runtime: WorkerRunRuntime;
	/** Agent origin: the tool call whose execution spawned the run. */
	parentToolCallId?: string;
}

/**
 * Working-set layer (context domain) ledger records. Eviction is a projection:
 * these entries say what left the model's working set and what came back; the
 * original bodies stay in the ledger untouched. The context domain owns the
 * semantics (`src/domains/context/working-set/contract.ts`); the session
 * domain owns the wire shape because it owns the ledger format.
 */
export const EVICTION_REASONS = [
	"superseded_read",
	"stale_after_mutation",
	"listing_consumed",
	"failure_resolved",
	"thinking_turn_closed",
	"age_horizon",
	"operator",
] as const;
export type EvictionReason = (typeof EVICTION_REASONS)[number];

export const EVICTION_TRIGGERS = ["pressure", "operator"] as const;
export type EvictionTrigger = (typeof EVICTION_TRIGGERS)[number];

export const RECALL_TRIGGERS = ["tool", "operator"] as const;
export type RecallTrigger = (typeof RECALL_TRIGGERS)[number];

/**
 * Identity of an evictable unit: the `turnId` of a ledger entry. For a
 * `tool_result` message the unit is the result body; for an `assistant`
 * message the unit is every thinking block it carries. Partial (per-block)
 * eviction is deliberately not modelled; add a `block` field here when it is.
 */
export interface WorkingSetRef {
	entry: string;
}

export interface EvictedItem {
	ref: WorkingSetRef;
	reason: EvictionReason;
	/** Estimated tokens the projection removes for this item (marker cost already subtracted). */
	tokensFreed: number;
	/**
	 * Byte-stable one-line stub the projection renders in place of the body.
	 * Empty for thinking-block eviction, which removes without a marker.
	 */
	marker: string;
	/** Ref key of the entry that superseded or resolved this one, when the reason names one. */
	by?: string;
}

export interface ContextEvictionEntry extends BaseSessionEntry {
	kind: "contextEviction";
	policyId: string;
	trigger: EvictionTrigger;
	evicted: ReadonlyArray<EvictedItem>;
	tokensBefore: number;
	tokensAfter: number;
	/** Used/window ratio that fired the event; null for operator-triggered events. */
	pressureBefore: number | null;
	snapshotIdBefore: string | null;
}

export interface ContextRecallEntry extends BaseSessionEntry {
	kind: "contextRecall";
	ref: WorkingSetRef;
	trigger: RecallTrigger;
	tokensReadmitted: number;
	/** The tool call that performed the recall, when `trigger` is `tool`. */
	toolCallId?: string;
}

export type SessionEntry =
	| MessageEntry
	| BashExecutionEntry
	| CustomEntry
	| ModelChangeEntry
	| ThinkingLevelChangeEntry
	| FileEntryEntry
	| BranchSummaryEntry
	| CompactionSummaryEntry
	| SessionInfoEntry
	| LabelEntry
	| ProtectedArtifactEntry
	| SkillActivationEntry
	| TaskLedgerEntry
	| DecisionLedgerEntry
	| WorkerRunEntry
	| ContextEvictionEntry
	| ContextRecallEntry;

export type SessionFileEntry = SessionHeader | SessionEntry;

/**
 * Canonical list of entry kinds. Exposed so consumers that switch on
 * `entry.kind` can assert exhaustive coverage in tests; keeping the list
 * here (rather than inline) is how a new kind in a later slice picks up
 * every reader at once.
 */
export const SESSION_ENTRY_KINDS = [
	"message",
	"bashExecution",
	"custom",
	"modelChange",
	"thinkingLevelChange",
	"fileEntry",
	"branchSummary",
	"compactionSummary",
	"sessionInfo",
	"label",
	"protectedArtifact",
	"skillActivation",
	"taskLedger",
	"decisionLedger",
	"workerRun",
	"contextEviction",
	"contextRecall",
] as const;

export type SessionEntryKind = (typeof SESSION_ENTRY_KINDS)[number];

/**
 * Structural guard for the single accepted session ledger entry format.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): boolean {
	return value === undefined || typeof value === "boolean";
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
	return isNumber(value) && Number.isInteger(value) && value > 0;
}

function isOptionalNumber(value: unknown): boolean {
	return value === undefined || isNumber(value);
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasBaseSessionEntryFields(v: Record<string, unknown>): boolean {
	return isString(v.turnId) && isNullableString(v.parentTurnId) && isString(v.timestamp);
}

const MESSAGE_ROLES = ["user", "assistant", "tool_call", "tool_result", "system", "checkpoint"] as const;
const FILE_OPERATIONS = ["read", "write", "edit", "create", "delete"] as const;
const COMPACTION_TRIGGERS: readonly CompactionTrigger[] = ["auto", "force", "overflow"];
const PROTECTED_ARTIFACT_SOURCES: readonly ProtectedArtifactEntrySource[] = [
	"validation",
	"middleware",
	"user",
	"session",
];
const TASK_LEDGER_STATUSES: readonly TaskLedgerStatus[] = ["pending", "active", "completed", "blocked", "cancelled"];
const TASK_LEDGER_EVIDENCE_STATUSES: readonly TaskLedgerEvidenceStatus[] = [
	"required",
	"pending",
	"passed",
	"failed",
	"missing",
];
const DECISION_STATUSES: readonly DecisionStatus[] = ["active", "superseded"];
const DECISION_INTERVIEW_STATUSES = ["complete", "cancelled"] as const;
const WORKER_RUN_ORIGINS: readonly WorkerRunOrigin[] = ["user", "agent"];
const WORKER_RUN_RUNTIME_KINDS: readonly WorkerRunRuntimeKind[] = ["clio", "acp", "claude-sdk", "claude-code"];

function isWorkerRunRuntime(value: unknown): value is WorkerRunRuntime {
	if (!isRecord(value)) return false;
	return (
		isOneOf(value.kind, WORKER_RUN_RUNTIME_KINDS) &&
		isOptionalString(value.targetId) &&
		isOptionalString(value.wireModelId) &&
		isOptionalString(value.peerId)
	);
}

function isTaskLedgerGoal(value: unknown): value is TaskLedgerGoal {
	if (!isRecord(value)) return false;
	if (!isString(value.id) || !isString(value.title)) return false;
	if (!isOneOf(value.status, TASK_LEDGER_STATUSES)) return false;
	if (value.parentGoalId !== undefined && !isNullableString(value.parentGoalId)) return false;
	const hasPairedProvenance =
		value.origin === "user"
			? isString(value.userTaskId) && /^u[1-9]\d*$/.test(value.userTaskId)
			: (value.origin === undefined || value.origin === "agent") && value.userTaskId === undefined;
	return isOptionalString(value.description) && hasPairedProvenance;
}

function isTaskLedgerEvidence(value: unknown): value is TaskLedgerValidationEvidence {
	if (!isRecord(value)) return false;
	if (!isString(value.id) || !isString(value.description)) return false;
	if (!isOneOf(value.status, TASK_LEDGER_EVIDENCE_STATUSES)) return false;
	return (
		isOptionalString(value.command) &&
		isOptionalString(value.artifactPath) &&
		isOptionalString(value.observedAt) &&
		isOptionalString(value.notes)
	);
}

function isDecisionRecord(value: unknown): value is DecisionRecord {
	if (!isRecord(value)) return false;
	if (!isString(value.key) || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(value.key)) return false;
	if (!isString(value.value) || !isOneOf(value.status, DECISION_STATUSES) || !isString(value.decidedAt)) return false;
	if (!isOptionalString(value.label) || !isOptionalString(value.source_question)) return false;
	if (!isOptionalString(value.revisedAt) || !isOptionalString(value.correction)) return false;
	return value.status === "superseded"
		? isString(value.revisedAt)
		: value.revisedAt === undefined && value.correction === undefined;
}

function isOptionalCompactionUsage(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isRecord(value)) return false;
	const cost = value.cost;
	return (
		isNumber(value.input) &&
		isNumber(value.output) &&
		isNumber(value.cacheRead) &&
		isNumber(value.cacheWrite) &&
		isNumber(value.reasoning) &&
		isNumber(value.totalTokens) &&
		isNumber(value.apiCalls) &&
		isRecord(cost) &&
		isNumber(cost.total)
	);
}

function isProtectedArtifact(value: unknown): value is ProtectedArtifactEntryArtifact {
	if (!isRecord(value)) return false;
	return (
		isString(value.path) &&
		isString(value.protectedAt) &&
		isString(value.reason) &&
		isOneOf(value.source, PROTECTED_ARTIFACT_SOURCES) &&
		isOptionalString(value.validationCommand) &&
		isOptionalNumber(value.validationExitCode)
	);
}

export function isSessionHeader(value: unknown): value is SessionHeader {
	if (!isRecord(value)) return false;
	return (
		value.type === "session" &&
		isPositiveInteger(value.version) &&
		isString(value.id) &&
		isString(value.timestamp) &&
		isString(value.cwd) &&
		isOptionalString(value.parentSession) &&
		isOptionalString(value.parentTurnId)
	);
}

function isWorkingSetRef(value: unknown): value is WorkingSetRef {
	return isRecord(value) && isString(value.entry);
}

function isEvictedItem(value: unknown): value is EvictedItem {
	return (
		isRecord(value) &&
		isWorkingSetRef(value.ref) &&
		isOneOf(value.reason, EVICTION_REASONS) &&
		isNumber(value.tokensFreed) &&
		isString(value.marker) &&
		isOptionalString(value.by)
	);
}

export function isSessionEntry(value: unknown): value is SessionEntry {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (!hasBaseSessionEntryFields(v)) return false;
	if (!isOneOf(v.kind, SESSION_ENTRY_KINDS)) return false;
	switch (v.kind) {
		case "message":
			return Object.hasOwn(v, "payload") && isOneOf(v.role, MESSAGE_ROLES);
		case "bashExecution":
			return (
				isString(v.command) &&
				isString(v.output) &&
				(v.exitCode === null || isNumber(v.exitCode)) &&
				typeof v.cancelled === "boolean" &&
				typeof v.truncated === "boolean" &&
				isOptionalString(v.fullOutputPath) &&
				isOptionalBoolean(v.excludeFromContext)
			);
		case "custom":
			return isString(v.customType) && isOptionalBoolean(v.display);
		case "modelChange":
			return isString(v.provider) && isString(v.modelId) && isOptionalString(v.target);
		case "thinkingLevelChange":
			return isString(v.thinkingLevel);
		case "fileEntry":
			return (
				isString(v.path) && isOneOf(v.operation, FILE_OPERATIONS) && isOptionalNumber(v.bytes) && isOptionalString(v.hash)
			);
		case "branchSummary":
			return isString(v.fromTurnId) && isString(v.summary);
		case "compactionSummary":
			return (
				isString(v.summary) &&
				isNumber(v.tokensBefore) &&
				isString(v.firstKeptTurnId) &&
				isOptionalCompactionUsage(v.usage) &&
				(v.trigger === undefined || isOneOf(v.trigger, COMPACTION_TRIGGERS)) &&
				isOptionalNumber(v.tokensAfter) &&
				isOptionalNumber(v.messagesSummarized) &&
				isOptionalBoolean(v.isSplitTurn)
			);
		case "sessionInfo":
			return isOptionalString(v.name) && isOptionalString(v.targetTurnId) && isOptionalString(v.label);
		case "label":
			return isString(v.targetTurnId) && isOptionalString(v.label);
		case "protectedArtifact":
			return (
				v.action === "protect" &&
				isProtectedArtifact(v.artifact) &&
				isOptionalString(v.toolName) &&
				isOptionalString(v.toolCallId) &&
				isOptionalString(v.runId) &&
				isOptionalString(v.correlationId)
			);
		case "skillActivation":
			return isSkillActivation(v.activation);
		case "taskLedger":
			return (
				isOptionalString(v.boardId) &&
				Array.isArray(v.goals) &&
				v.goals.every(isTaskLedgerGoal) &&
				Array.isArray(v.subgoals) &&
				v.subgoals.every(isTaskLedgerGoal) &&
				isStringArray(v.activeRunIds) &&
				Array.isArray(v.requiredValidationEvidence) &&
				v.requiredValidationEvidence.every(isTaskLedgerEvidence)
			);
		case "decisionLedger":
			return (
				isString(v.interviewId) &&
				isOneOf(v.interviewStatus, DECISION_INTERVIEW_STATUSES) &&
				isString(v.startedAt) &&
				isString(v.endedAt) &&
				isNumber(v.roundCount) &&
				Number.isInteger(v.roundCount) &&
				v.roundCount >= 0 &&
				isOptionalString(v.summary) &&
				isOptionalString(v.transcriptPath) &&
				Array.isArray(v.decisions) &&
				v.decisions.every(isDecisionRecord)
			);
		case "workerRun":
			return (
				isString(v.assignmentId) &&
				isString(v.runId) &&
				isOneOf(v.origin, WORKER_RUN_ORIGINS) &&
				isString(v.agentId) &&
				isWorkerRunRuntime(v.runtime) &&
				isOptionalString(v.parentToolCallId)
			);
		case "contextEviction":
			return (
				isString(v.policyId) &&
				isOneOf(v.trigger, EVICTION_TRIGGERS) &&
				Array.isArray(v.evicted) &&
				v.evicted.every(isEvictedItem) &&
				isNumber(v.tokensBefore) &&
				isNumber(v.tokensAfter) &&
				(v.pressureBefore === null || isNumber(v.pressureBefore)) &&
				(v.snapshotIdBefore === null || isString(v.snapshotIdBefore))
			);
		case "contextRecall":
			return (
				isWorkingSetRef(v.ref) &&
				isOneOf(v.trigger, RECALL_TRIGGERS) &&
				isNumber(v.tokensReadmitted) &&
				isOptionalString(v.toolCallId)
			);
	}
	return false;
}
