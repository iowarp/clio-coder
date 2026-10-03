/**
 * Session budget state. Admission checks priced spend before the next paid
 * request; unpriced requests never enter this gate.
 */

export type BudgetVerdict = "under" | "at" | "over";

export const SESSION_COST_CEILING_REASON = "budget_ceiling";
export const SESSION_COST_CEILING_EXIT_CODE = 4;

export class SessionCostCeilingError extends Error {
	override readonly name = "SessionCostCeilingError";
	constructor(
		readonly currentUsd: number,
		readonly ceilingUsd: number,
	) {
		super(
			`${SESSION_COST_CEILING_REASON}: session priced spend $${currentUsd.toFixed(4)} reached the $${ceilingUsd.toFixed(4)} ceiling; raise safety.limits.sessionCostUsd`,
		);
	}
}

/**
 * `safety.limits.sessionCostUsd: 0` means no ceiling. Every reader that
 * compares spend against the configured value goes through here so none of
 * them treats zero as a ceiling already crossed.
 */
export function sessionCeilingReached(spendUsd: number, ceilingUsd: number): boolean {
	return ceilingUsd > 0 && spendUsd >= ceilingUsd;
}

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
			if (ceiling === 0) return "under";
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
