import type { DomainModule } from "../../core/domain-loader.js";
import { createTelemetryBundle } from "./extension.js";
import { TelemetryManifest } from "./manifest.js";

export const TelemetryDomainModule: DomainModule = {
	manifest: TelemetryManifest,
	createExtension: createTelemetryBundle,
};

export type { AccountabilitySummary } from "./accountability.js";
export { summarizeEvidenceIndex } from "./accountability.js";
export {
	type BackgroundMemoryStepUsage,
	type BackgroundMemoryUsageSink,
	backgroundMemoryUsageRow,
	type RecordBackgroundMemoryStepInput,
	recordBackgroundMemoryStep,
} from "./background-memory-usage.js";
export type {
	TelemetryContract,
	TelemetryNotice,
	TelemetryRunEvidence,
	TelemetryRunSummary,
	TelemetrySnapshot,
	TokenThroughputSnapshot,
} from "./contract.js";
export {
	aggregateCostAmounts,
	COST_NOT_MEASURED,
	type CostAggregate,
	type CostAmount,
	type CostEntry,
	type CostEntryLabel,
	costAggregateForAmount,
	costWasMeasured,
	emptyCostAggregate,
	formatCostAggregate,
	renderCostAggregate,
	renderCostAmount,
	type UsageBreakdown,
} from "./cost.js";
export type { EvidenceIndexRow } from "./evidence-index.js";
export { EVIDENCE_INDEX_FILE, MAX_EVIDENCE_INDEX_ROWS, readEvidenceIndex } from "./evidence-index.js";
export { TelemetryManifest } from "./manifest.js";
export { readTaskMemorySpendSummary } from "./memory-spend.js";
export type { OutOfTurnUsage, OutOfTurnUsageReadResult, OutOfTurnUsageRow } from "./out-of-turn-usage.js";
export {
	appendOutOfTurnUsageRow,
	OUT_OF_TURN_USAGE_DIR,
	OUT_OF_TURN_USAGE_FILE,
	outOfTurnUsagePath,
	readOutOfTurnUsageRows,
} from "./out-of-turn-usage.js";
export {
	isTelemetryJournalFile,
	TELEMETRY_JOURNAL_FILE,
	telemetryConsentPath,
	telemetryJournalFiles,
	telemetryJournalPath,
	telemetryObjectsDirectory,
	telemetryProcessDirectory,
	telemetryProcessesDirectory,
	telemetryResearchDirectory,
	telemetryRoot,
	telemetryRunDirectory,
	telemetryRunsDirectory,
	telemetrySessionDirectory,
	telemetrySessionsDirectory,
} from "./paths.js";
export type { ProjectionReadModel, TelemetryProjection } from "./projection.js";
export {
	createTelemetryProjection,
	MAX_PROJECTION_NOTICES,
	MAX_PROJECTION_RUNS,
	PROJECTION_FLUSH_DEBOUNCE_MS,
} from "./projection.js";
export { emptyTaskMemorySpendSummary, foldTaskMemorySpend, type TaskMemorySpendSummary } from "./read-model.js";
export { readSessionContextSnapshots, readSessionPromptCompiles } from "./session-artifacts.js";
