import { AsyncLocalStorage } from "node:async_hooks";
import type { Static } from "typebox";
import { Type } from "typebox";
import { CallLabel } from "./enums.js";
import { UUID_V7_PATTERN } from "./ids.js";

export const CallIdSchema = Type.String({ pattern: `^cal_${UUID_V7_PATTERN}$` });
export const AttemptIdSchema = Type.String({ pattern: `^att_${UUID_V7_PATTERN}$` });
export const ExistingId = Type.String({ minLength: 1, maxLength: 512 });
export const TelemetryContextSchema = Type.Object(
	{
		sessionId: ExistingId,
		turnId: Type.Optional(ExistingId),
		runId: Type.Optional(ExistingId),
		batchId: Type.Optional(ExistingId),
		parentRunId: Type.Optional(ExistingId),
		callId: Type.Optional(CallIdSchema),
		attemptId: Type.Optional(AttemptIdSchema),
		label: CallLabel,
	},
	{ additionalProperties: false },
);
export type TelemetryContext = Readonly<Static<typeof TelemetryContextSchema>>;

const contexts = new AsyncLocalStorage<TelemetryContext>();
export function telemetryContext(): TelemetryContext | undefined {
	return contexts.getStore();
}

export function withTelemetryContext<T>(context: TelemetryContext, fn: () => T): T {
	return contexts.run(Object.freeze({ ...context }), fn);
}
