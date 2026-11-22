import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { FundingPeriodKind, FundingSchemeKind, FundingSchemeSource, NativeUnit, PayerKind } from "./enums.js";
import type { Fact, FactSum } from "./fact.js";
import { AbsentFactSchema, EstimateMethod, FactSumSchema, UnknownFactSchema } from "./fact.js";

/**
 * The economics of a sent attempt and of a run, beside its route price (token economy S1, rulings R1 and R2).
 *
 * The route price stays `pricing` (`resolveEffectivePricing`, `pricedBy`, `freeRule`); nothing here prices a route,
 * feeds a cap or says "you paid". Each quantity is one `Fact<number>` in exactly one unit, so a total over them either
 * keeps that unit or is refused. Quantities are grouped by what may be added:
 *
 * - `additive`: amounts that sum within one unit across attempts: the provider's reported charge, the user's marginal
 *   charge, the seat's estimated credit debit, local energy and its cost.
 * - `comparison`: counterfactual amounts that are never added to cash: the API equivalent at a public list price.
 *
 * There is no signed savings field. A difference between a comparison and a charge is shown as two aligned sums, or as
 * a direction and a magnitude; `FactSum` stays nonnegative.
 *
 * A leaf: TypeBox, the vocabulary and the fact shapes only, so a browser bundle can carry it (`id-schemas.ts`).
 */

const closed = { additionalProperties: false };

/** A count that survives JSON and arithmetic exactly: an integer in `[0, Number.MAX_SAFE_INTEGER]`. */
export const SafeCountSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
/** A finite nonnegative amount; JSON has no spelling for NaN or the infinities and TypeBox refuses them. */
const AmountSchema = Type.Number({ minimum: 0 });
/** An ISO 4217 currency code, such as `USD`. */
export const CurrencyCodeSchema = Type.String({ pattern: "^[A-Z]{3}$" });
/** A currency code or a native unit word; the two spellings are disjoint, so a unit is never ambiguous. */
export const EconomyUnitSchema = Type.Union([CurrencyCodeSchema, NativeUnit]);
export type EconomyUnit = Static<typeof EconomyUnitSchema>;
/**
 * A locally opaque identifier: a funding pool, an account pseudonym, a scheme revision or a tariff reference. Its
 * characters exclude `@`, `/` and whitespace, so an e-mail address or a path cannot pass as one.
 */
export const OpaqueIdSchema = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$" });
/** A reference tariff row's identifier, as the schedule that publishes it spells it. */
const ReferenceRowIdSchema = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:/@#+-]{0,255}$" });
const utc = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
/** A source's as-of point: a verification date, or the instant a listing was read. */
const asOf = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)?$" });

const MissingFactSchema = Type.Union([UnknownFactSchema, AbsentFactSchema]);
const measuredByProvider = <T extends TSchema>(value: T) =>
	Type.Object({ kind: Type.Literal("measured"), value, source: Type.Literal("provider") }, closed);
const estimatedBy = <T extends TSchema, M extends TSchema>(value: T, method: M) =>
	Type.Object({ kind: Type.Literal("estimated"), value, method }, closed);
/** A money fact: a known amount names its currency, a missing one has none to name. */
const money = <K extends TSchema>(known: K) =>
	Type.Union([
		Type.Object({ currency: CurrencyCodeSchema, amount: known }, closed),
		Type.Object({ amount: MissingFactSchema }, closed),
	]);

/**
 * What the provider reported it charged for the attempt, gross of any split between payers. Measured only from the
 * provider; a peer's own client-side total (Claude SDK `total_cost_usd`) is a `peer-report` estimate. It sits beside the
 * route price and never replaces it, even when the route is declared free (R1).
 */
export const ProviderChargeSchema = money(
	Type.Union([measuredByProvider(AmountSchema), estimatedBy(AmountSchema, Type.Literal("peer-report"))]),
);
/**
 * The extra money payable by the user for the attempt, excluding fixed fees already paid. Measured only from a
 * provider or statement assertion of amount, payer and scope; otherwise an estimate by the method that derived it, or
 * unknown when a critical fact is missing. Local tariff arithmetic is never a measured personal charge.
 */
export const MarginalChargeSchema = money(
	Type.Union([measuredByProvider(AmountSchema), estimatedBy(AmountSchema, EstimateMethod)]),
);
/**
 * The seat's estimated debit for the attempt in nano-AIU (1 AI credit = 1e9 nano-AIU), from the signed-in seat's own
 * model listing read at `listingAsOf` (Q6). The reported debit stays `call.settled` `billing.nanoAiu`, beside it; a
 * reported value always wins over this estimate.
 */
export const SeatCreditEstimateSchema = Type.Union([
	Type.Object({ nanoAiu: estimatedBy(SafeCountSchema, Type.Literal("seat-listing-tariff")), listingAsOf: asOf }, closed),
	Type.Object({ nanoAiu: MissingFactSchema }, closed),
]);
/**
 * Local inference energy attributed to the attempt, and its cost at a declared electricity tariff. Both are estimates
 * from declared power over busy time (`power-time`); a known kWh with no tariff leaves the cost unknown.
 */
export const EnergySchema = Type.Object(
	{
		kwh: Type.Union([estimatedBy(AmountSchema, Type.Literal("power-time")), MissingFactSchema]),
		cost: money(estimatedBy(AmountSchema, Type.Literal("power-time"))),
	},
	closed,
);
/**
 * What the same served model, request size and cache buckets would cost at a named public API schedule's standard list
 * price (Q5). Always an estimate, never cash, and always pinned to the row it was priced from so a later schedule
 * update never reprices history. `basis` says whether the served model was known or only a pinned requested model.
 */
export const ApiEquivalentSchema = Type.Union([
	Type.Object(
		{
			currency: CurrencyCodeSchema,
			amount: estimatedBy(AmountSchema, Type.Literal("public-retail-tariff")),
			referenceRowId: ReferenceRowIdSchema,
			asOf,
			basis: Type.Union([Type.Literal("served-model"), Type.Literal("requested-model")]),
		},
		closed,
	),
	Type.Object({ amount: MissingFactSchema }, closed),
]);
/**
 * The funding snapshot an attempt was sent under: the locally opaque pool, how its scheme became known, who pays, the
 * pool's native unit and billing period. Never a credential, raw account number, statement or project path.
 */
export const FundingEvidenceSchema = Type.Object(
	{
		kind: Type.Literal("snapshot"),
		poolId: OpaqueIdSchema,
		scheme: Type.Object(
			{ source: FundingSchemeSource, kind: FundingSchemeKind, revision: Type.Optional(OpaqueIdSchema) },
			closed,
		),
		payer: PayerKind,
		unit: EconomyUnitSchema,
		period: Type.Object({ kind: FundingPeriodKind, start: Type.Optional(utc), end: Type.Optional(utc) }, closed),
		/** The tariff the snapshot applied, by identifier or digest. */
		tariffRef: Type.Optional(OpaqueIdSchema),
		/** When the snapshot's facts took effect. */
		effectiveAt: Type.Optional(utc),
	},
	closed,
);
export type FundingEvidence = Static<typeof FundingEvidenceSchema>;

const additive = Type.Object(
	{
		providerCharge: ProviderChargeSchema,
		marginalCharge: MarginalChargeSchema,
		seatCredits: SeatCreditEstimateSchema,
		energy: EnergySchema,
	},
	closed,
);
const comparison = Type.Object({ apiEquivalent: ApiEquivalentSchema }, closed);

/** One sent attempt's economics, journaled as `call.settled` `economics`. */
export const CallEconomicsSchema = Type.Object(
	{ additive, comparison, funding: Type.Union([FundingEvidenceSchema, UnknownFactSchema, AbsentFactSchema]) },
	closed,
);
export type CallEconomics = Static<typeof CallEconomicsSchema>;
/**
 * A run's economics, journaled as `run.settled` `economics`: one fact per quantity, as the run's `pricing` is, and every
 * distinct pool its attempts drew on. The read model folds the calls for coverage.
 */
export const RunEconomicsSchema = Type.Object(
	{
		additive,
		comparison,
		funding: Type.Union([
			Type.Array(FundingEvidenceSchema, { minItems: 1, maxItems: 32 }),
			UnknownFactSchema,
			AbsentFactSchema,
		]),
	},
	closed,
);
export type RunEconomics = Static<typeof RunEconomicsSchema>;
export type MoneyFact = CallEconomics["additive"]["providerCharge"] | CallEconomics["additive"]["marginalCharge"];

type Missing = Extract<Fact<number>, { kind: "unknown" | "absent" }>;

function missingEconomics(fact: Missing): CallEconomics & RunEconomics {
	return {
		additive: {
			providerCharge: { amount: fact },
			marginalCharge: { amount: fact },
			seatCredits: { nanoAiu: fact },
			energy: { kwh: fact, cost: { amount: fact } },
		},
		comparison: { apiEquivalent: { amount: fact } },
		funding: fact,
	};
}

/**
 * A call's economics as its settlement recorded them. A settlement that carries none reads as not captured, never zero;
 * a call never sent has nothing to charge; a missing settlement is unobserved (R2: history reads as recorded).
 */
export function callEconomicsOf(
	settled: { disposition: string; economics?: CallEconomics | undefined } | null | undefined,
): CallEconomics {
	if (settled === undefined || settled === null) return missingEconomics({ kind: "unknown", reason: "not-observed" });
	if (settled.economics !== undefined) return settled.economics;
	if (settled.disposition === "never_sent") return missingEconomics({ kind: "absent", reason: "not-applicable" });
	return missingEconomics({ kind: "unknown", reason: "not-captured" });
}

/** A run's economics as its run.settled recorded them; a record that carries none reads as not captured, never zero. */
export function runEconomicsOf(settled: { economics?: RunEconomics | undefined }): RunEconomics {
	return settled.economics ?? missingEconomics({ kind: "unknown", reason: "not-captured" });
}

/**
 * A total in one unit: a known subtotal names its unit; a total with no known contribution has none. Its `FactSum` is
 * nonnegative, so a comparison minus a charge never lands in it.
 */
const NothingKnownSumSchema = Type.Object(
	{ ...FactSumSchema.properties, measured: Type.Literal(0), estimated: Type.Literal(0) },
	closed,
);
export const UnitTotalSchema = Type.Union([
	Type.Object({ unit: EconomyUnitSchema, sum: FactSumSchema }, closed),
	Type.Object({ sum: NothingKnownSumSchema }, closed),
]);
export type UnitTotal = Static<typeof UnitTotalSchema>;
/** One contribution to a total: a known fact in its unit, or a missing fact that has none. */
export type UnitQuantity = { unit: EconomyUnit; fact: Fact<number> } | { fact: Missing };
/** Why a total was refused: contributions in two units, a unit that never adds, or a value outside its unit's range. */
export type UnitTotalRefusal =
	| { refused: "mixed-unit"; units: string[] }
	| { refused: "non-additive-unit" | "out-of-range"; unit: string };

/** Units whose values are whole counts, so their totals must stay safe integers. */
const INTEGRAL_UNITS: ReadonlySet<string> = new Set(["nano-aiu", "tokens", "requests"]);
/** Units no total may add: an opaque percentage is a last observation, and an unknown unit may be anything. */
const NON_ADDITIVE_UNITS: ReadonlySet<string> = new Set(["percent", "unknown"]);

/**
 * Contributions summed in their one unit, each counted once; unknown and absent contributions are counted, never summed
 * as zero. Refused, rather than coerced, when known contributions name two units, name a unit that never adds, or a
 * value or subtotal leaves its unit's range (negative, non-finite, or a whole-count unit past a safe integer).
 */
export function sumInUnit(quantities: Iterable<UnitQuantity>): UnitTotal | UnitTotalRefusal {
	const sum: FactSum = {
		measured: 0,
		estimated: 0,
		unknownCount: 0,
		absentCount: 0,
		coverage: { measured: 0, estimated: 0, unknown: 0 },
	};
	const units = new Set<string>();
	for (const quantity of quantities) {
		const fact = quantity.fact;
		if (fact.kind === "unknown") {
			sum.unknownCount += 1;
			sum.coverage.unknown += 1;
			continue;
		}
		if (fact.kind === "absent") {
			sum.absentCount += 1;
			continue;
		}
		const unit = (quantity as { unit: EconomyUnit }).unit;
		units.add(unit);
		if (NON_ADDITIVE_UNITS.has(unit)) return { refused: "non-additive-unit", unit };
		const integral = INTEGRAL_UNITS.has(unit);
		const valid = (value: number) => Number.isFinite(value) && value >= 0 && (!integral || Number.isSafeInteger(value));
		if (!valid(fact.value)) return { refused: "out-of-range", unit };
		sum[fact.kind] += fact.value;
		sum.coverage[fact.kind] += 1;
		if (!valid(sum[fact.kind])) return { refused: "out-of-range", unit };
	}
	if (units.size > 1) return { refused: "mixed-unit", units: [...units].sort() };
	const [unit] = units;
	return unit === undefined ? { sum: { ...sum, measured: 0, estimated: 0 } } : { unit: unit as EconomyUnit, sum };
}

/** Money facts as `sumInUnit` contributions: each known amount in its currency. */
export function moneyQuantities(facts: Iterable<MoneyFact>): UnitQuantity[] {
	return [...facts].map((fact) =>
		"currency" in fact ? { unit: fact.currency, fact: fact.amount } : { fact: fact.amount },
	);
}
