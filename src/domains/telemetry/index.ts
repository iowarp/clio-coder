import type { DomainModule } from "../../core/domain-loader.js";
import { createTelemetryBundle } from "./extension.js";
import { TelemetryManifest } from "./manifest.js";

export const TelemetryDomainModule: DomainModule<"telemetry"> = {
	manifest: TelemetryManifest,
	createExtension: (context) => {
		const { extension, contract } = createTelemetryBundle(context);
		return { extension, contract };
	},
};

/** The read boundary every telemetry reader opens its paths through, for surfaces that report a store present (#434). */
export { withinStateRoot } from "../../core/state-boundary.js";
export type { AccountabilitySummary } from "./accountability.js";
export { summarizeRunAccountability } from "./accountability.js";
export { workspaceTelemetryCapture } from "./consent.js";
export type {
	TelemetryContract,
	TelemetryRunReaderBinder,
	TelemetryRunSummary,
	TelemetrySnapshot,
	TokenThroughputSnapshot,
} from "./contract.js";
export type { TelemetryDomain } from "./extension.js";
export { createTelemetryDomain } from "./extension.js";
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
	telemetryInstallPath,
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
	type EnqueuedRun,
	emptyTaskMemorySpendSummary,
	explain,
	foldTaskMemorySpend,
	READ_MODEL_FOLD,
	runCostReport,
	runRowTelemetry,
	runTelemetry,
	runTimeline,
	sessionOperatorMetrics,
	sessionTelemetry,
	type TaskMemorySpendSummary,
	timeline,
	usageReport,
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
export {
	freshShareSource,
	packShare,
	planShare,
	resolveShareScopes,
	type ShareInventory,
	type SharePlan,
	verifyShareArchive,
} from "./share.js";
export { packTelemetryArchive, type ShareArchiveEntry, unpackTelemetryArchive } from "./share-archive.js";
export { carriesPath, isBuiltinRuntimeId } from "./share-projection.js";
export { emptyUsageDiagnostics, explainRepoRef, isRepoRef, usageWindow } from "./usage-window.js";
