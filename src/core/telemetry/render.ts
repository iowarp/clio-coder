import { formatFooterTokens } from "../display-units.js";
import type { Fact, FactSum } from "./fact.js";
import type { Pricing, PricingSum } from "./pricing.js";

/**
 * The canonical renderer (#434, R5). Every display string a telemetry DTO carries comes from here, and this module
 * is the only place outside the GUI's server-rendered strings allowed to format money (boundary rule10). Inputs are
 * facts and fold results; nothing here sums, prices or infers a value.
 */

const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function renderCount(value: number): string {
	return grouped.format(Math.round(value));
}

/** The USD amount alone, with enough digits that a sub-cent call never reads as zero. */
function renderUsd(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0.00";
	if (value < 0.00000001) return `$${value.toExponential(2)}`;
	const digits = value < 0.01 ? Math.min(8, Math.max(4, Math.ceil(-Math.log10(value)))) : 2;
	return `$${value.toFixed(digits)}`;
}

/** A provider credit balance, a measured amount; it can be denominated outside USD. */
export function renderCredit(value: number, currency: string): string {
	return currency.toUpperCase() === "USD" ? renderUsd(value) : `${value.toFixed(2)} ${currency}`;
}

/** A configured limit or computed bound, never spend; a zero limit reads as `$0.00` (#434). */
export function renderUsdLimit(value: number | null | undefined): string {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? renderUsd(value) : "not set";
}

/**
 * A USD figure the operator types into a setting, such as the raise a ceiling stop names: the bare number, rounded up
 * at four decimals so the typed value is never below the one that clears the stop (#424, #434).
 */
export function renderUsdSetting(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	// The epsilon absorbs binary error in `value * 10_000`, so an exact four-decimal raise stays as written.
	return String(Math.ceil(value * 10_000 - 1e-6) / 10_000);
}

function renderDurationMs(value: number): string {
	const ms = Math.max(0, value);
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
	const minutes = Math.floor(ms / 60_000);
	return minutes < 60
		? `${minutes}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`
		: `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** What a fixed-width surface says when there is no cost claim at all; never `$0.00`. */
export const COST_NOT_MEASURED = "not measured";

/** R10: a field the mode did not capture is neither unknown nor zero. */
function renderAbsent(reason: Extract<Fact<unknown>, { kind: "absent" }>["reason"]): string {
	return reason === "not-captured-in-mode" ? "not captured (standard mode)" : "n/a";
}

function renderUnknown(reason: Extract<Fact<unknown>, { kind: "unknown" }>["reason"]): string {
	switch (reason) {
		case "provider-omitted":
			return "unknown (provider omitted)";
		case "stream-dropped":
			return "unknown (stream dropped)";
		case "unsupported":
			return "unknown (unsupported)";
		case "writer-gap":
			return "unknown (journal gap)";
		default:
			return "unknown";
	}
}

/**
 * The one cost wording family over a sum's parts. Partly priced says what it knows with `+?` marking the rest (L3);
 * estimates say so (L5); a sum nobody priced has no claim and reads as not measured, never `$0.00`.
 */
function renderUsdParts(known: number, parts: { estimated: boolean; unpriced: boolean; free: boolean }): string {
	if (parts.free && !parts.unpriced && !parts.estimated) return "$0.00 local";
	if (parts.unpriced) return known > 0 ? `${parts.estimated ? "~" : ""}${renderUsd(known)} +?` : COST_NOT_MEASURED;
	if (parts.estimated) return `~${renderUsd(known)} est`;
	return renderUsd(known);
}

/** A projected amount, such as a route's admission estimate: a figure Clio derived, never spend. */
export function renderUsdEstimate(usd: number): string {
	return `~${renderUsd(usd)} est`;
}

/** A spend a budget stop states, marked as it was priced: estimated parts and unpriced calls stay visible (#434 §6.3). */
export function renderUsdSpend(usd: number, priced: { estimated: boolean; unpriced: boolean } | undefined): string {
	return renderUsdParts(usd, {
		estimated: priced?.estimated ?? false,
		unpriced: priced?.unpriced ?? false,
		free: false,
	});
}

/**
 * What a ceiling leaves after a spend (#434 §6.3). It carries the spend's estimate, and an unpriced part of the spend,
 * which can only have spent more, makes it an upper bound: `at most`, the mirror of a partial sum's `+?`.
 */
export function renderCostRemaining(usd: number, spend: { estimated: boolean; unpriced: boolean }): string {
	const amount = spend.estimated ? `~${renderUsd(usd)} est` : renderUsd(usd);
	return spend.unpriced ? `at most ${amount}` : amount;
}

const plural = (count: number, noun: string) => `${renderCount(count)} ${noun}${count === 1 ? "" : "s"}`;

/** Contributions that carry a value or a gap; an absent contribution (a never-sent call) is neither. */
function contributions(sum: FactSum): number {
	return sum.coverage.measured + sum.coverage.estimated + sum.unknownCount;
}

/** Only absent contributions, such as a lone never-sent call: not applicable, never zero (L9). */
const allAbsent = (sum: FactSum) => contributions(sum) === 0 && sum.absentCount > 0;

/**
 * A folded token or count sum. A partial sum is never shown as a total (L3): it reads `≥` with the number of
 * contributions whose value is unknown. Estimated parts mark the whole with `~` (L5).
 */
export function renderCountSum(sum: FactSum, unit = "call"): string {
	if (allAbsent(sum)) return renderAbsent("not-applicable");
	const known = sum.measured + sum.estimated;
	const approx = sum.coverage.estimated > 0 ? "~" : "";
	if (sum.unknownCount === 0) return `${approx}${renderCount(known)}`;
	const gap = `${plural(sum.unknownCount, unit)} unknown`;
	if (sum.coverage.measured + sum.coverage.estimated === 0) return `unknown (${gap})`;
	return `≥${approx}${renderCount(known)} (${gap})`;
}

/**
 * A count or count sum in the footer's narrow form (`12.3k`). The width changes, the honesty does not: an estimate
 * keeps `~`, a partial sum keeps `≥` and `+?`, an unknown is `?` and never `0`, and an absent count is `n/a` (R1, R10).
 */
export function renderCompactCount(fact: Fact<number> | FactSum): string {
	if ("kind" in fact) {
		switch (fact.kind) {
			case "measured":
				return formatFooterTokens(fact.value);
			case "estimated":
				return `~${formatFooterTokens(fact.value)}`;
			case "unknown":
				return "?";
			case "absent":
				return "n/a";
		}
	}
	if (allAbsent(fact)) return "n/a";
	const known = `${fact.coverage.estimated > 0 ? "~" : ""}${formatFooterTokens(fact.measured + fact.estimated)}`;
	if (fact.unknownCount === 0) return known;
	return fact.coverage.measured + fact.coverage.estimated === 0 ? "?" : `≥${known} +?`;
}

/** A folded USD sum; `free` is true when every priced call was a free target's measured zero. */
export function renderUsdSum(sum: FactSum, free: boolean): string {
	if (allAbsent(sum)) return renderAbsent("not-applicable");
	if (contributions(sum) === 0) return COST_NOT_MEASURED;
	return renderUsdParts(sum.measured + sum.estimated, {
		estimated: sum.coverage.estimated > 0,
		unpriced: sum.unknownCount > 0,
		free,
	});
}

/** A folded duration sum (total admission wait, total model time); partial sums are lower bounds. */
export function renderDurationSum(sum: FactSum, unit = "call"): string {
	const known = sum.measured + sum.estimated;
	if (allAbsent(sum)) return renderAbsent("not-applicable");
	if (contributions(sum) === 0) return "none";
	if (sum.unknownCount === 0) return `${sum.coverage.estimated > 0 ? "~" : ""}${renderDurationMs(known)}`;
	if (sum.coverage.measured + sum.coverage.estimated === 0) return `unknown (${plural(sum.unknownCount, unit)} unknown)`;
	return `≥${renderDurationMs(known)} (${plural(sum.unknownCount, unit)} unknown)`;
}

type Scalar = "count" | "usd" | "duration" | "percent";

function renderScalar(value: number, as: Scalar): string {
	switch (as) {
		case "usd":
			return renderUsd(value);
		case "duration":
			return renderDurationMs(value);
		case "percent":
			return `${value.toFixed(1)}%`;
		default:
			return renderCount(value);
	}
}

/** One fact. Estimates name their method (R3); unknown and absent keep their reason (R1, R10). */
export function renderFact(fact: Fact<number>, as: Scalar = "count"): string {
	switch (fact.kind) {
		case "measured":
			return renderScalar(fact.value, as);
		case "estimated":
			return `~${renderScalar(fact.value, as)} (${fact.method})`;
		case "unknown":
			return renderUnknown(fact.reason);
		case "absent":
			return renderAbsent(fact.reason);
	}
}

/** A priced fact. `pricedBy: free` is a measured local zero, not a provider's `$0.00`. */
export function renderUsdFact(fact: Fact<number>, pricedBy: string): string {
	if (fact.kind === "measured" && pricedBy === "free") return "$0.00 local";
	if (fact.kind === "estimated") return `~${renderUsd(fact.value)} est`;
	if (fact.kind === "unknown") return COST_NOT_MEASURED;
	return renderFact(fact, "usd");
}

/**
 * One count as a `key=value` field: no spaces and no grouping, so a line stays machine-splittable. An estimate keeps
 * `~`, and an unknown or absent count says so rather than reading as `0` (R1, R10).
 */
export function renderFactField(fact: Fact<number>): string {
	switch (fact.kind) {
		case "measured":
			return String(fact.value);
		case "estimated":
			return `~${fact.value}`;
		case "unknown":
			return "unknown";
		case "absent":
			return "n/a";
	}
}

/** One priced amount, as a cost field renders it. */
export function renderPricing(pricing: Pricing): string {
	return renderUsdFact(pricing.usd, pricing.pricedBy);
}

/** Several priced amounts folded; `+?` and `~` mark the unpriced and estimated parts as on any sum. */
export function renderPricingSum(sum: PricingSum): string {
	return renderUsdSum(sum.usd, sum.free);
}

export function renderTextFact(fact: Fact<string | boolean | null>): string {
	switch (fact.kind) {
		case "measured":
			return fact.value === null ? "none" : String(fact.value);
		case "estimated":
			return `~${fact.value === null ? "none" : String(fact.value)} (${fact.method})`;
		case "unknown":
			return renderUnknown(fact.reason);
		case "absent":
			return renderAbsent(fact.reason);
	}
}

/**
 * Where a value came from, by fact kind, for an explanation (#434 §11.4). A single fact names its source, method or
 * reason; a fold result counts its contributions per kind, so `≥` on a sum always has its unknown part named here.
 */
export function renderCoverage(fact: Fact<number> | FactSum): string {
	if ("kind" in fact) {
		switch (fact.kind) {
			case "measured":
				return `measured (${fact.source})`;
			case "estimated":
				return `estimated (${fact.method})`;
			case "unknown":
				return renderUnknown(fact.reason);
			case "absent":
				return renderAbsent(fact.reason);
		}
	}
	const parts = [
		[fact.coverage.measured, "measured"],
		[fact.coverage.estimated, "estimated"],
		[fact.unknownCount, "unknown"],
		[fact.absentCount, "not applicable"],
	] as const;
	const total = fact.coverage.measured + fact.coverage.estimated + fact.unknownCount + fact.absentCount;
	if (total === 0) return "no contributions";
	return `${plural(total, "contribution")}: ${parts
		.filter(([value]) => value > 0)
		.map(([value, label]) => `${renderCount(value)} ${label}`)
		.join(", ")}`;
}
