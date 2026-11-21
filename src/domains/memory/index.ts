export { proposeMemoryFromClaim, recordClaimRegressions } from "./claim-link.js";
export { consolidateMemory, type MemoryConsolidation } from "./consolidate.js";
export type { MemoryPromptSelection, ObservationSourceUnit } from "./contract.js";
export { buildDispatchMemorySection } from "./dispatch-section.js";
export { completedLessonSource } from "./history-review.js";
export { lessonSubject } from "./lesson-evidence.js";
export { createTaskMemoryTelemetrySink, type TaskMemoryTelemetryDecision } from "./memory-events.js";
export {
	approveMemoryRecord,
	type ClearedMemoryRegressions,
	canonicalMemoryRepositoryIdentity,
	eligibleMemoryRecords,
	primeMemoryRepositoryFingerprint,
	pruneStaleMemory,
	readClearedMemoryRegressions,
	rejectMemoryRecord,
} from "./operations.js";
export {
	classifyOperatorStatement,
	type DurableOperatorScope,
	detectOperatorMemoryIntent,
	OPERATOR_SECRET_REFUSAL,
	OPERATOR_STATEMENT_MAX_CHARS,
	type OperatorMemoryIntent,
	type OperatorMemoryScope,
	operatorStatementHoldsSecret,
	operatorStatementMatch,
	rememberOperatorStatement,
	restoreOperatorStatement,
	retractOperatorStatement,
	slashRememberIntent,
} from "./operator-statement.js";
export {
	type MemoryScopeSelection,
	memoryAgentIdentity,
	memoryRuntimeIdentity,
	proposeMemoryPromotion,
	proposeTaskBankPromotion,
} from "./promotion.js";
export { MEMORY_MAIN_PROMPT_SCOPES } from "./prompt-cache.js";
export {
	type MemoryPromptOptions,
	type MemoryRecordStanding,
	memoryRecordStanding,
	type OperatorSessionNote,
	selectMemoryForPrompt,
	withOperatorSessionNotes,
} from "./prompt-section.js";
export { proposeMemoryFromEvidence } from "./proposal.js";
export { markMemoryOffRecording } from "./recording-marker.js";
export { MemoryRuntime } from "./runtime.js";
export {
	inspectMemoryStoreRepair,
	loadMemoryRecords,
	loadMemoryRecordsSync,
	loadMemoryStore,
	type MemoryStoreRepair,
	memoryStatus,
	memoryStorePath,
	repairMemoryStore,
} from "./store.js";
export { TaskMemoryBank, type TaskMemoryEntry, type TaskMemorySnapshot } from "./task-bank.js";
export {
	parseTaskMemoryHandoffSnapshot,
	type ReviewedTaskMemoryHandoffSnapshot,
	renderTaskMemoryHandoffSource,
	seedTaskMemoryFromNewestHandoff,
	type TaskMemoryHandoffEntry,
	type TaskMemoryHandoffSnapshot,
	taskMemoryHandoffSeedOffer,
} from "./task-memory-handoff.js";
export { runTaskMemoryPolicy } from "./task-memory-policy.js";
export { formatTaskMemorySpend, readTaskMemorySpendSummary } from "./task-memory-spend.js";
export {
	describeTaskMemoryActivity,
	type TaskMemoryActivityEvent,
	type TaskMemoryOperatorStatus,
	taskMemoryBankSize,
} from "./task-memory-status.js";
export { createTaskMemoryTrace } from "./task-memory-trace.js";
export type {
	MemoryAgentIdentity,
	MemoryProposalResult,
	MemoryRecord,
	MemoryRepositoryIdentity,
	MemoryRuntimeIdentity,
	OperatorStatedKind,
} from "./types.js";
