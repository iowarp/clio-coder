import { type Static, Type } from "typebox";
import { Id, Problem } from "./common.js";
import { ToolResult } from "./toolchain.js";

export const Progress = Type.Object({ at: Type.String(), message: Type.String() }, { additionalProperties: false });
const base = {
	id: Id,
	kind: Type.String(),
	revision: Type.Integer({ minimum: 1 }),
	cancellable: Type.Boolean(),
	startedAt: Type.String(),
	progress: Type.Array(Progress, { maxItems: 256 }),
};
export const Operation = Type.Union([
	Type.Object(
		{ ...base, status: Type.Union([Type.Literal("queued"), Type.Literal("running")]) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...base, status: Type.Literal("succeeded"), finishedAt: Type.String(), result: ToolResult },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...base, status: Type.Literal("failed"), finishedAt: Type.String(), problem: Problem },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...base, status: Type.Literal("cancelled"), finishedAt: Type.String() },
		{ additionalProperties: false },
	),
]);
export type Operation = Static<typeof Operation>;
export type Progress = Static<typeof Progress>;
export const Accepted = Type.Object({ operationId: Id }, { additionalProperties: false });
