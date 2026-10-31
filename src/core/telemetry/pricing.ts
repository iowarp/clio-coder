import type { Fact, FactSum } from "./fact.js";
import type { PricedBy, Pricing, RunUsageFacts } from "./schemas.js";

export type { PricedBy, Pricing };

const notObserved: Fact<number> = { kind: "unknown", reason: "not-observed" };

/**
 * A USD amount as the Pricing it carries (#434). A provider's own cost and declared target rates are measured, a free
 * target is a measured local zero, a catalog rate is a guess at someone else's price list and stays estimated, and
 * an amount nobody priced is unknown, never zero.
 */
export function pricedUsd(pricedBy: PricedBy, usd: number | null): Pricing {
	if (pricedBy === "free") return { usd: { kind: "measured", value: 0, source: "local-count" }, pricedBy };
	if (pricedBy === "none" || usd === null || !Number.isFinite(usd) || usd < 0)
		return { usd: notObserved, pricedBy: "none" };
	if (pricedBy === "catalog") return { usd: { kind: "estimated", value: usd, method: "catalog" }, pricedBy };
	return {
		usd: { kind: "measured", value: usd, source: pricedBy === "provider" ? "provider" : "local-count" },
		pricedBy,
	};
}

/** True when a target's rates put a number on a call, so its spend can be projected before it runs. */
export function pricesCalls(pricedBy: PricedBy): boolean {
	return pricedBy === "target-rates" || pricedBy === "catalog" || pricedBy === "provider";
}

/** Each fact one contribution; unknown and absent facts are counted, never summed as zero (#434). */
export function sumFacts(facts: Iterable<Fact<number>>): FactSum {
	const sum: FactSum = {
		measured: 0,
		estimated: 0,
		unknownCount: 0,
		absentCount: 0,
		coverage: { measured: 0, estimated: 0, unknown: 0 },
	};
	for (const fact of facts) {
		if (fact.kind === "measured") {
			sum.measured += fact.value;
			sum.coverage.measured += 1;
		} else if (fact.kind === "estimated") {
			sum.estimated += fact.value;
			sum.coverage.estimated += 1;
		} else if (fact.kind === "unknown") {
			sum.unknownCount += 1;
			sum.coverage.unknown += 1;
		} else sum.absentCount += 1;
	}
	return sum;
}

/** Several priced amounts as one sum; `free` holds only when every amount was a free target's measured zero. */
export interface PricingSum {
	usd: FactSum;
	free: boolean;
}

export function sumPricing(pricings: Iterable<Pricing>): PricingSum {
	const list = [...pricings];
	return {
		usd: sumFacts(list.map((pricing) => pricing.usd)),
		free: list.length > 0 && list.every((pricing) => pricing.pricedBy === "free"),
	};
}

/** A run with no call telemetry: every quantity unknown, never zero (R1, #434). */
export function unobservedRunUsageFacts(): RunUsageFacts {
	return {
		usage: {
			input: notObserved,
			cacheRead: notObserved,
			cacheWrite: notObserved,
			cacheWrite1h: notObserved,
			output: notObserved,
			reasoning: notObserved,
		},
		totalTokens: notObserved,
		apiCalls: notObserved,
		pricing: { usd: notObserved, pricedBy: "none" },
	};
}

/** A run Clio settled without a model call, such as a host-authored synthesis: no call to count or price (#434). */
export function noCallRunUsageFacts(): RunUsageFacts {
	const notApplicable: Fact<number> = { kind: "absent", reason: "not-applicable" };
	return {
		usage: {
			input: notApplicable,
			cacheRead: notApplicable,
			cacheWrite: notApplicable,
			cacheWrite1h: notApplicable,
			output: notApplicable,
			reasoning: notApplicable,
		},
		totalTokens: notApplicable,
		apiCalls: { kind: "measured", value: 0, source: "local-count" },
		pricing: { usd: notApplicable, pricedBy: "none" },
	};
}
