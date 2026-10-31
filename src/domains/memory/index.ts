export {
	BACKGROUND_SKIP_REASONS,
	type BackgroundRouteFacts,
	type BackgroundRouteKind,
	type BackgroundSkipReason,
	type BackgroundStepDecision,
	type BackgroundStepFacts,
	backgroundRouteKind,
	decideBackgroundStep,
} from "./background-budget.js";
export {
	buildTurnPrefixUserText,
	buildUserText,
	COMPACTION_SYSTEM_PROMPT,
	COMPACTION_TURN_PREFIX_PROMPT_TEMPLATE,
	COMPACTION_USER_PROMPT_TEMPLATE,
} from "./compaction-prompts.js";
export type { RetentionStatus } from "./completion-retention.js";
export type {
	MemoryCompactionOffer,
	MemoryConsumptionReceipt,
	MemoryContract,
	MemoryObservationCommands,
	MemoryOfferInput,
	MemoryOfferUse,
	MemoryPromptSelection,
	ObservationSource,
	ObservationSourceUnit,
	ObservationStatus,
	SessionObservation,
} from "./contract.js";
export {
	buildDispatchMemorySection,
	DISPATCH_MEMORY_SCOPES,
	type DispatchMemoryRoute,
	dispatchMemoryRuntimeId,
} from "./dispatch-section.js";
export {
	evaluateMemoryGate,
	MEMORY_GATE_HELD_SESSIONS,
	type MemoryGateOutcome,
	type MemoryGateVerdict,
	type MemoryObservationInput,
	recordMemoryObservations,
} from "./guardian-gate.js";
export { completedLessonSource } from "./history-review.js";
export { type LessonSubject, lessonSubject } from "./lesson-evidence.js";
export type { MemoryLessonJudge } from "./lesson-judge.js";
export { createMemoryLessonJudge } from "./lesson-judge.js";
export {
	createTaskMemoryTelemetrySink,
	type TaskMemoryBankDelta,
	type TaskMemoryClassDelta,
	type TaskMemoryTelemetryDecision,
	type TaskMemoryTelemetrySink,
	type TaskMemoryTelemetryStep,
	type TaskMemoryTelemetryTier,
	type TaskMemoryTelemetryTrigger,
	taskMemoryBankDelta,
} from "./memory-events.js";
export { traceObservation } from "./observation-events.js";
export { isMemoryConsumptionReceipt, OBSERVATION_PROMPT } from "./observations.js";
export {
	approveMemoryRecord,
	canonicalMemoryRepositoryIdentity,
	eligibleMemoryRecords,
	estimateMemoryTokens,
	pruneStaleMemory,
	rejectMemoryRecord,
} from "./operations.js";
export {
	applyScopeIdentity,
	MEMORY_PROMOTION_SCOPES,
	type MemoryPromotionScope,
	type MemoryPromotionSource,
	type MemoryPromotionSourceRedaction,
	type MemoryScopeSelection,
	memoryAgentIdentity,
	memoryRecordFromPromotion,
	memoryRuntimeIdentity,
	memoryScopeIdentityKey,
	proposeMemoryPromotion,
	proposeTaskBankPromotion,
	validateMemoryScopeSelection,
} from "./promotion.js";
export { MEMORY_MAIN_PROMPT_SCOPES } from "./prompt-cache.js";
export {
	buildMemoryPromptSection,
	MEMORY_PROMPT_DEFAULT_MAX_ITEMS,
	MEMORY_PROMPT_DEFAULT_SCOPES,
	MEMORY_PROMPT_DEFAULT_TOKEN_BUDGET,
	type MemoryPromptDecision,
	type MemoryPromptOptions,
	renderMemoryPromptSection,
	selectMemoryForPrompt,
} from "./prompt-section.js";
export {
	memoryIdFromEvidence,
	memoryRecordFromEvidence,
	proposeMemoryFromEvidence,
} from "./proposal.js";
export {
	MEMORY_RECALL_DEFAULT_LIMIT,
	MEMORY_RECALL_MAX_LIMIT,
	type MemoryRecallHit,
	type MemoryRecallInput,
	recallMemory,
	renderMemoryRecall,
} from "./recall.js";
export {
	MEMORY_PRECOMPUTED_RELEVANCE_VERSION,
	type PrecomputedMemoryCandidate,
	type PrecomputedMemoryRelevance,
	rankMemoryByPrecomputedScore,
} from "./relevance.js";
export { MemoryRuntime } from "./runtime.js";
export {
	loadMemoryRecords,
	loadMemoryRecordsSync,
	MEMORY_STALE_APPROVED_DAYS,
	MEMORY_STALE_UNAPPROVED_DAYS,
	MEMORY_STORE_MAX_RECORDS,
	memoryRoot,
	memoryStatus,
	memoryStorePath,
	sortMemoryRecords,
	writeMemoryRecords,
} from "./store.js";
export {
	type SaveTaskMemoryOptions,
	TASK_MEMORY_CONTENT_MAX_CHARS,
	TASK_MEMORY_DEFAULT_KNOWLEDGE_CAP,
	TASK_MEMORY_DEFAULT_PROCEDURAL_CAP,
	TASK_MEMORY_VERSION,
	TaskMemoryBank,
	type TaskMemoryBankOptions,
	type TaskMemoryClass,
	type TaskMemoryEntry,
	type TaskMemoryRenderableClass,
	type TaskMemorySnapshot,
} from "./task-bank.js";
export {
	type ProposeInjectedTaskMemoryInput,
	type ProposeInjectedTaskMemoryResult,
	proposeInjectedTaskMemory,
} from "./task-bank-promotion.js";
export {
	type LegacyTaskMemoryHandoffSnapshot,
	parseTaskMemoryHandoffSnapshot,
	type ReviewedTaskMemoryHandoffSnapshot,
	readNewestTaskMemoryHandoff,
	renderTaskMemoryHandoffSnapshot,
	renderTaskMemoryHandoffSource,
	seedTaskMemoryBank,
	seedTaskMemoryFromNewestHandoff,
	TASK_MEMORY_HANDOFF_LANGUAGE,
	TASK_MEMORY_HANDOFF_VERSION,
	type TaskMemoryHandoffArtifact,
	type TaskMemoryHandoffEntry,
	type TaskMemoryHandoffOffer,
	type TaskMemoryHandoffRedaction,
	type TaskMemoryHandoffSeedOutcome,
	type TaskMemoryHandoffSeedResult,
	type TaskMemoryHandoffSnapshot,
	type TaskMemoryHandoffSourceProvenance,
	taskMemoryHandoffSeedOffer,
	taskMemoryHandoffSnapshot,
} from "./task-memory-handoff.js";
export {
	runTaskMemoryPolicy,
	TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS,
	TASK_MEMORY_POLICY_MAX_OPERATIONS,
	type TaskMemoryEnvelope,
	type TaskMemoryModelClient,
	type TaskMemoryModelRequest,
	type TaskMemoryModelResponse,
	type TaskMemoryPolicyDecision,
	type TaskMemoryPolicyInput,
	type TaskMemoryPolicyReason,
	type TaskMemoryPolicyResult,
	type TaskMemoryRoute,
	type TaskMemoryStepUsage,
	type TaskMemoryTrajectoryStep,
} from "./task-memory-policy.js";
export {
	emptyTaskMemorySpendSummary,
	formatTaskMemorySpend,
	readTaskMemorySpendSummary,
	type TaskMemorySpendSummary,
} from "./task-memory-spend.js";
export {
	describeTaskMemoryActivity,
	type TaskMemoryActivityEvent,
	type TaskMemoryBudgetSkip,
	type TaskMemoryGuardianState,
	type TaskMemoryOperatorStatus,
	type TaskMemoryTier,
	taskMemoryBankSize,
} from "./task-memory-status.js";
export {
	createTaskMemoryTrace,
	type TaskMemoryTrace,
} from "./task-memory-trace.js";
export type {
	MemoryAgentIdentity,
	MemoryApproval,
	MemoryObservation,
	MemoryObservationKind,
	MemoryPromotionRedaction,
	MemoryProposalResult,
	MemoryPruneResult,
	MemoryRecord,
	MemoryRecordProvenance,
	MemoryRecordValidationResult,
	MemoryRepositoryIdentity,
	MemoryRetrievalOptions,
	MemoryRuntimeIdentity,
	MemoryScope,
	MemoryStatus,
	MemoryStoreFile,
	MemoryStoreValidationResult,
	MemoryValidationIssue,
} from "./types.js";
export { MEMORY_SCOPES, MEMORY_VERSION } from "./types.js";
export { validateMemoryRecord, validateMemoryStore } from "./validate.js";
