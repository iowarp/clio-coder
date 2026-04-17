import type { DomainModule } from "../../core/domain-loader.js";
import { createObservabilityBundle } from "./extension.js";
import { ObservabilityManifest } from "./manifest.js";

export const ObservabilityDomainModule: DomainModule = {
	manifest: ObservabilityManifest,
	createExtension: createObservabilityBundle,
};

export { ObservabilityManifest } from "./manifest.js";
export type { ObservabilityContract } from "./contract.js";
export type { MetricsView } from "./metrics.js";
export type { CostEntry } from "./cost.js";
export type { TelemetrySnapshot, MetricKind } from "./telemetry.js";
