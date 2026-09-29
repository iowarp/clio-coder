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
