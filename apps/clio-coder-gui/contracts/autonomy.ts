import { Type } from "typebox";
import { AcpAutonomyLevelSchema } from "./wire.js";

const closed = { additionalProperties: false };

/** Bounds on what the engine announces about its modes; a longer or extra entry is dropped, not cut. */
export const AUTONOMY_MODE_LIMITS = { count: 8, id: 64, name: 64, description: 512 } as const;

export const AutonomyMode = Type.Object(
	{
		id: Type.String({ maxLength: AUTONOMY_MODE_LIMITS.id }),
		name: Type.String({ maxLength: AUTONOMY_MODE_LIMITS.name }),
		description: Type.String({ maxLength: AUTONOMY_MODE_LIMITS.description }),
	},
	closed,
);

export const Autonomy = Type.Object(
	{
		level: AcpAutonomyLevelSchema,
		source: Type.String({ maxLength: 64 }),
		/** The modes the engine announced with the session, each with the engine's own description. */
		modes: Type.Optional(Type.Array(AutonomyMode, { maxItems: AUTONOMY_MODE_LIMITS.count })),
		/** A current mode id the app does not know; `level` then keeps the last known level. */
		unrecognized: Type.Optional(Type.String({ maxLength: 64 })),
	},
	closed,
);
