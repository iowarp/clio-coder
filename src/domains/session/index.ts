import type { DomainModule } from "../../core/domain-loader.js";
import { createSessionBundle } from "./extension.js";
import { SessionManifest } from "./manifest.js";

export const SessionDomainModule: DomainModule = {
	manifest: SessionManifest,
	createExtension: createSessionBundle,
};

export type {
	AuditJsonRow,
	AuditReadResult,
	SessionLedgerRef,
	SessionReadResult,
} from "./archive-readers.js";
export {
	listSessionLedgerRefs,
	parseSessionEntries,
	readAuditRows,
	readSessionEntriesForId,
} from "./archive-readers.js";
export type {
	ClioSessionMetaExtension,
	DeleteSessionOptions,
	SessionContract,
	SessionEntryInput,
	SessionMeta,
	TurnInput,
} from "./contract.js";
export type {
	BaseSessionEntry,
	BashExecutionEntry,
	BranchSummaryEntry,
	CompactionSummaryEntry,
	CustomEntry,
	FileEntryEntry,
	LabelEntry,
	MessageEntry,
	MessageRole,
	ModelChangeEntry,
	ProtectedArtifactEntry,
	ProtectedArtifactEntryArtifact,
	ProtectedArtifactEntrySource,
	SessionEntry,
	SessionEntryKind,
	SessionFileEntry,
	SessionHeader,
	SessionInfoEntry,
	SkillActivationEntry,
	TaskLedgerEntry,
	TaskLedgerEvidenceStatus,
	TaskLedgerGoal,
	TaskLedgerStatus,
	TaskLedgerValidationEvidence,
	ThinkingLevelChangeEntry,
	WorkerRunEntry,
	WorkerRunOrigin,
	WorkerRunRuntime,
	WorkerRunRuntimeKind,
} from "./entries.js";
export { isSessionEntry, isSessionHeader, SESSION_ENTRY_KINDS } from "./entries.js";
export { SessionManifest } from "./manifest.js";
export { CURRENT_SESSION_FORMAT_VERSION, runMigrations } from "./migrations/index.js";
export {
	protectedArtifactEntryFromArtifact,
	protectedArtifactFromSessionEntry,
	protectedArtifactStateFromSessionEntries,
} from "./protected-artifacts.js";
export type {
	TaskBoardCounts,
	TaskBoardMutation,
	TaskBoardMutationResult,
	TaskBoardSnapshot,
	TaskBoardStore,
	TaskBoardStoreDeps,
	TaskBoardTask,
} from "./task-board.js";
export { createTaskBoardStore, foldTaskBoard, taskBoardCounts, toTaskLedgerEntryFields } from "./task-board.js";
// The tree/ module is a domain-internal building block. Only the
// overlay-facing types surface here; callers that need deeper helpers import
// from the concrete submodules directly (session domain only).
export type { TreeSnapshot, TreeSnapshotNode } from "./tree/navigator.js";
export type { LedgerUsageCall, SessionUsageDefaults } from "./usage.js";
export { ledgerUsageCalls } from "./usage.js";
