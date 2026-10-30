import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { vocabulary } from "./enums.js";

export const EstimateMethod = vocabulary([
	"chars/4",
	"target-rates",
	"catalog",
	"prompt-side-only",
	"shared-account-window-delta",
	"peer-report",
]);
export type EstimateMethod = Static<typeof EstimateMethod>;
export const UnknownReason = vocabulary([
	"provider-omitted",
	"stream-dropped",
	"not-observed",
	"legacy-record",
	"unsupported",
	"writer-gap",
]);
export type UnknownReason = Static<typeof UnknownReason>;
export type Fact<T> =
	| { kind: "measured"; value: T; source: "provider" | "local-clock" | "local-count" }
	| { kind: "estimated"; value: T; method: EstimateMethod }
	| { kind: "unknown"; reason: UnknownReason }
	| { kind: "absent"; reason: "not-captured-in-mode" | "not-applicable" };

const closed = { additionalProperties: false };
export function factSchema<T extends TSchema>(value: T) {
	return Type.Union([
		Type.Object(
			{ kind: Type.Literal("measured"), value, source: vocabulary(["provider", "local-clock", "local-count"]) },
			closed,
		),
		Type.Object({ kind: Type.Literal("estimated"), value, method: EstimateMethod }, closed),
		Type.Object({ kind: Type.Literal("unknown"), reason: UnknownReason }, closed),
		Type.Object({ kind: Type.Literal("absent"), reason: vocabulary(["not-captured-in-mode", "not-applicable"]) }, closed),
	]);
}

export interface FactSum {
	measured: number;
	estimated: number;
	unknownCount: number;
	absentCount: number;
	coverage: { measured: number; estimated: number; unknown: number };
}
