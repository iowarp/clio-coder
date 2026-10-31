/**
 * Cost amounts and their aggregation and rendering. Session spend itself is the telemetry read model's fold over the
 * journals; nothing here accumulates it (#434).
 */

import {
	COST_NOT_MEASURED,
	costClaimMeasured,
	renderCostClaim,
	renderCredit,
	renderUsdLimit as renderLimit,
} from "../../core/telemetry/render.js";
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
	return cost !== null && cost !== undefined && costClaimMeasured(cost);
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
			(amount.costSummary === undefined && (amount.missingTokenCalls ?? 0) > 0 && amount.provenance !== "known_free"),
		allKnownFree:
			(amount.costSummary?.allKnownFree ?? amount.provenance === "known_free") && (first || aggregate.allKnownFree),
		// Carried summaries retain their call coverage along with their USD and flags (#434).
		calls: aggregate.calls + (amount.costSummary?.calls ?? amount.apiCalls ?? 1),
	};
}

export function aggregateCostAmounts(amounts: ReadonlyArray<CostAmount>): CostAggregate {
	return amounts.reduce((aggregate, amount) => accumulateCostAmount(aggregate, amount), emptyCostAggregate());
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
	// The wording itself lives in the canonical telemetry renderer (#434, R5).
	return renderCostClaim(cost);
}

/**
 * What a fixed-width surface says when there is no cost claim. The footer and
 * `/usage` drop their cost field instead; a table cell that owns a column cannot,
 * so it says the same thing in words rather than inventing `$0.00`.
 */
export { COST_NOT_MEASURED };

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

/**
 * A configured limit or a computed upper bound (a session ceiling, a run cap, a
 * route's cost bound). It is a figure someone set or derived, not spend, so it
 * renders plainly and a zero limit reads as `$0.00` (#434).
 */
export function renderUsdLimit(value: number | null | undefined): string {
	return renderLimit(value);
}

/** Provider credit limits are measured balances; they can be denominated outside USD. */
export function renderCreditAmount(value: number, currency: string): string {
	return currency.toUpperCase() === "USD" ? renderCostAmount(value, "known") : renderCredit(value, currency);
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
	| "helper"
	| "side-question"
	| "handoff"
	| "prewarm"
	| "background-memory"
	| "failed-compaction"
	| "system-one"
	| "safety-judge"
	| "worker"
	| "compaction";
