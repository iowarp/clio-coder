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
		runCap?: RunCostCap,
	) {
		super(
			runCap !== undefined && ceilingUsd >= runCap.ceilingUsd
				? `${SESSION_COST_CEILING_REASON}: this run's priced spend $${(currentUsd - runCap.startUsd).toFixed(4)} reached its --max-cost-usd $${runCap.maxUsd.toFixed(4)} cap`
				: `${SESSION_COST_CEILING_REASON}: session priced spend $${currentUsd.toFixed(4)} reached the $${ceilingUsd.toFixed(4)} ceiling; raise safety.limits.sessionCostUsd`,
		);
	}
}

/**
 * A `clio-coder run --max-cost-usd` cap: the session's priced spend when the
 * run started, what the run may add, and their sum. The sum is the run's own
 * ceiling before any lower configured one, so a stop at it names the flag
 * rather than a setting that cannot lift it.
 */
export interface RunCostCap {
	maxUsd: number;
	startUsd: number;
	ceilingUsd: number;
}

export function createRunCostCap(startUsd: number, maxUsd: number): RunCostCap {
	return { maxUsd, startUsd, ceilingUsd: startUsd + maxUsd };
}

/**
 * `safety.limits.sessionCostUsd: 0` means no ceiling. Every reader that
 * compares spend against the configured value goes through here so none of
 * them treats zero as a ceiling already crossed.
 */
export function sessionCeilingReached(spendUsd: number, ceilingUsd: number): boolean {
	return ceilingUsd > 0 && spendUsd >= ceilingUsd;
}

/**
 * The session ceiling a `clio-coder run --max-cost-usd` run admits paid requests
 * under: what the session already spent plus what the run may add, so a
 * continued session's earlier spend does not count against the run. A lower
 * configured ceiling (`safety.limits.sessionCostUsd`) still holds.
 */
export function runCostCeilingUsd(input: { spentUsd: number; runMaxUsd: number; configuredUsd: number }): number {
	const run = createRunCostCap(input.spentUsd, input.runMaxUsd).ceilingUsd;
	return input.configuredUsd > 0 ? Math.min(input.configuredUsd, run) : run;
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
