/**
 * Running USD cost accumulator. The catalog-backed auto-pricing fallback was
 * dropped in the provider redesign; pricing now flows from the providers
 * domain's TargetPricing + knowledge-base entries and the caller supplies
 * the resolved `usd` per call. Unknown or unpriced calls accumulate zero so
 * they never blow up the tally.
 *
 * Per-entry token breakdown (input/output/cacheRead/cacheWrite/reasoning)
 * matches the shape of pi-ai's `Usage` plus provider-specific reasoning detail
 * fields. The /cost overlay aggregates it via `aggregateCostEntries`; the TUI
 * footer consumes the session sum through `ObservabilityContract.sessionTokens()`.
 */

import { type CostProvenance, normalizeCostProvenance } from "../providers/index.js";

export interface CostAmount {
	usd: number;
	provenance: CostProvenance;
}

export interface CostAggregate {
	knownUsd: number;
	hasEstimated: boolean;
	hasUnknown: boolean;
	allKnownFree: boolean;
}

export function emptyCostAggregate(): CostAggregate {
	return { knownUsd: 0, hasEstimated: false, hasUnknown: false, allKnownFree: false };
}

function accumulateCostAmount(aggregate: CostAggregate, amount: CostAmount, first: boolean): CostAggregate {
	return {
		knownUsd: aggregate.knownUsd + (amount.provenance === "unknown" ? 0 : amount.usd),
		hasEstimated: aggregate.hasEstimated || amount.provenance === "estimated",
		hasUnknown: aggregate.hasUnknown || amount.provenance === "unknown",
		allKnownFree: amount.provenance === "known_free" && (first || aggregate.allKnownFree),
	};
}

export function aggregateCostAmounts(amounts: ReadonlyArray<CostAmount>): CostAggregate {
	return amounts.reduce(
		(aggregate, amount, index) => accumulateCostAmount(aggregate, amount, index === 0),
		emptyCostAggregate(),
	);
}

export interface UsageBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoningTokens: number;
	totalTokens: number;
	apiCalls?: number;
}

export interface CostEntry {
	providerId: string;
	modelId: string;
	tokens: number;
	usd: number;
	provenance: CostProvenance;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoningTokens: number;
	apiCalls?: number;
}

export interface CostTracker {
	accumulate(
		providerId: string,
		modelId: string,
		tokens: number,
		usd?: number,
		breakdown?: Partial<UsageBreakdown>,
		provenance?: CostProvenance,
	): number;
	sessionTotal(): number;
	sessionCost(): CostAggregate;
	sessionTokens(): UsageBreakdown;
	entries(): ReadonlyArray<CostEntry>;
	reset(): void;
}

function emptyBreakdown(): UsageBreakdown {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, totalTokens: 0 };
}

export function createCostTracker(): CostTracker {
	const log: CostEntry[] = [];
	let total = 0;
	const totals = emptyBreakdown();
	return {
		accumulate(providerId, modelId, tokens, usd, breakdown, costProvenance) {
			const resolvedUsd = usd ?? 0;
			const provenance = normalizeCostProvenance(costProvenance);
			const input = breakdown?.input ?? 0;
			const output = breakdown?.output ?? 0;
			const cacheRead = breakdown?.cacheRead ?? 0;
			const cacheWrite = breakdown?.cacheWrite ?? 0;
			const reasoningTokens = breakdown?.reasoningTokens ?? 0;
			const apiCalls = breakdown?.apiCalls;
			log.push({
				providerId,
				modelId,
				tokens,
				usd: resolvedUsd,
				provenance,
				input,
				output,
				cacheRead,
				cacheWrite,
				reasoningTokens,
				...(apiCalls !== undefined ? { apiCalls } : {}),
			});
			total += resolvedUsd;
			totals.input += input;
			totals.output += output;
			totals.cacheRead += cacheRead;
			totals.cacheWrite += cacheWrite;
			totals.reasoningTokens += reasoningTokens;
			totals.totalTokens += tokens;
			return resolvedUsd;
		},
		sessionTotal() {
			return total;
		},
		sessionCost() {
			return aggregateCostAmounts(log.map((entry) => ({ usd: entry.usd, provenance: entry.provenance })));
		},
		sessionTokens() {
			return { ...totals };
		},
		entries() {
			return log;
		},
		reset() {
			log.length = 0;
			total = 0;
			totals.input = 0;
			totals.output = 0;
			totals.cacheRead = 0;
			totals.cacheWrite = 0;
			totals.reasoningTokens = 0;
			totals.totalTokens = 0;
		},
	};
}
