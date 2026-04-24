/**
 * Running USD cost accumulator. The catalog-backed auto-pricing fallback was
 * dropped in the provider redesign; pricing now flows from the providers
 * domain's EndpointPricing + knowledge-base entries and the caller supplies
 * the resolved `usd` per call. Unknown or unpriced calls accumulate zero so
 * they never blow up the tally.
 *
 * Per-entry token breakdown (input/output/cacheRead/cacheWrite) matches the
 * shape of pi-ai's `Usage`. The /cost overlay aggregates it via
 * `aggregateCostEntries`; the TUI footer consumes the session sum through
 * `ObservabilityContract.sessionTokens()`.
 */

export interface UsageBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface CostEntry {
	providerId: string;
	modelId: string;
	tokens: number;
	usd: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface CostTracker {
	accumulate(
		providerId: string,
		modelId: string,
		tokens: number,
		usd?: number,
		breakdown?: Partial<UsageBreakdown>,
	): number;
	sessionTotal(): number;
	sessionTokens(): UsageBreakdown;
	entries(): ReadonlyArray<CostEntry>;
	reset(): void;
}

function emptyBreakdown(): UsageBreakdown {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

export function createCostTracker(): CostTracker {
	const log: CostEntry[] = [];
	let total = 0;
	const totals = emptyBreakdown();
	return {
		accumulate(providerId, modelId, tokens, usd, breakdown) {
			const resolvedUsd = usd ?? 0;
			const input = breakdown?.input ?? 0;
			const output = breakdown?.output ?? 0;
			const cacheRead = breakdown?.cacheRead ?? 0;
			const cacheWrite = breakdown?.cacheWrite ?? 0;
			log.push({ providerId, modelId, tokens, usd: resolvedUsd, input, output, cacheRead, cacheWrite });
			total += resolvedUsd;
			totals.input += input;
			totals.output += output;
			totals.cacheRead += cacheRead;
			totals.cacheWrite += cacheWrite;
			totals.totalTokens += tokens;
			return resolvedUsd;
		},
		sessionTotal() {
			return total;
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
			totals.totalTokens = 0;
		},
	};
}
