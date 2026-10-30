import { AsyncLocalStorage } from "node:async_hooks";
import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { CallLabel } from "./enums.js";
import { UUID_V7_PATTERN } from "./ids.js";

export const CallIdSchema = Type.String({ pattern: `^cal_${UUID_V7_PATTERN}$` });
export const AttemptIdSchema = Type.String({ pattern: `^att_${UUID_V7_PATTERN}$` });
export const ExistingId = Type.String({ minLength: 1, maxLength: 512 });
const contextFields = {
	turnId: Type.Optional(ExistingId),
	batchId: Type.Optional(ExistingId),
	parentRunId: Type.Optional(ExistingId),
	callId: Type.Optional(CallIdSchema),
	attemptId: Type.Optional(AttemptIdSchema),
	label: CallLabel,
};
// Standalone runs have no session; their real run id owns the journal (#434).
export const TelemetryContextSchema = Type.Union([
	Type.Object(
		{ ...contextFields, sessionId: ExistingId, runId: Type.Optional(ExistingId) },
		{ additionalProperties: false },
	),
	Type.Object({ ...contextFields, sessionId: Type.Null(), runId: ExistingId }, { additionalProperties: false }),
]);
export type TelemetryContext = Readonly<Static<typeof TelemetryContextSchema>>;
export type WorkerTelemetryContext = TelemetryContext & { readonly runId: string; readonly label: "worker" };

/** A parent passes run identity; each worker request mints its own call and attempt ids (#434). */
export function isWorkerTelemetryContext(value: unknown): value is WorkerTelemetryContext {
	return (
		Value.Check(TelemetryContextSchema, value) &&
		value.runId !== undefined &&
		value.label === "worker" &&
		value.callId === undefined &&
		value.attemptId === undefined
	);
}

/** Run facts belong to their run even when a parent session exists (#434). */
export function telemetryOwner(context: TelemetryContext): string {
	return context.runId !== undefined ? `run:${context.runId}` : `session:${context.sessionId}`;
}

const contexts = new AsyncLocalStorage<TelemetryContext>();
export function telemetryContext(): TelemetryContext | undefined {
	return contexts.getStore();
}

export function withTelemetryContext<T>(context: TelemetryContext, fn: () => T): T {
	return contexts.run(Object.freeze({ ...context }), fn);
}
