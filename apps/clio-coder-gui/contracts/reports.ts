import { type Static, Type } from "typebox";
import { Id } from "./common.js";

const closed = { additionalProperties: false };
const record = Type.Record(Type.String(), Type.Unknown());
export const UsageReport = Type.Object(
	{
		schema: Type.Literal("experimental"),
		workspaceId: Id,
		windowDays: Type.Literal(30),
		from: Type.String(),
		to: Type.String(),
		facts: Type.Array(Type.Object({ name: Type.String(), values: record }, closed)),
		opportunities: Type.Array(
			Type.Object({ kind: Type.String(), suggestion: Type.String(), evidence: Type.String() }, closed),
		),
	},
	closed,
);
export type UsageReport = Static<typeof UsageReport>;
