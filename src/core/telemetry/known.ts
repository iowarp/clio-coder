import type { Fact, FactSum } from "./fact.js";

/** The known contribution; unknown and absent facts contribute nothing, without asserting a measured zero (#434). */
export function factKnownValue(fact: Fact<number> | FactSum): number {
	if ("kind" in fact) return fact.kind === "measured" || fact.kind === "estimated" ? fact.value : 0;
	return fact.measured + fact.estimated;
}

/**
 * A USD sum as one JSON amount: the known subtotal while any contribution carries a value, else the unknown fact (or
 * absent, when every contribution was absent). An unpriced sum is never written as a measured 0 (#434).
 */
export function usdAmountOrFact(
	sum: FactSum,
): number | Extract<Fact<number>, { kind: "unknown" }> | Extract<Fact<number>, { kind: "absent" }> {
	if (sum.coverage.measured + sum.coverage.estimated > 0) return sum.measured + sum.estimated;
	if (sum.unknownCount === 0 && sum.absentCount > 0) return { kind: "absent", reason: "not-applicable" };
	return { kind: "unknown", reason: "not-observed" };
}
