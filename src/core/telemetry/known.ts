import type { Fact, FactSum } from "./fact.js";

/** The known contribution; unknown and absent facts contribute nothing, without asserting a measured zero (#434). */
export function factKnownValue(fact: Fact<number> | FactSum): number {
	if ("kind" in fact) return fact.kind === "measured" || fact.kind === "estimated" ? fact.value : 0;
	return fact.measured + fact.estimated;
}
