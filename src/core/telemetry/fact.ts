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
	// The serialized size of the payload Pi handed its provider; the wire frame may wrap it (#434).
	"payload-json",
	// The economics methods (token economy S1). Each names the evidence an economics estimate was derived from; none of
	// them prices a route, which stays `pricedBy` (R1).
	// A named public API list-price row applied to the call's counts: the API-equivalent comparison (Q5).
	"public-retail-tariff",
	// The signed-in seat's own model listing (Copilot `billing.tokenPrices`) applied to the call's counts (Q6).
	"seat-listing-tariff",
	// A plan's stated coverage of the call, such as an included allowance, without a provider statement of the charge.
	"plan-coverage",
	// A fee or tariff the user declared: a plan fee, a negotiated rate, an electricity price.
	"declared-tariff",
	// A share of a declared grant or prepaid balance attributed to the call by local arithmetic.
	"grant-allocation",
	// Declared active and idle power over a busy interval: energy as kWh, and its cost at a declared tariff.
	"power-time",
]);
export type EstimateMethod = Static<typeof EstimateMethod>;
export const UnknownReason = vocabulary([
	"provider-omitted",
	"stream-dropped",
	"not-observed",
	"unsupported",
	"writer-gap",
	// The record's writer did not capture this fact: a record that predates it, or one no producer filled yet. History
	// reads as recorded, never backfilled and never zero (token economy R2).
	"not-captured",
]);
export type UnknownReason = Static<typeof UnknownReason>;
export type Fact<T> =
	| { kind: "measured"; value: T; source: "provider" | "local-clock" | "local-count" }
	| { kind: "estimated"; value: T; method: EstimateMethod }
	| { kind: "unknown"; reason: UnknownReason }
	| { kind: "absent"; reason: "not-captured-in-mode" | "not-applicable" };

const closed = { additionalProperties: false };
export const UnknownFactSchema = Type.Object({ kind: Type.Literal("unknown"), reason: UnknownReason }, closed);
export const AbsentFactSchema = Type.Object(
	{ kind: Type.Literal("absent"), reason: vocabulary(["not-captured-in-mode", "not-applicable"]) },
	closed,
);
export function factSchema<T extends TSchema>(value: T) {
	return Type.Union([
		Type.Object(
			{ kind: Type.Literal("measured"), value, source: vocabulary(["provider", "local-clock", "local-count"]) },
			closed,
		),
		Type.Object({ kind: Type.Literal("estimated"), value, method: EstimateMethod }, closed),
		UnknownFactSchema,
		AbsentFactSchema,
	]);
}

/** A sum of facts as it crosses a boundary: the known subtotal and how many contributions were unknown (#434). */
export const FactSumSchema = Type.Object(
	{
		measured: Type.Number({ minimum: 0 }),
		estimated: Type.Number({ minimum: 0 }),
		unknownCount: Type.Integer({ minimum: 0 }),
		absentCount: Type.Integer({ minimum: 0 }),
		coverage: Type.Object(
			{
				measured: Type.Integer({ minimum: 0 }),
				estimated: Type.Integer({ minimum: 0 }),
				unknown: Type.Integer({ minimum: 0 }),
			},
			closed,
		),
	},
	closed,
);

export interface FactSum {
	measured: number;
	estimated: number;
	unknownCount: number;
	absentCount: number;
	coverage: { measured: number; estimated: number; unknown: number };
}
