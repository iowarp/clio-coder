import { Type } from "typebox";
import { AcpAutonomyLevelSchema } from "./wire.js";

export const Autonomy = Type.Object(
	{ level: AcpAutonomyLevelSchema, source: Type.String({ maxLength: 64 }) },
	{ additionalProperties: false },
);
