import { statSync } from "node:fs";
import { Value } from "typebox/value";
import type { ClioSettings } from "../../core/config.js";
import { settingsPath, validateSettingsFile } from "../../core/config.js";
import type { FundingDefinitions, FundingPeriod, FundingPool, FundingResolution } from "../../core/funding-config.js";
import { resolveFundingBinding } from "../../core/funding-config.js";
import type {
	CallEconomics,
	EconomyUnit,
	FundingEvidence,
	MoneyFact,
	ProviderCharge,
	RunEconomics,
	UnitQuantity,
} from "../../core/telemetry/economy.js";
import { CallEconomicsSchema, moneyQuantities, sumInUnit } from "../../core/telemetry/economy.js";
import type { FundingSchemeKind, PayerKind } from "../../core/telemetry/enums.js";
import { NATIVE_UNITS } from "../../core/telemetry/enums.js";
import type { EstimateMethod, Fact } from "../../core/telemetry/fact.js";
import type { CallSettled, CallStarted, RunSettled, RunUsageFacts } from "../../core/telemetry/schemas.js";
import { estimateLocalEnergy } from "../providers/energy-accounting.js";
import { targetFundingEvidence } from "../providers/funding-evidence.js";
import { quoteReferenceTariff } from "../providers/reference-tariff.js";
import { getRuntimeRegistry } from "../providers/registry.js";
import type { TargetDescriptor } from "../providers/types/target-descriptor.js";
import { copilotContextTierOf } from "../providers/types/target-descriptor.js";

/**
 * Settles the economics of a sent attempt and of a run beside the route price (token economy S8): the API equivalent at
 * a public list price with its row, the seat's credit estimate from its own listing, the funding snapshot and payer, the
 * user's marginal charge and local energy. The route price stays `pricing` (R1); nothing here feeds a cap or admission.
 *
 * A marginal charge is measured only when the provider asserted the call's charge on a pool the user pays per token.
 * Declared coverage reads as an included estimate, and no evidence leaves it unknown, never zero (open question 1).
 */

type Missing = Extract<Fact<number>, { kind: "unknown" | "absent" }>;
type BusyInterval = { startMs: number; endMs: number };
type UsageCounts = { fresh: number; read: number; write: number; write1h: number; output: number };

const notObserved: Missing = { kind: "unknown", reason: "not-observed" };
const unsupported: Missing = { kind: "unknown", reason: "unsupported" };
const notApplicable: Missing = { kind: "absent", reason: "not-applicable" };

/** The seat's prices for one model on the target's tier, in AI credits per `batchSize` tokens, as its listing states. */
export interface SeatTariff {
	prices: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number };
	batchSize: number | undefined;
	/** The listing's own discount on usage billed through the model. */
	discountPercent?: number;
	/** A promotion the listing states for the account; it applies while it runs. */
	promo?: { discountPercent?: number; endsAt?: string };
	/** When the listing was read, the as-of time of the estimate. */
	readAt: string;
}

export interface CallEconomyInputs {
	funding: FundingResolution;
	runtime: { id: string; tier: string | undefined };
	/**
	 * The retention class `cacheWrite` tokens are priced at in the API equivalent; `unknown` prices them only where every
	 * published write rate agrees. `cacheWrite1h` is always the `1h` class.
	 */
	cacheWriteRetention: string;
	seat?: SeatTariff | undefined;
	/** The call's busy time not already attributed to another call on the same local pool; absent when unknown. */
	energyIntervals?: readonly BusyInterval[] | undefined;
}

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

/** Runtimes whose usage never reports the 1-hour cache-write subset, so its absence there means none was split out. */
const NO_LONG_WRITE_SUBSET: ReadonlySet<string> = new Set(["copilot-sdk"]);

/**
 * The disjoint counts to bill. A bucket the provider did not report is unknown, and one the route has no such bucket
 * for counts as none. `cacheWrite` already includes its 1-hour subset, so `write` is the remainder and a subset larger
 * than its total is invalid. An unreported subset is none only where it cannot exist: of zero writes, or on a runtime
 * that never reports one.
 */
function usageCounts(
	usage: Readonly<Record<"input" | "cacheRead" | "cacheWrite" | "cacheWrite1h" | "output", Fact<number>>> | null,
	runtimeId: string,
): UsageCounts | null {
	if (usage === null) return null;
	const count = (fact: Fact<number>): number | null =>
		fact.kind === "measured" || fact.kind === "estimated" ? fact.value : fact.kind === "absent" ? 0 : null;
	const fresh = count(usage.input);
	const read = count(usage.cacheRead);
	const writes = count(usage.cacheWrite);
	const output = count(usage.output);
	if (fresh === null || read === null || writes === null || output === null) return null;
	const write1h = count(usage.cacheWrite1h) ?? (writes === 0 || NO_LONG_WRITE_SUBSET.has(runtimeId) ? 0 : null);
	if (write1h === null || write1h > writes) return null;
	return { fresh, read, write: writes - write1h, write1h, output };
}

/** The served model when the provider reported one, else a pinned requested model; `auto` has no equivalent. */
function pricedModel(
	target: CallSettled["target"],
): { model: string; basis: "served-model" | "requested-model" } | null {
	if (target.reportedModel.kind === "measured") return { model: target.reportedModel.value, basis: "served-model" };
	if (target.requestedModel.length === 0 || target.requestedModel === "auto") return null;
	return { model: target.requestedModel, basis: "requested-model" };
}

/** What one sent attempt, or the part of a run's spend no attempt explains, settles from. */
interface Spend {
	disposition: CallSettled["disposition"];
	counts: UsageCounts | null;
	model: { model: string; basis: "served-model" | "requested-model" } | null;
	usd: Fact<number>;
	pricedBy: string;
	providerCharge: ProviderCharge | undefined;
	/** Several requests folded into one count: priced only where no prompt-size tier could have split them. */
	requests: "one" | "several";
}

function apiEquivalentOf(spend: Spend, at: Date, retention: string): CallEconomics["comparison"]["apiEquivalent"] {
	const { counts, model } = spend;
	if (counts === null || model === null) return { amount: notObserved };
	const write: Record<string, number> = {};
	if (counts.write > 0) write[retention] = counts.write;
	if (counts.write1h > 0) write["1h"] = (write["1h"] ?? 0) + counts.write1h;
	const quote = quoteReferenceTariff(model.model, at, {
		fresh: counts.fresh,
		read: counts.read,
		write,
		output: counts.output,
	});
	// A folded prompt within the base tier puts every request in it; beyond it the requests' own tiers are unknown.
	if (quote.kind !== "quoted" || (spend.requests === "several" && quote.tier !== "base")) return { amount: unsupported };
	return {
		currency: "USD",
		amount: { kind: "estimated", value: quote.usd, method: "public-retail-tariff" },
		referenceRowId: quote.rowId,
		asOf: quote.verifiedAt,
		basis: model.basis,
	};
}

function promoApplies(promo: SeatTariff["promo"], at: Date): boolean {
	if (promo?.discountPercent === undefined || promo.discountPercent <= 0) return false;
	if (promo.endsAt === undefined) return true;
	const ends = Date.parse(promo.endsAt);
	return Number.isFinite(ends) && ends > at.getTime();
}

/** The seat's debit for the counts at the listing's applicable rate, its stated discount and running promotion included (Q3). */
function seatNanoAiu(seat: SeatTariff, counts: UsageCounts, at: Date): number | null {
	const batch = seat.batchSize;
	if (batch === undefined || !Number.isFinite(batch) || batch <= 0) return null;
	let credits = 0;
	for (const [count, price] of [
		[counts.fresh, seat.prices.input],
		[counts.read, seat.prices.cacheRead],
		[counts.write, seat.prices.cacheWrite],
		[counts.write1h, seat.prices.cacheWrite1h],
		[counts.output, seat.prices.output],
	] as const) {
		if (count === 0) continue;
		if (price === undefined || !Number.isFinite(price) || price < 0) return null;
		credits += (count * price) / batch;
	}
	const discount = (percent: number | undefined) =>
		percent === undefined || percent <= 0 ? 1 : Math.max(0, 1 - Math.min(percent, 100) / 100);
	const factor =
		discount(seat.discountPercent) * (promoApplies(seat.promo, at) ? discount(seat.promo?.discountPercent) : 1);
	const nano = Math.round(credits * 1e9 * factor);
	return Number.isSafeInteger(nano) && nano >= 0 ? nano : null;
}

function payerOf(pool: FundingPool): PayerKind {
	if (pool.payer === "employer") return "organization";
	return pool.payer ?? "unknown";
}

function schemeKindOf(pool: FundingPool, runtime: CallEconomyInputs["runtime"]): FundingSchemeKind {
	if (runtime.id === "copilot-sdk") return "seat";
	if (pool.grant !== undefined) return "grant";
	if (pool.local !== undefined || runtime.tier === "local-native") return "local";
	if (pool.fee?.period === "one-time") return "prepaid";
	if (pool.fee !== undefined || runtime.tier === "subscription") return "subscription";
	if (pool.payer === "none") return "free-tier";
	if (pool.payer === "personal") return "pay-per-token";
	return "unknown";
}

function unitOf(pool: FundingPool, kind: FundingSchemeKind): EconomyUnit {
	if (pool.nativeUnit !== undefined && (NATIVE_UNITS as readonly string[]).includes(pool.nativeUnit))
		return pool.nativeUnit as EconomyUnit;
	if (pool.fee !== undefined && /^[A-Z]{3}$/u.test(pool.fee.currency)) return pool.fee.currency;
	if (kind === "seat") return "nano-aiu";
	return "unknown";
}

/** The UTC calendar period containing `at`: a day, an ISO week from Monday, a month or a year. */
function calendarPeriod(period: Exclude<FundingPeriod, "one-time">, at: Date): { start: Date; end: Date } {
	const y = at.getUTCFullYear();
	const m = at.getUTCMonth();
	const d = at.getUTCDate();
	if (period === "year") return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
	if (period === "month") return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
	const day = new Date(Date.UTC(y, m, d));
	if (period === "day") return { start: day, end: new Date(Date.UTC(y, m, d + 1)) };
	const monday = new Date(Date.UTC(y, m, d - ((day.getUTCDay() + 6) % 7)));
	return { start: monday, end: new Date(monday.getTime() + 7 * 86_400_000) };
}

function periodOf(pool: FundingPool, at: Date): FundingEvidence["period"] {
	const fee = pool.fee;
	if (fee !== undefined && fee.period !== "one-time") {
		const { start, end } = calendarPeriod(fee.period, at);
		return { kind: fee.period, start: start.toISOString(), end: end.toISOString() };
	}
	if (fee !== undefined) return { kind: "one-time" };
	if (pool.grant !== undefined) return { kind: "one-time", end: new Date(pool.grant.expiresAt).toISOString() };
	return { kind: "none" };
}

function fundingOf(
	funding: FundingResolution,
	runtime: CallEconomyInputs["runtime"],
	at: Date,
): FundingEvidence | Missing {
	if (funding.status === "unknown") return notObserved;
	const kind = schemeKindOf(funding.pool, runtime);
	return {
		kind: "snapshot",
		poolId: funding.poolId,
		scheme: { source: funding.status, kind },
		payer: payerOf(funding.pool),
		unit: unitOf(funding.pool, kind),
		period: periodOf(funding.pool, at),
		...(funding.status === "detected" ? { effectiveAt: new Date(funding.detection.verifiedAt).toISOString() } : {}),
	};
}

function zero(currency: string, method: EstimateMethod): MoneyFact {
	return { currency, amount: { kind: "estimated", value: 0, method } };
}

/**
 * The extra money the user pays for the call. Measured only from a provider charge on a pool the user pays per token;
 * declared coverage or another payer is an included estimate. A grant without a known remaining balance, a lost
 * response or a missing fact is unknown.
 */
function marginalChargeOf(
	spend: Spend,
	funding: FundingResolution,
	kind: FundingSchemeKind | undefined,
	providerCharge: ProviderCharge,
): MoneyFact {
	if (funding.status === "unknown" || kind === undefined) return { amount: notObserved };
	if (kind === "local") return { amount: notApplicable };
	const pool = funding.pool;
	const payer = payerOf(pool);
	if (
		payer === "personal" &&
		kind === "pay-per-token" &&
		"currency" in providerCharge &&
		providerCharge.amount.kind === "measured"
	)
		return { currency: providerCharge.currency, amount: providerCharge.amount };
	if (spend.disposition === "sent_unsettled" || pool.grant !== undefined) return { amount: notObserved };
	const currency = pool.fee?.currency ?? "USD";
	if (payer === "organization" || payer === "sponsor" || payer === "none") return zero(currency, "plan-coverage");
	if (payer !== "personal") return { amount: notObserved };
	if (kind === "seat" || kind === "subscription" || kind === "prepaid")
		return pool.fee !== undefined ? zero(currency, "plan-coverage") : { amount: notObserved };
	if (kind !== "pay-per-token") return { amount: notObserved };
	const usd = spend.usd;
	if (usd.kind !== "measured" && usd.kind !== "estimated") return { amount: notObserved };
	if (spend.pricedBy === "target-rates")
		return { currency: "USD", amount: { kind: "estimated", value: usd.value, method: "declared-tariff" } };
	if (spend.pricedBy === "catalog")
		return { currency: "USD", amount: { kind: "estimated", value: usd.value, method: "catalog" } };
	return { amount: notObserved };
}

function energyOf(
	funding: FundingResolution,
	inputs: CallEconomyInputs,
	kind: FundingSchemeKind | undefined,
): CallEconomics["additive"]["energy"] {
	const pool = funding.status === "unknown" ? undefined : funding.pool;
	const local = inputs.runtime.tier === "local-native" || kind === "local";
	if (!local) return { kwh: notApplicable, cost: { amount: notApplicable } };
	const declared = pool?.local;
	// The power model needs both declared draws; a missing idle baseline is unknown, never 0 W.
	if (declared?.activeWatts === undefined || declared.idleWatts === undefined || inputs.energyIntervals === undefined)
		return { kwh: notObserved, cost: { amount: notObserved } };
	const tariff = declared.tariff;
	const estimate = estimateLocalEnergy(
		{
			activeWatts: declared.activeWatts,
			idleWatts: declared.idleWatts,
			...(tariff ? { tariff: { currency: tariff.currency, perKwh: tariff.ratePerKwh } } : {}),
		},
		inputs.energyIntervals,
	);
	if (estimate === null || estimate.value === null) return { kwh: unsupported, cost: { amount: unsupported } };
	const cost = estimate.cost;
	return {
		kwh: { kind: "estimated", value: estimate.value, method: "power-time" },
		cost:
			cost.value === null || cost.currency === null
				? { amount: notObserved }
				: { currency: cost.currency, amount: { kind: "estimated", value: cost.value, method: "power-time" } },
	};
}

function spendOfCall(settled: CallSettled, runtimeId: string): Spend {
	return {
		disposition: settled.disposition,
		counts: usageCounts(settled.usage, runtimeId),
		model: pricedModel(settled.target),
		usd: settled.pricing.usd,
		pricedBy: settled.pricing.pricedBy,
		providerCharge: settled.economics?.additive.providerCharge,
		requests: "one",
	};
}

/**
 * One sent attempt's economics from its settlement and what the host knew when it settled. A provider charge the
 * settlement already carries is kept; every other quantity is settled beside it.
 */
export function settleCallEconomics(settled: CallSettled, at: Date, inputs: CallEconomyInputs): CallEconomics {
	if (settled.disposition === "never_sent") return missingEconomics(notApplicable);
	return settleSpend(spendOfCall(settled, inputs.runtime.id), at, inputs);
}

function settleSpend(spend: Spend, at: Date, inputs: CallEconomyInputs): CallEconomics {
	const counts = spend.counts;
	const funding = inputs.funding;
	const kind = funding.status === "unknown" ? undefined : schemeKindOf(funding.pool, inputs.runtime);
	const local = inputs.runtime.tier === "local-native" || kind === "local";
	const providerCharge: ProviderCharge = spend.providerCharge ?? {
		amount: local ? notApplicable : { kind: "unknown", reason: "provider-omitted" },
	};
	let seatCredits: CallEconomics["additive"]["seatCredits"] = { nanoAiu: notApplicable };
	if (inputs.runtime.id === "copilot-sdk") {
		const nano = inputs.seat && counts ? seatNanoAiu(inputs.seat, counts, at) : null;
		seatCredits =
			nano === null || inputs.seat === undefined
				? { nanoAiu: inputs.seat && counts ? unsupported : notObserved }
				: {
						nanoAiu: { kind: "estimated", value: nano, method: "seat-listing-tariff" },
						listingAsOf: new Date(inputs.seat.readAt).toISOString(),
					};
	}
	return {
		additive: {
			providerCharge,
			marginalCharge: marginalChargeOf(spend, funding, kind, providerCharge),
			seatCredits,
			energy: energyOf(funding, inputs, kind),
		},
		comparison: { apiEquivalent: apiEquivalentOf(spend, at, inputs.cacheWriteRetention) },
		funding: fundingOf(funding, inputs.runtime, at),
	};
}

/**
 * A grant's share of a gross charge and the personal overage beyond what remains of it, in exact nano-units so the two
 * lines always sum to the gross. Both are local allocations of the provider's one charge, never a second charge. A
 * call settles no grant share until a remaining balance is known.
 */
export function splitGrantCharge(
	gross: { currency: string; amount: number },
	grantRemaining: number,
): { sponsor: MoneyFact; personal: MoneyFact } {
	const nanos = Math.round(gross.amount * 1e9);
	const covered = Math.min(nanos, Math.max(0, Math.round(grantRemaining * 1e9)));
	const line = (value: number): MoneyFact => ({
		currency: gross.currency,
		amount: { kind: "estimated", value: value / 1e9, method: "grant-allocation" },
	});
	return { sponsor: line(covered), personal: line(nanos - covered) };
}

/** A pool's fixed fee for one billing period, declared by the user; it stands alone, never spread over calls. */
export interface PeriodFee {
	poolId: string;
	currency: string;
	amount: number;
	period: { kind: Exclude<FundingPeriod, "one-time">; start: string; end: string };
	evidence: "declared";
}

/**
 * Each pool's fee once for every billing period the window touches, whether or not a call ran in it. A one-time fee
 * has no period to place it in, so no window repeats it.
 */
export function periodFees(definitions: Readonly<FundingDefinitions>, window: { start: Date; end: Date }): PeriodFee[] {
	const fees: PeriodFee[] = [];
	if (!(window.end.getTime() > window.start.getTime())) return fees;
	for (const [poolId, pool] of Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b))) {
		const fee = pool.fee;
		if (fee === undefined || fee.period === "one-time") continue;
		let at = window.start;
		for (let guard = 0; guard < 4096 && at.getTime() < window.end.getTime(); guard += 1) {
			const { start, end } = calendarPeriod(fee.period, at);
			fees.push({
				poolId,
				currency: fee.currency,
				amount: fee.amount,
				period: { kind: fee.period, start: start.toISOString(), end: end.toISOString() },
				evidence: "declared",
			});
			at = end;
		}
	}
	return fees;
}

/** One fact for a quantity folded over a run's attempts: unknown when any is, estimated when any is, else measured. */
function collapse(
	total: ReturnType<typeof sumInUnit>,
	facts: readonly Fact<number>[],
): { unit?: string; fact: Fact<number> } {
	if ("refused" in total) return { fact: unsupported };
	const sum = total.sum;
	if (sum.unknownCount > 0) {
		const reasons = new Set(facts.flatMap((fact) => (fact.kind === "unknown" ? [fact.reason] : [])));
		return { fact: reasons.size === 1 ? ([...facts].find((fact) => fact.kind === "unknown") as Missing) : notObserved };
	}
	const unit = "unit" in total ? total.unit : undefined;
	if (sum.coverage.estimated > 0) {
		const methods = [...new Set(facts.flatMap((fact) => (fact.kind === "estimated" ? [fact.method] : [])))].sort();
		const method = methods[0];
		if (method === undefined) return { fact: notObserved };
		return { ...(unit ? { unit } : {}), fact: { kind: "estimated", value: sum.measured + sum.estimated, method } };
	}
	if (sum.coverage.measured > 0)
		return { ...(unit ? { unit } : {}), fact: { kind: "measured", value: sum.measured, source: "provider" } };
	return { fact: notApplicable };
}

function foldMoney<T extends MoneyFact>(facts: readonly T[]): T {
	const folded = collapse(
		sumInUnit(moneyQuantities(facts)),
		facts.map((fact) => fact.amount),
	);
	return (folded.unit === undefined ? { amount: folded.fact } : { currency: folded.unit, amount: folded.fact }) as T;
}

function foldProviderCharge(charges: readonly ProviderCharge[]): ProviderCharge {
	const folded = foldMoney(charges);
	const flagged = charges.some((charge) => "discrepancy" in charge && charge.discrepancy !== undefined);
	return "currency" in folded && flagged ? { ...folded, discrepancy: "free-route" } : folded;
}

function foldSeatCredits(
	credits: readonly CallEconomics["additive"]["seatCredits"][],
): CallEconomics["additive"]["seatCredits"] {
	const facts = credits.map((credit) => credit.nanoAiu);
	const quantities: UnitQuantity[] = facts.map((fact) =>
		fact.kind === "unknown" || fact.kind === "absent" ? { fact } : { unit: "nano-aiu", fact },
	);
	const folded = collapse(sumInUnit(quantities), facts).fact;
	const asOf = credits
		.flatMap((credit) => ("listingAsOf" in credit ? [credit.listingAsOf] : []))
		.sort()
		.at(0);
	if (folded.kind === "estimated" && asOf !== undefined)
		return { nanoAiu: { kind: "estimated", value: folded.value, method: "seat-listing-tariff" }, listingAsOf: asOf };
	return { nanoAiu: folded.kind === "unknown" || folded.kind === "absent" ? folded : unsupported };
}

function foldEnergy(energy: readonly CallEconomics["additive"]["energy"][]): CallEconomics["additive"]["energy"] {
	const facts = energy.map((line) => line.kwh);
	let kwh = 0;
	let known = 0;
	const missing = facts.filter((fact) => fact.kind === "unknown" || fact.kind === "absent") as Missing[];
	for (const fact of facts) {
		if (fact.kind !== "estimated") continue;
		kwh += fact.value;
		known += 1;
	}
	const folded: CallEconomics["additive"]["energy"]["kwh"] = missing.some((fact) => fact.kind === "unknown")
		? (missing.find((fact) => fact.kind === "unknown") as Missing)
		: known > 0
			? { kind: "estimated", value: kwh, method: "power-time" }
			: notApplicable;
	const cost = foldMoney(energy.map((line) => line.cost));
	return { kwh: folded, cost: cost as CallEconomics["additive"]["energy"]["cost"] };
}

function foldApiEquivalent(
	lines: readonly CallEconomics["comparison"]["apiEquivalent"][],
): CallEconomics["comparison"]["apiEquivalent"] {
	const folded = foldMoney(
		lines.map((line): MoneyFact => ("currency" in line ? { currency: line.currency, amount: line.amount } : line)),
	);
	if (!("currency" in folded)) return folded;
	const priced = lines.filter((line) => "currency" in line);
	const rows = new Set(priced.map((line) => `${line.referenceRowId}\u0000${line.asOf}`));
	const first = priced[0];
	// One row names one schedule; a run that drew on two models has no single row to pin its sum to.
	if (rows.size !== 1 || first === undefined || folded.amount.kind !== "estimated") return { amount: unsupported };
	return {
		currency: folded.currency,
		amount: { kind: "estimated", value: folded.amount.value, method: "public-retail-tariff" },
		referenceRowId: first.referenceRowId,
		asOf: first.asOf,
		basis: priced.every((line) => line.basis === "served-model") ? "served-model" : "requested-model",
	};
}

function foldFunding(funding: readonly CallEconomics["funding"][]): RunEconomics["funding"] {
	if (funding.some((line) => line.kind === "unknown")) return notObserved;
	const pools = new Map<string, FundingEvidence>();
	for (const line of funding) if (line.kind === "snapshot") pools.set(JSON.stringify(line), line);
	if (pools.size === 0) return notApplicable;
	if (pools.size > 32) return unsupported;
	return [...pools.values()];
}

/**
 * A run's economics folded over its sent attempts, one fact per quantity as its route price is. Without attempts the
 * run's economics are `none`: not applicable when it sent nothing, unknown when its calls were not seen.
 */
export function runEconomicsFromCalls(calls: readonly CallEconomics[], none: Missing): RunEconomics {
	if (calls.length === 0) return missingEconomics(none);
	return {
		additive: {
			providerCharge: foldProviderCharge(calls.map((call) => call.additive.providerCharge)),
			marginalCharge: foldMoney(calls.map((call) => call.additive.marginalCharge)),
			seatCredits: foldSeatCredits(calls.map((call) => call.additive.seatCredits)),
			energy: foldEnergy(calls.map((call) => call.additive.energy)),
		},
		comparison: { apiEquivalent: foldApiEquivalent(calls.map((call) => call.comparison.apiEquivalent)) },
		funding: foldFunding(calls.map((call) => call.funding)),
	};
}

// The host side: what this process knows when a settlement reaches its journal.

let settingsMemo: { key: string; settings: ClioSettings | null } | undefined;

/** The user settings, reread only when the file changes; settings that do not validate leave funding unknown. */
function currentSettings(): ClioSettings | null {
	const path = settingsPath();
	let key = `${path}\u0000missing`;
	try {
		const stat = statSync(path);
		key = `${path}\u0000${stat.ino}:${stat.size}:${stat.mtimeMs}`;
	} catch {
		// No settings file reads as the defaults.
	}
	if (settingsMemo?.key === key) return settingsMemo.settings;
	let settings: ClioSettings | null = null;
	try {
		const result = validateSettingsFile();
		settings = result.issues.length === 0 ? result.settings : null;
	} catch {
		settings = null;
	}
	settingsMemo = { key, settings };
	return settings;
}

const seatListing = new Map<string, { billing: NonNullable<SeatListingRow["billing"]>; readAt: string }>();
let listing: Promise<void> | undefined;
type SeatListingRow = NonNullable<
	Awaited<ReturnType<typeof import("../../engine/ai.js").listHeldCopilotSdkModels>>
>[number];

let awaitingClient = false;

/**
 * Reads the seat's model listing from the Copilot runtime this process already holds, when a copilot-sdk attempt
 * starts, so its settlement can price at the listing's rate. An attempt that starts before its runtime is connected
 * (the model list came from cache) reads the listing once the runtime it streams on connects, before it has usage.
 * Each read replaces the last, and a failed or empty read clears it, so a call never prices at another login's
 * listing. Never starts a runtime and never delays a call; a call that settles before its read reads unknown.
 */
function warmSeatListing(runtimeId: string): void {
	if (runtimeId !== "copilot-sdk" || listing !== undefined) return;
	listing = import("../../engine/ai.js")
		.then(async (engine) => {
			const rows = await engine.listHeldCopilotSdkModels();
			if (rows === null && !awaitingClient) {
				awaitingClient = true;
				await engine.onceCopilotSdkClientHeld(() => {
					awaitingClient = false;
					void Promise.resolve(listing).then(() => warmSeatListing("copilot-sdk"));
				});
			}
			return rows;
		})
		.then(
			(rows) => {
				seatListing.clear();
				for (const row of rows ?? [])
					if (row.billing !== undefined) seatListing.set(row.id, { billing: row.billing, readAt: row.listingReadAt });
			},
			() => seatListing.clear(),
		)
		.finally(() => {
			listing = undefined;
		});
}

function seatTariffOf(model: string | null, target: TargetDescriptor | undefined): SeatTariff | undefined {
	const row = model === null ? undefined : seatListing.get(model);
	const prices = row?.billing.tokenPrices;
	if (row === undefined || prices === undefined) return undefined;
	const tier = copilotContextTierOf(target) === "long_context" ? prices.longContext : prices;
	if (tier === undefined) return undefined;
	const { discountPercent, promo } = row.billing;
	return {
		prices: {
			...(tier.inputPrice === undefined ? {} : { input: tier.inputPrice }),
			...(tier.outputPrice === undefined ? {} : { output: tier.outputPrice }),
			...((tier.cacheReadPrice ?? tier.cachePrice) === undefined
				? {}
				: { cacheRead: tier.cacheReadPrice ?? tier.cachePrice }),
			...(tier.cacheWritePrice === undefined ? {} : { cacheWrite: tier.cacheWritePrice }),
			...(tier.cacheWrite1hPrice === undefined ? {} : { cacheWrite1h: tier.cacheWrite1hPrice }),
		},
		batchSize: prices.batchSize,
		...(discountPercent === undefined ? {} : { discountPercent }),
		...(promo === undefined
			? {}
			: {
					promo: {
						...(promo.discountPercent === undefined ? {} : { discountPercent: promo.discountPercent }),
						...(promo.endsAt === undefined ? {} : { endsAt: promo.endsAt }),
					},
				}),
		readAt: row.readAt,
	};
}

const busyByPool = new Map<string, BusyInterval[]>();
const BUSY_MEMORY = 256;

/** The part of a call's busy interval no call that settled before it on the same pool already covers, so shared time counts once. */
function exclusiveBusy(poolKey: string, interval: BusyInterval): BusyInterval[] {
	const prior = busyByPool.get(poolKey) ?? [];
	let pieces: BusyInterval[] = [interval];
	for (const taken of prior)
		pieces = pieces.flatMap((piece) => {
			if (taken.endMs <= piece.startMs || taken.startMs >= piece.endMs) return [piece];
			return [
				...(taken.startMs > piece.startMs ? [{ startMs: piece.startMs, endMs: taken.startMs }] : []),
				...(taken.endMs < piece.endMs ? [{ startMs: taken.endMs, endMs: piece.endMs }] : []),
			];
		});
	busyByPool.set(poolKey, [...prior, interval].slice(-BUSY_MEMORY));
	return pieces;
}

function busyIntervalOf(settled: CallSettled, wallMs: number): BusyInterval | undefined {
	const settle = settled.stages.settle;
	if (settle === null) return undefined;
	const sent = settled.stages.send?.start ?? 0;
	const startMs = wallMs - Math.max(0, settle - sent);
	return startMs >= 0 && wallMs >= startMs ? { startMs, endMs: wallMs } : undefined;
}

/** What an attempt contributed to its run's usage, so a run can settle the part its attempts do not explain. */
type Part = { counts: UsageCounts | null; usd: number | null };
type Settled = { economics: CallEconomics; part: Part };

const settledByCall = new Map<string, Map<string, Settled>>();
const CALL_MEMORY = 8192;

function remember(callId: string, attemptId: string, settled: Settled): void {
	const attempts = settledByCall.get(callId) ?? new Map<string, Settled>();
	settledByCall.delete(callId);
	attempts.set(attemptId, settled);
	settledByCall.set(callId, attempts);
	while (settledByCall.size > CALL_MEMORY) {
		const oldest = settledByCall.keys().next().value;
		if (oldest === undefined) break;
		settledByCall.delete(oldest);
	}
}

type TargetFunding = { target: TargetDescriptor | undefined; funding: FundingResolution };

/** The target and the pool it draws on, as the user's settings bind them now. */
function targetFundingOf(targetId: string, runtimeId: string): TargetFunding {
	const settings = currentSettings();
	const target = settings?.targets.find((candidate) => candidate.id === targetId);
	const definitions = settings?.funding ?? {};
	const binding = target?.funding;
	const observation =
		target !== undefined && binding !== undefined && definitions[binding.pool]?.scheme === "detected"
			? targetFundingEvidence(target, getRuntimeRegistry().get(runtimeId)).observation
			: undefined;
	return {
		target,
		funding:
			target === undefined
				? { status: "unknown", reason: "unbound" }
				: resolveFundingBinding(definitions, binding, observation),
	};
}

const fundingAtStart = new Map<string, TargetFunding>();
const START_MEMORY = 1024;

/**
 * Captures the funding an attempt starts under, so a rebind before it settles cannot seal it under another payer,
 * and reads the seat's listing for a copilot-sdk attempt.
 */
export function noteCallStarted(started: CallStarted): void {
	try {
		warmSeatListing(started.target.runtimeId);
		fundingAtStart.set(started.attemptId, targetFundingOf(started.target.targetId, started.target.runtimeId));
		while (fundingAtStart.size > START_MEMORY) {
			const oldest = fundingAtStart.keys().next().value;
			if (oldest === undefined) break;
			fundingAtStart.delete(oldest);
		}
	} catch {
		// Without a captured start the settlement resolves the binding it settles under.
	}
}

function inputsFor(
	route: { targetId: string; runtimeId: string; api: string | undefined },
	model: string | null,
	resolved: TargetFunding,
	busy: BusyInterval | undefined,
): CallEconomyInputs {
	const { target, funding } = resolved;
	const poolKey = funding.status === "unknown" ? `target:${route.targetId}` : `pool:${funding.poolId}`;
	return {
		funding,
		runtime: { id: route.runtimeId, tier: getRuntimeRegistry().get(route.runtimeId)?.tier },
		// Anthropic's default cache write is the 5-minute class; elsewhere a call records no retention, so none is assumed.
		cacheWriteRetention: route.api === "anthropic-messages" ? "5m" : "unknown",
		seat: route.runtimeId === "copilot-sdk" ? seatTariffOf(model, target) : undefined,
		energyIntervals: busy === undefined ? undefined : exclusiveBusy(poolKey, busy),
	};
}

function hostInputs(settled: CallSettled, wallMs: number): CallEconomyInputs {
	const { targetId, runtimeId } = settled.target;
	const resolved = fundingAtStart.get(settled.attemptId) ?? targetFundingOf(targetId, runtimeId);
	fundingAtStart.delete(settled.attemptId);
	return inputsFor(
		settled.target,
		pricedModel(settled.target)?.model ?? null,
		resolved,
		busyIntervalOf(settled, wallMs),
	);
}

const knownValue = (fact: Fact<number>): number | null =>
	fact.kind === "measured" || fact.kind === "estimated" ? fact.value : null;

/**
 * A settlement with its economics, settled once per attempt in this process: a second journal that receives the same
 * settlement gets the same economics, and local busy time is attributed once. A provider charge the settlement already
 * carries is kept beside the rest. Economics that fail their schema leave the settlement as it came, which reads as
 * not captured.
 */
export function stampCallEconomics(settled: CallSettled, wallMs: number): CallSettled {
	const known = settledByCall.get(settled.callId)?.get(settled.attemptId);
	if (known !== undefined)
		return settled.disposition === "never_sent" ? settled : { ...settled, economics: known.economics };
	try {
		if (settled.disposition === "never_sent") {
			fundingAtStart.delete(settled.attemptId);
			const none = { fresh: 0, read: 0, write: 0, write1h: 0, output: 0 };
			remember(settled.callId, settled.attemptId, {
				economics: missingEconomics(notApplicable),
				part: { counts: none, usd: 0 },
			});
			return settled;
		}
		const inputs = hostInputs(settled, wallMs);
		const economics = settleCallEconomics(settled, new Date(wallMs), inputs);
		if (!Value.Check(CallEconomicsSchema, economics)) return settled;
		const part = { counts: usageCounts(settled.usage, inputs.runtime.id), usd: knownValue(settled.pricing.usd) };
		remember(settled.callId, settled.attemptId, { economics, part });
		return { ...settled, economics };
	} catch {
		return settled;
	}
}

const COUNT_KEYS = ["fresh", "read", "write", "write1h", "output"] as const;

/**
 * The run's usage its attempts do not explain, such as a peer's aggregate report: none when the attempts explain it
 * or their own economics are already unknown, `unknown` when the remainder cannot be counted.
 */
function restOf(facts: RunUsageFacts, runtimeId: string, parts: readonly (Part | null)[], sent: number) {
	if (parts.some((part) => part === null || part.counts === null)) return null;
	const total = usageCounts(facts.usage, runtimeId);
	if (total === null) {
		const apiCalls = knownValue(facts.apiCalls);
		return apiCalls !== null && apiCalls <= sent ? null : ("unknown" as const);
	}
	const counts = { ...total };
	for (const part of parts) for (const key of COUNT_KEYS) counts[key] -= part?.counts?.[key] ?? 0;
	if (COUNT_KEYS.some((key) => counts[key] < 0)) return "unknown" as const;
	if (COUNT_KEYS.every((key) => counts[key] === 0)) return null;
	const totalUsd = knownValue(facts.pricing.usd);
	const usd =
		totalUsd === null || parts.some((part) => part?.usd === null)
			? notObserved
			: ({
					...facts.pricing.usd,
					value: Math.max(
						0,
						parts.reduce((left, part) => left - (part?.usd ?? 0), totalUsd),
					),
				} as Fact<number>);
	return { counts, usd };
}

/** The economics of a run's spend no attempt explains, priced as several requests on the run's route. */
function settleRest(
	rest: Exclude<ReturnType<typeof restOf>, null>,
	run: { facts: RunUsageFacts; route: RunSettled["route"]; endedAt: string },
): CallEconomics {
	if (rest === "unknown") return missingEconomics(notObserved);
	try {
		const { targetId, runtimeId, wireModelId } = run.route;
		const ended = Date.parse(run.endedAt);
		const at = Number.isFinite(ended) ? new Date(ended) : new Date();
		const model = wireModelId.length === 0 || wireModelId === "auto" ? null : wireModelId;
		const inputs = inputsFor(
			{ targetId, runtimeId, api: undefined },
			model,
			targetFundingOf(targetId, runtimeId),
			undefined,
		);
		const economics = settleSpend(
			{
				disposition: "settled",
				counts: rest.counts,
				model: model === null ? null : { model, basis: "requested-model" },
				usd: rest.usd,
				pricedBy: run.facts.pricing.pricedBy,
				providerCharge: undefined,
				requests: "several",
			},
			at,
			inputs,
		);
		return Value.Check(CallEconomicsSchema, economics) ? economics : missingEconomics(notObserved);
	} catch {
		return missingEconomics(notObserved);
	}
}

/**
 * A run's economics from the attempts this process settled for its calls, plus the run's usage they do not explain
 * (an aggregate report), settled on the run's route. A call this process never settled counts as not captured; a run
 * that recorded no calls is not applicable when it made no API call, else unknown.
 */
export function settledRunEconomics(
	callIds: readonly string[] | null,
	run: { facts: RunUsageFacts; route: RunSettled["route"]; endedAt: string },
): RunEconomics {
	const notCaptured: Missing = { kind: "unknown", reason: "not-captured" };
	const calls: CallEconomics[] = [];
	const parts: (Part | null)[] = [];
	let sent = 0;
	for (const callId of callIds ?? []) {
		const attempts = settledByCall.get(callId);
		if (attempts === undefined) {
			calls.push(missingEconomics(notCaptured));
			parts.push(null);
			continue;
		}
		for (const { economics, part } of attempts.values()) {
			parts.push(part);
			// An attempt never sent is remembered as not applicable, so its call reads as seen; it charges nothing.
			if (economics.funding.kind === "absent") continue;
			calls.push(economics);
			sent += 1;
		}
	}
	const rest = restOf(run.facts, run.route.runtimeId, parts, sent);
	if (rest !== null) calls.push(settleRest(rest, run));
	const sentNothing = run.facts.apiCalls.kind === "measured" && run.facts.apiCalls.value === 0;
	return runEconomicsFromCalls(calls, sentNothing ? notApplicable : notCaptured);
}
