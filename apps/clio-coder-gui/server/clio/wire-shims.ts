// Browser-safe ACP declarations share the wire contract without evaluating the process transport.

export type { ContextActivityPayload } from "../../../../src/core/bus-events.js";
export type {
	ContextOperation,
	ContextOperationFact,
	ContextOperationStatus,
} from "../../../../src/core/context-operation.js";
// The read-model DTO schemas reach the browser contract and openapi.json through this seam. dto.ts has a
// typebox-only value-import closure (id-schemas, enums, fact, schemas), so the client bundle carries no Node module.
export type {
	CacheReportV1,
	CallFilter,
	CallRowV1,
	CallsReportV1,
	CostReportV1,
	ExplanationV1,
	FactRef,
	Quantity,
	RunRowV1,
	RunTelemetryV1,
	RunTimelineEntry,
	RunTimelineV1,
	SessionTelemetryV1,
	TelemetryTopic,
	TelemetryUpdateV1,
	TimelineEntry,
	TimelineV1,
	WhyStoppedV1,
} from "../../../../src/core/telemetry/dto.js";
export {
	CallFilterSchema,
	FactRefSchema,
	parseFactRef,
	TELEMETRY_DTO_SCHEMAS,
	TELEMETRY_TOPICS,
} from "../../../../src/core/telemetry/dto.js";
export * from "../../../../src/engine/acp/types.js";
