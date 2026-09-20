import { type Static, Type } from "typebox";

export const Id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });
export const PageCursor = Type.String({ maxLength: 1024, pattern: "^[A-Za-z0-9_-]+$" });
export const Empty = Type.Object({}, { additionalProperties: false });
export const ProblemCode = Type.Union([
	Type.Literal("validation"),
	Type.Literal("unauthorized"),
	Type.Literal("not_found"),
	Type.Literal("conflict"),
	Type.Literal("unsupported"),
	Type.Literal("unavailable"),
	Type.Literal("upstream_acp"),
	Type.Literal("operation_failed"),
	Type.Literal("internal"),
]);
export type ProblemCode = Static<typeof ProblemCode>;
export const Problem = Type.Object(
	{
		type: Type.String(),
		title: Type.String(),
		status: Type.Integer(),
		detail: Type.String(),
		code: ProblemCode,
		instance: Type.String(),
	},
	{ additionalProperties: false },
);
export type Problem = Static<typeof Problem>;
