// Browser-safe ACP declarations share the wire contract without evaluating the process transport.

export type { ContextActivityPayload } from "../../../../src/core/bus-events.js";
export type {
	ContextOperation,
	ContextOperationFact,
	ContextOperationStatus,
} from "../../../../src/core/context-operation.js";
export * from "../../../../src/engine/acp/types.js";
