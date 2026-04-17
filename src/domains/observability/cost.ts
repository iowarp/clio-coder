/**
 * Running USD cost accumulator. Looks up pricing from the provider catalog and
 * treats missing pricing as zero so unknown providers don't blow up the tally.
 * Token inputs/outputs are lumped together for v0.1; per-direction pricing is
 * a future slice.
 */

import { getModelSpec } from "../providers/catalog.js";
import type { ProviderId } from "../providers/catalog.js";

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

function priceUsdPerToken(providerId: string, modelId: string): number {
	const spec = getModelSpec(providerId as ProviderId, modelId);
	if (!spec) return 0;
	const input = spec.pricePer1MInput ?? 0;
	const output = spec.pricePer1MOutput ?? 0;
	const blended = (input + output) / 2;
	return blended / 1_000_000;
}

export function createCostTracker(): CostTracker {
	const log: CostEntry[] = [];
	let total = 0;
	return {
		accumulate(providerId, modelId, tokens, usd) {
			const resolvedUsd = usd ?? priceUsdPerToken(providerId, modelId) * tokens;
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
