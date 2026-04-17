/**
 * Session budget state. checkCeiling reports whether the current spend is at
 * or above the ceiling; dispatch admission stays informational for v0.1 per
 * the Phase 10 scope, so the caller decides whether to enforce.
 */

export type BudgetVerdict = "under" | "at" | "over";

export interface BudgetState {
	ceilingUsd: number;
	checkCeiling(currentUsd: number): BudgetVerdict;
	raise(newCeilingUsd: number): void;
}

export function createBudgetState(initialCeilingUsd: number): BudgetState {
	if (initialCeilingUsd < 0) throw new Error(`budget: ceiling must be >= 0 (got ${initialCeilingUsd})`);
	let ceiling = initialCeilingUsd;

	return {
		get ceilingUsd() {
			return ceiling;
		},
		checkCeiling(currentUsd) {
			if (currentUsd > ceiling) return "over";
			if (currentUsd === ceiling) return "at";
			return "under";
		},
		raise(newCeilingUsd) {
			if (newCeilingUsd < ceiling) {
				throw new Error(`budget.raise: new ceiling ${newCeilingUsd} below current ${ceiling}`);
			}
			ceiling = newCeilingUsd;
		},
	};
}
