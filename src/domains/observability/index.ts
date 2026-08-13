import type { DomainModule } from "../../core/domain-loader.js";
import { createObservabilityBundle, type ObservabilityBundleOptions } from "./extension.js";
import { ObservabilityManifest } from "./manifest.js";

export const ObservabilityDomainModule: DomainModule = {
	manifest: ObservabilityManifest,
	createExtension: createObservabilityBundle,
};

export function createObservabilityDomainModule(options: ObservabilityBundleOptions = {}): DomainModule {
	return {
		manifest: ObservabilityManifest,
		createExtension: (context) => createObservabilityBundle(context, options),
	};
}

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
	COST_NOT_MEASURED,
	type CostAggregate,
	type CostAmount,
	type CostEntry,
	costAggregateForAmount,
	costWasMeasured,
	emptyCostAggregate,
	formatCostAggregate,
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
export type {
	DispatchTraceMirror,
	TraceEventInput,
	TraceEventRow,
	TraceGateCheck,
	TraceGateResultInput,
	TracePhaseRow,
	TraceProcessInput,
	TraceProcessRow,
	TraceRunRow,
	TraceSpendInput,
} from "./trace-store.js";
export {
	createDispatchTraceMirror,
	TRACE_DATABASE_FILE,
	TRACE_EVENT_POLL_LIMIT,
	TRACE_SCHEMA_VERSION,
	TraceReader,
	TraceSchemaVersionError,
	TraceStore,
	traceDatabasePath,
} from "./trace-store.js";
