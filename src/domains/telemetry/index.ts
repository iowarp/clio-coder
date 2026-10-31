import type { DomainModule } from "../../core/domain-loader.js";
import { createTelemetryBundle } from "./extension.js";
import { TelemetryManifest } from "./manifest.js";

export const TelemetryDomainModule: DomainModule = {
	manifest: TelemetryManifest,
	createExtension: createTelemetryBundle,
};

/** The read boundary every telemetry reader opens its paths through, for surfaces that report a store present (#434). */
export { withinStateRoot } from "../../core/state-boundary.js";
export type { AccountabilitySummary } from "./accountability.js";
export { summarizeRunAccountability } from "./accountability.js";
export { workspaceTelemetryCapture } from "./consent.js";
export type {
	TelemetryContract,
	TelemetryRunSummary,
	TelemetrySnapshot,
	TokenThroughputSnapshot,
} from "./contract.js";
export {
	aggregateCostAmounts,
	COST_NOT_MEASURED,
	type CostAggregate,
	type CostAmount,
	costAggregateForAmount,
	costWasMeasured,
	emptyCostAggregate,
	formatCostAggregate,
	renderCostAggregate,
	renderCostAmount,
	type UsageBreakdown,
} from "./cost.js";
export type {
	DecisionRow,
	DecisionsFold,
	GateVerdictRow,
	MemoryStepRow,
	MemoryStepsFold,
	ProcessHealthFold,
} from "./fact-folds.js";
export { decisionRow, foldDecisions, foldGateVerdicts, foldMemorySteps, foldProcessHealth } from "./fact-folds.js";
export { publishGateDecision } from "./gate-publication.js";
export { TelemetryManifest } from "./manifest.js";
export { readTaskMemorySpendSummary } from "./memory-spend.js";
export {
	isTelemetryJournalFile,
	TELEMETRY_JOURNAL_FILE,
	telemetryBundlePath,
	telemetryConsentPath,
	telemetryJournalFiles,
	telemetryJournalPath,
	telemetryObjectsDirectory,
	telemetryProcessDirectory,
	telemetryProcessesDirectory,
	telemetryRoot,
	telemetryRunDirectory,
	telemetryRunsDirectory,
	telemetrySessionDirectory,
	telemetrySessionsDirectory,
} from "./paths.js";
export type { ProjectionReadModel, TelemetryProjection } from "./projection.js";
export {
	createTelemetryProjection,
	MAX_PROJECTION_RUNS,
	PROJECTION_FLUSH_DEBOUNCE_MS,
} from "./projection.js";
export {
	cacheReport,
	callsReport,
	costReport,
	emptyTaskMemorySpendSummary,
	explain,
	foldTaskMemorySpend,
	READ_MODEL_FOLD,
	runCostReport,
	runRowTelemetry,
	runTelemetry,
	runTimeline,
	sessionTelemetry,
	type TaskMemorySpendSummary,
	timeline,
	whyStopped,
} from "./read-model.js";
export type { JournaledContent } from "./research-content.js";
export { readJournaledContent } from "./research-content.js";
export type {
	RouteHistoryEntry,
	RouteHistoryFold,
	RouteHistoryIdentity,
	RouteHistoryRead,
	RouteReliabilityOutcome,
	SettledRunFacts,
} from "./route-history.js";
export { createRouteHistoryFold, routeHistoryEntry, routeSettledLabel } from "./route-history.js";
export { runSettledDigest } from "./run-digest.js";
export {
	readDispatchHistory,
	readFleetHistory,
	readFleetHistoryRoot,
	readRunHistoryEntries,
	readRunHistoryEntry,
	readRunInspection,
	runHistoryCouncils,
	runHistoryGates,
} from "./run-history.js";
export type { SettledRunRecord } from "./run-record.js";
export {
	readRunRecord,
	readRunRecordAsync,
	readSettledRun,
	readSettledRunAsync,
	readVerifiedRun,
} from "./run-record.js";
export { readSessionContextSnapshots, readSessionPromptCompiles } from "./session-artifacts.js";
export { explainRepoRef, isRepoRef } from "./usage-window.js";
