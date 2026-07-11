import type { DomainModule } from "../../core/domain-loader.js";
import { createObservabilityBundle } from "./extension.js";
import { ObservabilityManifest } from "./manifest.js";

export const ObservabilityDomainModule: DomainModule = {
	manifest: ObservabilityManifest,
	createExtension: createObservabilityBundle,
};

export type { AccountabilitySummary } from "./accountability.js";
export { readAccountabilitySummary, summarizeEvidenceIndex } from "./accountability.js";
export type {
	ObservabilityContract,
	ObservabilityNotice,
	ObservabilityRunEvidence,
	ObservabilityRunSummary,
	ObservabilitySnapshot,
	TokenThroughputSnapshot,
} from "./contract.js";
export {
	aggregateCostAmounts,
	type CostAggregate,
	type CostAmount,
	type CostEntry,
	emptyCostAggregate,
	type UsageBreakdown,
} from "./cost.js";
export type { EvidenceIndexRow } from "./evidence-index.js";
export { EVIDENCE_INDEX_FILE, MAX_EVIDENCE_INDEX_ROWS, readEvidenceIndex } from "./evidence-index.js";
export { ObservabilityManifest } from "./manifest.js";
export type { MetricsView } from "./metrics.js";
export type { ObservabilityProjection, ProjectionReadModel } from "./projection.js";
export {
	createObservabilityProjection,
	MAX_PROJECTION_NOTICES,
	MAX_PROJECTION_RUNS,
	PROJECTION_FLUSH_DEBOUNCE_MS,
} from "./projection.js";
export { DEFAULT_HISTOGRAM_CAPACITY, type MetricKind, type TelemetrySnapshot } from "./telemetry.js";
