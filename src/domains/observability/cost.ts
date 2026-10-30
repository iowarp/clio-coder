/**
 * Running USD cost accumulator. The catalog-backed auto-pricing fallback was
 * dropped in the provider redesign; pricing now flows from the providers
 * domain's TargetPricing + knowledge-base entries and the caller supplies
 * the resolved `usd` per call. Unknown or unpriced calls accumulate zero so
 * they never blow up the tally.
 *
 * Per-entry token breakdown (input/output/cacheRead/cacheWrite/reasoning)
 * matches the shape of pi-ai's `Usage` plus provider-specific reasoning detail
 * fields. The /usage overlay aggregates it via `aggregateCostEntries`; the TUI
 * footer reads the session sum from the observability snapshot's
 * `session.tokens`, which carries the full breakdown although the footer shows
 * only input, output and the total.
 */

import type { ResponseModelIdObservationCounts } from "../../core/response-model-id.js";
import { type CostProvenance, normalizeCostProvenance } from "../providers/index.js";

export interface CostAmount {
	unknownCallCoverageRuns?: number;
	costSummary?: CostAggregate;
	usd: number;
	provenance: CostProvenance;
	apiCalls?: number;
	missingTokenCalls?: number;
}

export interface CostAggregate {
	/** Runs whose receipts omitted API-call or missing-usage counts (#434). */
	unknownCallCoverageRuns?: number;
	knownUsd: number;
	hasEstimated: boolean;
	hasUnknown: boolean;
	allKnownFree: boolean;
	/**
	 * How many priced calls this aggregate folded.
	 *
	 * Zero and "measured zero" are different claims and the flags above cannot
	 * tell them apart: a session that has not made a call and a session whose one
	 * call was genuinely free both reduce to `knownUsd: 0` with every flag false.
	 * The footer rendered the first as `$0.00`, a number nothing had measured,
	 * while `/cost` on the same session said no usage was recorded. Callers ask
	 * {@link costWasMeasured} rather than reading this directly.
	 */
	calls: number;
}

export function emptyCostAggregate(): CostAggregate {
	return { knownUsd: 0, hasEstimated: false, hasUnknown: false, allKnownFree: false, calls: 0 };
}

/** False when nothing has been priced yet, so no cost claim of any kind is available. */
export function costWasMeasured(cost: CostAggregate | null | undefined): cost is CostAggregate {
	return cost !== null && cost !== undefined && (cost.calls > 0 || (cost.unknownCallCoverageRuns ?? 0) > 0);
}

/** Receipt totals never reveal how many calls ran or went unmetered (#434). */
export function callCoverageForRun(run: { apiCalls?: unknown; missingTokenCalls?: unknown }) {
	const count = (value: unknown): number | null =>
		typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
	const apiCalls = count(run.apiCalls);
	const missingTokenCalls = count(run.missingTokenCalls);
	return {
		apiCalls: apiCalls ?? 0,
		missingTokenCalls: missingTokenCalls ?? 0,
		unknownCallCoverageRuns: apiCalls === null || missingTokenCalls === null ? 1 : 0,
	};
}

export function accumulateCostAmount(aggregate: CostAggregate, amount: CostAmount): CostAggregate {
	const first = !costWasMeasured(aggregate);
	const unknownCallCoverageRuns =
		(aggregate.unknownCallCoverageRuns ?? 0) +
		(amount.unknownCallCoverageRuns ?? amount.costSummary?.unknownCallCoverageRuns ?? 0);
	return {
		...(unknownCallCoverageRuns > 0 ? { unknownCallCoverageRuns } : {}),
		knownUsd: aggregate.knownUsd + (amount.costSummary?.knownUsd ?? (amount.provenance === "unknown" ? 0 : amount.usd)),
		hasEstimated: aggregate.hasEstimated || (amount.costSummary?.hasEstimated ?? amount.provenance === "estimated"),
		hasUnknown:
			aggregate.hasUnknown ||
			(amount.costSummary?.hasUnknown ?? amount.provenance === "unknown") ||
			((amount.missingTokenCalls ?? 0) > 0 && amount.provenance !== "known_free"),
		allKnownFree:
			(amount.costSummary?.allKnownFree ?? amount.provenance === "known_free") && (first || aggregate.allKnownFree),
		// Carried summaries retain their call coverage along with their USD and flags (#434).
		calls: aggregate.calls + (amount.costSummary?.calls ?? amount.apiCalls ?? 1),
	};
}

export function aggregateCostAmounts(amounts: ReadonlyArray<CostAmount>): CostAggregate {
	return amounts.reduce((aggregate, amount) => accumulateCostAmount(aggregate, amount), emptyCostAggregate());
}

function formatUsdAmount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0.00";
	if (value < 0.00000001) return `$${value.toExponential(2)}`;
	const digits = value < 0.01 ? Math.min(8, Math.max(4, Math.ceil(-Math.log10(value)))) : 2;
	return `$${value.toFixed(digits)}`;
}

/**
 * The one derivation every cost surface renders. Null means there is no cost
 * claim to make, and a null must be shown as the absence of a cost field rather
 * than as any number: `$0.00` before the first call was a measurement that had
 * not happened, and it sat beside a `/cost` overlay saying no usage was recorded.
 *
 * Two different situations reduce to null. Nothing priced yet is one. A target
 * that reports no pricing at all is the other: those calls were made and their
 * tokens were measured, but nobody put a number on them, so the honest cost
 * field is no field. The words `cost unknown` were themselves a claim, and they
 * rendered beside a Σ total that was real, which read as if the tokens were in
 * doubt too. Usage always shows; cost shows when something priced it.
 */
export function formatCostAggregate(cost: CostAggregate | null | undefined): string | null {
	if (!costWasMeasured(cost)) return null;
	if (cost.allKnownFree) return "$0.00 local";
	// Partly priced still says what it knows, with the `+?` marking the rest.
	if (cost.hasUnknown)
		return cost.knownUsd > 0 ? `${cost.hasEstimated ? "~" : ""}${formatUsdAmount(cost.knownUsd)} +?` : null;
	if (cost.hasEstimated) return `~${formatUsdAmount(cost.knownUsd)} est`;
	return formatUsdAmount(cost.knownUsd);
}

/**
 * What a fixed-width surface says when there is no cost claim. The footer and
 * `/usage` drop their cost field instead; a table cell that owns a column cannot,
 * so it says the same thing in words rather than inventing `$0.00`.
 */
export const COST_NOT_MEASURED = "not measured";

export function costAggregateForAmount(
	usd: number,
	provenance: CostProvenance | undefined,
	costSummary?: CostAggregate,
): CostAggregate {
	return costSummary ?? aggregateCostAmounts([{ usd, provenance: normalizeCostProvenance(provenance) }]);
}

/**
 * What a fixed-width surface renders for an already-folded aggregate: the cost
 * claim when one exists, {@link COST_NOT_MEASURED} when none does. Named here
 * because the fallback is part of the derivation, not a caller's choice, and a
 * surface that spells the `?? COST_NOT_MEASURED` out by hand is one edit away
 * from spelling `$0.00` instead.
 */
export function renderCostAggregate(cost: CostAggregate | null | undefined): string {
	return formatCostAggregate(cost) ?? COST_NOT_MEASURED;
}

/**
 * The same render for a single sealed amount, which is the shape a receipt or a
 * ledger row hands over. A caller that reaches for `usd.toFixed(4)` here drops
 * the provenance on the floor and turns unpriced work into a measured `$0.0000`,
 * which is a claim nobody made.
 */
export function renderCostAmount(
	usd: number,
	provenance: CostProvenance | undefined,
	costSummary?: CostAggregate,
): string {
	return renderCostAggregate(costAggregateForAmount(usd, provenance, costSummary));
}

/** Trace rows predating pricing flags cannot establish a priced amount (#434). */
export function renderTraceCost(row: {
	total_cost_usd: number | null;
	cost_estimated?: number | null;
	cost_unknown?: number | null;
	api_calls?: number | null;
}): string {
	if (row.total_cost_usd === null || (row.cost_estimated == null && row.cost_unknown == null))
		return renderCostAggregate(null);
	return renderCostAggregate({
		knownUsd: row.total_cost_usd,
		hasEstimated: row.cost_estimated === 1,
		hasUnknown: row.cost_unknown === 1,
		allKnownFree: false,
		calls: row.api_calls ?? 0,
		...(row.api_calls == null ? { unknownCallCoverageRuns: 1 } : {}),
	});
}

/** Provider credit limits are measured balances; they can be denominated outside USD. */
export function renderCreditAmount(value: number, currency: string): string {
	if (currency.toUpperCase() === "USD") return renderCostAmount(value, "known");
	return `${value.toFixed(2)} ${currency}`;
}

export interface UsageBreakdown {
	unknownCallCoverageRuns?: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoningTokens: number;
	totalTokens: number;
	apiCalls?: number;
	missingTokenCalls?: number;
	/** Persisted assistant calls that never reached the provider (#430). */
	neverSentCalls?: number;
}

/**
 * What produced a priced call, when it was not an ordinary turn. `/usage` and
 * the usage surfaces separate these out so an operator can see that money was
 * spent beside the session rather than inside it.
 */
export type CostEntryLabel =
	| "side-question"
	| "handoff"
	| "prewarm"
	| "background-memory"
	| "failed-compaction"
	| "system-one"
	| "safety-judge"
	| "worker"
	| "compaction";

export interface CostEntry {
	unknownCallCoverageRuns?: number;
	replayed?: boolean;
	costSummary?: CostAggregate;
	providerId: string;
	attributedModelId: string;
	requestedModelIds: string[];
	responseModelIdObservationCounts: ResponseModelIdObservationCounts;
	tokens: number;
	usd: number;
	provenance: CostProvenance;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoningTokens: number;
	apiCalls?: number;
	missingTokenCalls?: number;
	/** Absent on an ordinary turn's call. */
	label?: CostEntryLabel;
}

export interface CostTracker {
	accumulate(
		providerId: string,
		attributedModelId: string,
		tokens: number,
		usd?: number,
		breakdown?: Partial<UsageBreakdown>,
		provenance?: CostProvenance,
		modelIdFacts?: {
			requestedModelIds: ReadonlyArray<string>;
			responseModelIdObservationCounts: Readonly<ResponseModelIdObservationCounts>;
		},
		label?: CostEntryLabel,
		costSummary?: CostAggregate,
		replayed?: boolean,
	): number;
	sessionTotal(): number;
	sessionCost(): CostAggregate;
	sessionTokens(): UsageBreakdown;
	recordNeverSentCalls(count: number): void;
	entries(): ReadonlyArray<CostEntry>;
	reset(): void;
}

function emptyBreakdown(): UsageBreakdown {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, totalTokens: 0 };
}

export function createCostTracker(): CostTracker {
	const log: CostEntry[] = [];
	let aggregate = emptyCostAggregate();
	const totals = emptyBreakdown();
	return {
		accumulate(
			providerId,
			attributedModelId,
			tokens,
			usd,
			breakdown,
			costProvenance,
			modelIdFacts,
			label,
			costSummary,
			replayed,
		) {
			const resolvedUsd = usd ?? 0;
			const provenance = normalizeCostProvenance(costProvenance);
			const input = breakdown?.input ?? 0;
			const output = breakdown?.output ?? 0;
			const cacheRead = breakdown?.cacheRead ?? 0;
			const cacheWrite = breakdown?.cacheWrite ?? 0;
			const reasoningTokens = breakdown?.reasoningTokens ?? 0;
			const apiCalls = breakdown?.apiCalls;
			const missingTokenCalls = breakdown?.missingTokenCalls ?? 0;
			const unknownCallCoverageRuns = breakdown?.unknownCallCoverageRuns ?? costSummary?.unknownCallCoverageRuns ?? 0;
			log.push({
				...(unknownCallCoverageRuns > 0 ? { unknownCallCoverageRuns } : {}),
				...(replayed ? { replayed } : {}),
				providerId,
				attributedModelId,
				requestedModelIds: [...(modelIdFacts?.requestedModelIds ?? [attributedModelId])],
				responseModelIdObservationCounts: modelIdFacts
					? { ...modelIdFacts.responseModelIdObservationCounts }
					: {
							reportedCalls: 0,
							notReportedCalls: 0,
							notObservedCalls: apiCalls ?? 1,
							legacyDifferenceOnlyCalls: 0,
						},
				tokens,
				usd: resolvedUsd,
				provenance,
				...(costSummary ? { costSummary } : {}),
				input,
				output,
				cacheRead,
				cacheWrite,
				reasoningTokens,
				...(apiCalls !== undefined ? { apiCalls } : {}),
				...(missingTokenCalls > 0 ? { missingTokenCalls } : {}),
				...(label !== undefined ? { label } : {}),
			});
			aggregate = accumulateCostAmount(aggregate, {
				usd: resolvedUsd,
				provenance,
				apiCalls: apiCalls ?? 1,
				missingTokenCalls,
				unknownCallCoverageRuns,
				...(costSummary ? { costSummary } : {}),
			});
			totals.input += input;
			totals.output += output;
			totals.cacheRead += cacheRead;
			totals.cacheWrite += cacheWrite;
			if (breakdown?.cacheWrite1h !== undefined) totals.cacheWrite1h = (totals.cacheWrite1h ?? 0) + breakdown.cacheWrite1h;
			totals.reasoningTokens += reasoningTokens;
			totals.totalTokens += tokens;
			totals.apiCalls = (totals.apiCalls ?? 0) + (apiCalls ?? 1);
			if (unknownCallCoverageRuns > 0)
				totals.unknownCallCoverageRuns = (totals.unknownCallCoverageRuns ?? 0) + unknownCallCoverageRuns;
			if (missingTokenCalls > 0) totals.missingTokenCalls = (totals.missingTokenCalls ?? 0) + missingTokenCalls;
			return resolvedUsd;
		},
		sessionTotal() {
			return aggregate.knownUsd;
		},
		sessionCost() {
			return { ...aggregate };
		},
		sessionTokens() {
			return { ...totals };
		},
		recordNeverSentCalls(count) {
			if (count > 0) totals.neverSentCalls = (totals.neverSentCalls ?? 0) + count;
		},
		entries() {
			return log;
		},
		reset() {
			log.length = 0;
			aggregate = emptyCostAggregate();
			totals.input = 0;
			totals.output = 0;
			totals.cacheRead = 0;
			totals.cacheWrite = 0;
			delete totals.cacheWrite1h;
			totals.reasoningTokens = 0;
			totals.totalTokens = 0;
			delete totals.apiCalls;
			delete totals.missingTokenCalls;
			delete totals.neverSentCalls;
			delete totals.unknownCallCoverageRuns;
		},
	};
}
