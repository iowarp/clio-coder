/**
 * One way to say measured versus unknown usage on every surface that shows a sum of calls (F4, WO06).
 *
 * The read model's display carries its coverage clause on every figure (`≥999 (3 calls unknown)`), so a line of five
 * figures said the same gap five times and the honest unknown became noise. Here a figure keeps only its `≥` mark,
 * a figure nothing reported reads `not measured`, and the line states its coverage once, as its last unit:
 * `3 calls had no usage data`.
 */

import type { Fact, FactSum } from "../core/telemetry/fact.js";

export const USAGE_NOT_MEASURED = "not measured";

/** The read-model quantity shape: a fact or a sum of facts, and its canonical display. */
export interface UsageQuantity {
	fact: Fact<number> | FactSum;
	display: string;
}

const count = (value: number): string => value.toLocaleString("en-US");

function isSum(fact: Fact<number> | FactSum): fact is FactSum {
	return !("kind" in fact);
}

/** Calls the quantity had no figure from: a sum's unknown contributions, or one for a single unknown fact. */
export function usageGap(quantity: UsageQuantity | null | undefined): number {
	if (!quantity) return 0;
	const fact = quantity.fact;
	return isSum(fact) ? fact.unknownCount : fact.kind === "unknown" ? 1 : 0;
}

/** Calls that fed the quantity at all, measured, estimated or not. */
function usageCalls(quantity: UsageQuantity | null | undefined): number {
	if (!quantity) return 0;
	const fact = quantity.fact;
	return isSum(fact)
		? fact.coverage.measured + fact.coverage.estimated + fact.unknownCount
		: fact.kind === "absent"
			? 0
			: 1;
}

/** Whether nothing behind the quantity reported a figure, so no lower bound exists to show. */
export function usageUnmeasured(quantity: UsageQuantity | null | undefined): boolean {
	if (!quantity) return true;
	const fact = quantity.fact;
	if (!isSum(fact)) return fact.kind === "unknown";
	return fact.unknownCount > 0 && fact.coverage.measured + fact.coverage.estimated === 0;
}

/** A display without its coverage clause, for callers holding only the read model's string. */
export function stripUsageClause(display: string): string {
	const figure = display.replace(/ \([^()]*\bunknown\)$/u, "");
	return /^unknown\b/u.test(figure) ? USAGE_NOT_MEASURED : figure;
}

/** The figure alone: `≥999` keeps saying it is a lower bound, and a figure nothing reported is `not measured`. */
export function usageFigure(quantity: UsageQuantity | null | undefined): string {
	if (!quantity || usageUnmeasured(quantity)) return USAGE_NOT_MEASURED;
	return stripUsageClause(quantity.display);
}

/**
 * The figure with one mark at most, for a line that states its gaps and estimates once in words: `≥999` still says it
 * is a lower bound, while `≥~999` stacked a second qualifier on every number of the line (E1). The estimate moves to
 * `usageEstimates`, which says it once for the whole line.
 */
export function usageLineFigure(quantity: UsageQuantity | null | undefined): string {
	const figure = usageFigure(quantity);
	if (figure === USAGE_NOT_MEASURED) return figure;
	// A single estimated fact's display names its method in parentheses; the line's estimate clause says it instead.
	return figure.replace(/^(≥?)~/u, "$1").replace(/ \([^()]*\)$/u, "");
}

/** Calls whose figure Clio estimated because the provider did not report one. */
export function usageEstimatedCalls(quantity: UsageQuantity | null | undefined): number {
	if (!quantity) return 0;
	const fact = quantity.fact;
	return isSum(fact) ? fact.coverage.estimated : fact.kind === "estimated" ? 1 : 0;
}

/** `Clio estimated usage for 3 calls`, or null when no figure was estimated. Pairs with `usageLineFigure`. */
export function usageEstimates(calls: number, data = "usage"): string | null {
	if (calls <= 0) return null;
	return `Clio estimated ${data} for ${count(calls)} ${calls === 1 ? "call" : "calls"}`;
}

/** A figure that says nothing a reader can use: unmeasured, or a lower bound of zero. */
export function usageSaysNothing(figure: string): boolean {
	return figure === USAGE_NOT_MEASURED || figure === "≥0" || figure === "≥~0";
}

/** `3 calls had no usage data`, or null when every call reported. The noun names what was missing. */
export function usageCoverage(gap: number, data = "usage data"): string | null {
	if (gap <= 0) return null;
	return `${count(gap)} ${gap === 1 ? "call" : "calls"} had no ${data}`;
}

/**
 * The coverage unit for a line of figures: the gap most of them share, then any figure that missed more calls named
 * once after it, so a cache figure most providers never send does not pass for complete beside a small usage gap.
 */
export function usageLineCoverage(
	figures: ReadonlyArray<{ label: string; quantity: UsageQuantity | null | undefined }>,
	data = "usage data",
): string | null {
	const gaps = figures.map((entry) => ({ label: entry.label, gap: usageGap(entry.quantity) }));
	const base = gaps[0]?.gap ?? 0;
	const wider = gaps.filter((entry) => entry.gap > base && !usageUnmeasured(figureOf(figures, entry.label)));
	const lead = usageCoverage(base, data);
	// `4 no out` read as a stray fragment beside the lead clause; the extra gap is a sentence of its own words.
	const extra = wider.map((entry) => `${count(entry.gap)} had no ${entry.label} figure`);
	if (lead === null && extra.length === 0) return null;
	if (lead === null)
		return wider
			.map((entry) => `${count(entry.gap)} ${entry.gap === 1 ? "call" : "calls"} had no ${entry.label} figure`)
			.join(", ");
	return extra.length > 0 ? `${lead}, ${extra.join(", ")}` : lead;
}

function figureOf(
	figures: ReadonlyArray<{ label: string; quantity: UsageQuantity | null | undefined }>,
	label: string,
): UsageQuantity | null | undefined {
	return figures.find((entry) => entry.label === label)?.quantity;
}

/**
 * The sentence that replaces `46 contributions: 23 measured, 23 unknown`: what the gap is in calls, and what it does to
 * the totals beside it. Null when every call reported.
 */
export function usageCoverageSentence(quantity: UsageQuantity | null | undefined): string | null {
	const gap = usageGap(quantity);
	if (gap <= 0) return null;
	const calls = usageCalls(quantity);
	const share =
		calls > gap ? `${count(gap)} of ${count(calls)} calls` : gap === 1 ? "1 call" : `all ${count(gap)} calls`;
	return calls > gap
		? `${share} had no usage data, so totals marked ≥ leave them out`
		: `${share} had no usage data, so no total is measured`;
}
