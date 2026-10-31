import type { Static } from "typebox";
import { Type } from "typebox";
import { TelemetryCost, TelemetryQuota, TelemetrySession } from "./telemetry.js";

/** The session usage view is composed only of read-model DTOs (#434). */
export const SessionUsage = Type.Object(
	{
		telemetry: Type.Object({ session: TelemetrySession, cost: TelemetryCost }, { additionalProperties: false }),
		telemetryQuota: TelemetryQuota,
	},
	{ additionalProperties: false },
);
export type SessionUsage = Static<typeof SessionUsage>;
