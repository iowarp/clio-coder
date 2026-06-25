import type { DomainModule } from "../../core/domain-loader.js";
import { createObservabilityBundle } from "./extension.js";
import { ObservabilityManifest } from "./manifest.js";

export const ObservabilityDomainModule: DomainModule = {
	manifest: ObservabilityManifest,
	createExtension: createObservabilityBundle,
};

export type { AccountabilitySummary } from "./accountability.js";
export { readAccountabilitySummary, summarizeEvidenceIndex } from "./accountability.js";
export type { ObservabilityContract, TokenThroughputSnapshot } from "./contract.js";
export type { CostEntry, UsageBreakdown } from "./cost.js";
export type { EvidenceIndexRow } from "./evidence-index.js";
export { EVIDENCE_INDEX_FILE, MAX_EVIDENCE_INDEX_ROWS, readEvidenceIndex } from "./evidence-index.js";
export { ObservabilityManifest } from "./manifest.js";
export type { MetricsView } from "./metrics.js";
export type { MetricKind, TelemetrySnapshot } from "./telemetry.js";
