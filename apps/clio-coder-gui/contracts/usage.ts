import type { Static } from "typebox";
import { Type } from "typebox";
import { TelemetryCost, TelemetrySession } from "./telemetry.js";
import { AcpSessionUsageSchema, AcpUsageCapability as UsageCapability } from "./wire.js";

export { UsageCapability };

// `_clio-coder/usage/read`: the terminal's /usage numbers. Session cost and tokens are Clio Coder's own
// accounting, folded per provider and model; quota is each provider's own report. The agent bounds rows
// at 32, providers at 16, windows at 8 and every string at 256 bytes.
//
// The optional `telemetry` field carries the read model's whole-session DTOs beside the v1 counts (#434 §11.3).
// The ACP leaf types it structurally so it can load in a browser; here it is the DTO contract itself, so a drift
// between the agent and this build fails the read instead of passing a shape the client would mis-render.
const { telemetry: _structural, ...v1 } = AcpSessionUsageSchema.properties;
export const SessionUsage = Type.Object(
	{
		...v1,
		telemetry: Type.Optional(
			Type.Object({ session: TelemetrySession, cost: TelemetryCost }, { additionalProperties: false }),
		),
	},
	{ additionalProperties: false },
);
export type SessionUsage = Static<typeof SessionUsage>;
