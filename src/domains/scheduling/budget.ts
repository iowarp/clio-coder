/**
 * Session budget state. Admission checks priced spend before the next paid
 * request; unpriced requests never enter this gate.
 */

export type BudgetVerdict = "under" | "at" | "over";

export const SESSION_COST_CEILING_REASON = "budget_ceiling";
export const SESSION_COST_CEILING_EXIT_CODE = 4;

/** Keep live and replayed ceiling remedies consistent with the durable block (#424). */
export function suggestedSessionCostCeilingUsd(currentUsd: number, ceilingUsd: number): number {
	return Math.ceil(Math.max(currentUsd * 1.1, ceilingUsd + 0.01) * 10_000) / 10_000;
}

/** The setting a ceiling stop asks the operator to raise. */
export const SESSION_COST_CEILING_SETTING = "safety.limits.sessionCostUsd";

/**
 * One ceiling stop as every surface describes it: the live `BudgetAlert`
 * payload, the durable `budgetBlock` ledger entry and the ACP frame all read
 * through here, so the TUI, ACP clients and the GUI name the same spend,
 * ceiling and raise (#424).
 */
export interface BudgetBlockView {
	level: "at" | "over";
	currentUsd: number;
	ceilingUsd: number;
	contextTokens?: number;
	raiseToUsd: number;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Null for a payload that is not a ceiling stop; a missing or stale raise is recomputed. */
export function readBudgetBlock(value: unknown): BudgetBlockView | null {
	if (!value || typeof value !== "object") return null;
	const p = value as Record<string, unknown>;
	if (p.level !== "at" && p.level !== "over") return null;
	if (!finite(p.currentUsd) || !finite(p.ceilingUsd)) return null;
	const raiseToUsd =
		finite(p.raiseToUsd) && p.raiseToUsd > p.currentUsd
			? p.raiseToUsd
			: suggestedSessionCostCeilingUsd(p.currentUsd, p.ceilingUsd);
	return {
		level: p.level,
		currentUsd: p.currentUsd,
		ceilingUsd: p.ceilingUsd,
		...(finite(p.contextTokens) && p.contextTokens > 0 ? { contextTokens: p.contextTokens } : {}),
		raiseToUsd,
	};
}

/** `$5.00 of $5.00 ceiling`, with more digits for a sub-cent ceiling. */
export function budgetBlockSpendText(block: Pick<BudgetBlockView, "currentUsd" | "ceilingUsd">): string {
	const digits = block.ceilingUsd < 0.01 ? Math.min(8, Math.max(4, Math.ceil(-Math.log10(block.ceilingUsd)))) : 2;
	return `$${block.currentUsd.toFixed(digits)} of $${block.ceilingUsd.toFixed(digits)} ceiling`;
}

/** The one-line operator notice for a ceiling stop; `error` once spend has passed the ceiling. */
export function describeBudgetBlock(block: BudgetBlockView): { level: "warn" | "error"; text: string } {
	const spend = budgetBlockSpendText(block);
	// Per-call context is what a raise would keep paying for, so the stop names it (#423).
	const perCall =
		block.contextTokens !== undefined
			? ` The next call sends ~${Math.round(block.contextTokens).toLocaleString("en-US")} context tokens.`
			: "";
	const remedy = `raise ${SESSION_COST_CEILING_SETTING} to ${block.raiseToUsd} to resume.`;
	if (block.level === "over") {
		return {
			level: "error",
			text: `[budget] Session priced spend ${spend} exceeded.${perCall} Paid requests are paused; ${remedy}`,
		};
	}
	return {
		level: "warn",
		text: `[budget] Session priced spend ${spend} reached.${perCall} Paid requests are paused; ${remedy}`,
	};
}

export class SessionCostCeilingError extends Error {
	override readonly name = "SessionCostCeilingError";
	constructor(
		readonly currentUsd: number,
		readonly ceilingUsd: number,
		runCap?: RunCostCap,
		contextTokens?: number,
	) {
		// The context each call re-sends is the per-call cost a headless stop
		// cannot raise past, so the error names it when the caller knows it (#423).
		const perCall = budgetStopContextClause(contextTokens);
		super(
			runCap !== undefined && ceilingUsd >= runCap.ceilingUsd
				? `${SESSION_COST_CEILING_REASON}: this run's priced spend $${(currentUsd - runCap.startUsd).toFixed(4)} reached its --max-cost-usd $${runCap.maxUsd.toFixed(4)} cap${perCall}`
				: `${SESSION_COST_CEILING_REASON}: session priced spend $${currentUsd.toFixed(4)} reached the $${ceilingUsd.toFixed(4)} ceiling${perCall}; raise safety.limits.sessionCostUsd`,
		);
	}
}

/** ` with ~N context tokens per call`, or empty when the request size is unknown. */
function budgetStopContextClause(contextTokens: number | undefined): string {
	if (contextTokens === undefined || !Number.isFinite(contextTokens) || contextTokens <= 0) return "";
	return ` with ~${Math.round(contextTokens).toLocaleString("en-US")} context tokens per call`;
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
