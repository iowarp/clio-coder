/**
 * Running USD cost accumulator. The catalog-backed auto-pricing fallback was
 * dropped in the provider redesign; pricing now flows from the providers
 * domain's EndpointPricing + knowledge-base entries and the caller supplies
 * the resolved `usd` per call. Unknown or unpriced calls accumulate zero so
 * they never blow up the tally.
 */

export interface CostEntry {
	providerId: string;
	modelId: string;
	tokens: number;
	usd: number;
}

export interface CostTracker {
	accumulate(providerId: string, modelId: string, tokens: number, usd?: number): number;
	sessionTotal(): number;
	entries(): ReadonlyArray<CostEntry>;
	reset(): void;
}

export function createCostTracker(): CostTracker {
	const log: CostEntry[] = [];
	let total = 0;
	return {
		accumulate(providerId, modelId, tokens, usd) {
			const resolvedUsd = usd ?? 0;
			log.push({ providerId, modelId, tokens, usd: resolvedUsd });
			total += resolvedUsd;
			return resolvedUsd;
		},
		sessionTotal() {
			return total;
		},
		entries() {
			return log;
		},
		reset() {
			log.length = 0;
			total = 0;
		},
	};
}
