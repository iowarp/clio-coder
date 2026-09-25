import { type Static, Type } from "typebox";

export const Id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });
/**
 * The widest artifact window the server keeps per family. Every list route is
 * clamped below it, so the cap is not the operating limit: it is the assertion
 * that a projection which somehow returned an unbounded list is a bug to be
 * surfaced rather than an allowlist to be filled.
 */
export const MAX_SERVED_ARTIFACT_IDS = 64;
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
