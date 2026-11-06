/**
 * One way to say measured versus unknown usage on every surface that shows a sum of calls (F4, WO06).
 *
 * The read model's display carries its coverage clause on every figure (`≥999 (3 calls unknown)`), so a line of five
 * figures said the same gap five times and the honest unknown became noise. Here a figure keeps only its `≥` mark,
 * a figure nothing reported reads `not measured`, and the line states its coverage once, as its last unit:
 * `3 calls had no usage data`.
 */

import type { AgentRole } from "../core/telemetry/enums.js";
import type { Fact, FactSum } from "../core/telemetry/fact.js";
import { factKnownValue } from "../core/telemetry/known.js";
import { renderCountSum, renderUsdSum } from "../core/telemetry/render.js";
import {
	countVerifiedOutcomes,
	perVerifiedOutcome,
	runHostVerified,
	type VerifiedOutcomeCount,
} from "../domains/evidence/verified-outcomes.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import { expandChainMessages } from "../tools/surface.js";

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

/** `1 call still running`: a call that has not settled yet, so its figures are still to come. */
export function usageStillRunning(running: number): string {
	return `${count(running)} ${running === 1 ? "call" : "calls"} still running`;
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
	running = 0,
): string | null {
	// A call still out has not reported yet, which is not the same as a call that never will.
	const gaps = figures.map((entry) => ({ label: entry.label, gap: Math.max(0, usageGap(entry.quantity) - running) }));
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

/** `cache read, cache write or reasoning`. */
function listWords(words: ReadonlyArray<string>): string {
	return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

/**
 * What a line of token figures leaves out, said once: the kinds no call reported (`no cache read or reasoning data`),
 * then the calls that reported nothing. The first two figures are the amounts every surface shows; the rest are said
 * only when they have something to say. The exit card and /usage read their notes here, so a session's gaps read the
 * same on both (U1, U5).
 */
export function usageLineNotes(
	figures: ReadonlyArray<{ label: string; quantity: UsageQuantity | null | undefined }>,
	running = 0,
): {
	shown: ReadonlyArray<{ label: string; quantity: UsageQuantity | null | undefined }>;
	notes: string[];
} {
	const [input, output, ...optional] = figures;
	const unmeasured = optional.filter((entry) => usageUnmeasured(entry.quantity)).map((entry) => entry.label);
	const shown = optional.filter((entry) => {
		const figure = usageLineFigure(entry.quantity);
		return figure !== "0" && !usageSaysNothing(figure);
	});
	const coverage = usageLineCoverage(
		[input, output, ...shown].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
		"usage data",
		running,
	);
	return {
		shown,
		notes: [
			...(unmeasured.length > 0 ? [`no ${listWords(unmeasured)} data`] : []),
			...(coverage !== null ? [coverage] : []),
			...(running > 0 ? [usageStillRunning(running)] : []),
		],
	};
}

/** Calls that reached the provider or may have; a never-sent attempt asked the model nothing. */
export const SENT_DISPOSITIONS = ["sent_unsettled", "settled_no_usage", "settled", "incomplete"] as const;

/**
 * Model calls that went out, counted once per call across its attempts. `/usage` counted the memory guardian's skipped
 * steps as model calls (20) beside an exit card that counted the 11 that were sent; both count this now.
 *
 * A worker run's calls live in its own journal, not among the session's attempts, so they are counted from the run's
 * fold, whose call count is the requests that reached the provider. The Session tab read `worker calls 0 sent · 13
 * more never sent` after workers that ran 13 real rounds, because only the session's own attempts were listed here.
 */
export function sentCallCount(view: TelemetryView, filter: { roles?: AgentRole[]; from?: string } = {}): number {
	try {
		const calls = view.calls({ ...filter, dispositions: [...SENT_DISPOSITIONS] }).calls;
		const own = new Set(calls.map((call) => call.callId)).size;
		if (filter.roles !== undefined && !filter.roles.includes("worker")) return own;
		const runs = view
			.runs()
			.filter((run) => filter.from === undefined || run.firstAt === null || run.firstAt >= filter.from);
		return own + runs.reduce((sum, run) => sum + factKnownValue(run.apiCalls.fact), 0);
	} catch {
		// A read model that cannot list calls has no sent count to give; the caller shows its own total instead.
		return Number.NaN;
	}
}

/** A single fact as the one-contribution sum it is, so a share of it renders through the sum renderers. */
function asSum(fact: Fact<number> | FactSum): FactSum {
	if (isSum(fact)) return fact;
	const value = fact.kind === "measured" || fact.kind === "estimated" ? fact.value : 0;
	return {
		measured: fact.kind === "measured" ? value : 0,
		estimated: fact.kind === "estimated" ? value : 0,
		unknownCount: fact.kind === "unknown" ? 1 : 0,
		absentCount: fact.kind === "absent" ? 1 : 0,
		coverage: {
			measured: fact.kind === "measured" ? 1 : 0,
			estimated: fact.kind === "estimated" ? 1 : 0,
			unknown: fact.kind === "unknown" ? 1 : 0,
		},
	};
}

/** What a session's verified outcomes cost, in the words `/usage` and the exit card share. */
export type VerifiedOutcomeWords =
	| { kind: "none"; words: string }
	| {
			kind: "counted";
			/** `3`. */
			count: string;
			/** `2 reproduce or numeric-compare passes`, `1 worker run host-verified`, `1 task done with a passing check`. */
			parts: string[];
			/** Session tokens over the outcomes: `4,115`, `≥4,115`, or `not measured`. */
			tokens: string;
			/** Session cost over the outcomes: `$0.0041`, `~$0.0041 est`, `$0.00 local`, or `not measured`. */
			cost: string;
	  };

/**
 * The session's verified outcomes from its whole ledger and the worker runs its telemetry references. A run's record
 * is read and its seal checked here, so a caller reads this once per render, not per row.
 */
export function sessionVerifiedOutcomes(view: TelemetryView, entries: ReadonlyArray<unknown>): VerifiedOutcomeCount {
	const verified = new Set<string>();
	try {
		for (const row of view.runs()) if (runHostVerified(view.run(row.runId))) verified.add(row.runId);
	} catch {
		// A read model that cannot list runs leaves the runs out; the ledger's own outcomes still count.
	}
	return countVerifiedOutcomes(expandChainMessages(entries), verified);
}

export const NO_VERIFIED_OUTCOME = "none this session, so no per-outcome figure";

/**
 * The session's tokens and cost per verified outcome. The shares divide the read model's own session totals and are
 * drawn by the canonical renderers, so an unpriced route reads `not measured` and a partial total keeps its `≥` or
 * `+?`. With no outcome there is nothing to divide by, and the words say so.
 */
export function verifiedOutcomeWords(view: TelemetryView, outcomes: VerifiedOutcomeCount): VerifiedOutcomeWords {
	if (outcomes.total <= 0) return { kind: "none", words: NO_VERIFIED_OUTCOME };
	const totals = view.session().totals;
	const tokenShare = perVerifiedOutcome(asSum(totals.tokens.fact), outcomes.total);
	const tokens = usageLineFigure({ fact: tokenShare, display: renderCountSum(tokenShare) });
	const priced = view.cost("role").total.pricedBy;
	// A spend every call of which was free reads the same per outcome; its display names the free rule.
	const free = priced.free > 0 && priced.provider + priced["target-rates"] + priced.catalog + priced.none === 0;
	const costShare = perVerifiedOutcome(asSum(totals.usd.fact), outcomes.total);
	const cost = free ? totals.usd.display : renderUsdSum(costShare, false);
	const plural = (n: number, one: string, many: string): string => `${count(n)} ${n === 1 ? one : many}`;
	return {
		kind: "counted",
		count: count(outcomes.total),
		parts: [
			...(outcomes.checks > 0
				? [plural(outcomes.checks, "reproduce or numeric-compare pass", "reproduce or numeric-compare passes")]
				: []),
			...(outcomes.workers > 0 ? [plural(outcomes.workers, "worker run host-verified", "worker runs host-verified")] : []),
			...(outcomes.tasks > 0
				? [plural(outcomes.tasks, "task done with a passing check", "tasks done with a passing check")]
				: []),
		],
		tokens: usageSaysNothing(tokens) ? USAGE_NOT_MEASURED : tokens,
		cost,
	};
}
