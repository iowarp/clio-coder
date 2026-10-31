import { renderCostRemaining, renderUsdSetting } from "../../core/telemetry/render.js";
import { renderCostAmount } from "../observability/cost.js";
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
	/** How the spend was priced; absent on a stop recorded before 0.6.6, which named its spend as known. */
	pricing?: BudgetSpendPricing;
}

/**
 * How the spend a stop compares was priced, as the cost tracker that admission reads words it: any estimated part
 * marks the amount `~`, and any sent call it could not price adds `+?`, so a stop never names estimated or partial
 * spend as known (#434 §6.3).
 */
export interface BudgetSpendPricing {
	estimated: boolean;
	unpriced: boolean;
}

/** Either part estimated or unpriced marks the sum; a part with no pricing facts adds none. */
export function combineBudgetPricing(
	a: BudgetSpendPricing | undefined,
	b: BudgetSpendPricing | undefined,
): BudgetSpendPricing | undefined {
	return a && b ? { estimated: a.estimated || b.estimated, unpriced: a.unpriced || b.unpriced } : (a ?? b);
}

function readPricing(value: unknown): BudgetSpendPricing | undefined {
	if (!value || typeof value !== "object") return undefined;
	const p = value as Record<string, unknown>;
	return typeof p.estimated === "boolean" && typeof p.unpriced === "boolean"
		? { estimated: p.estimated, unpriced: p.unpriced }
		: undefined;
}

/** A stop's spend through the canonical renderer, marked as it was priced. */
export function budgetSpendText(usd: number, pricing: BudgetSpendPricing | undefined): string {
	if (!pricing) return renderCostAmount(usd, "known");
	return renderCostAmount(usd, undefined, {
		knownUsd: usd,
		hasEstimated: pricing.estimated,
		hasUnknown: pricing.unpriced,
		allKnownFree: false,
		calls: 1,
	});
}

/**
 * The session budget a spend leaves: the ceiling less that spend, so it carries the spend's estimate, and an unpriced
 * part of the spend makes it an upper bound rather than a lower one (#434 §6.3).
 */
export function budgetRemainingText(
	ceilingUsd: number,
	spentUsd: number,
	pricing: BudgetSpendPricing | undefined,
): string {
	return renderCostRemaining(ceilingUsd - spentUsd, pricing ?? { estimated: false, unpriced: false });
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
	const pricing = readPricing(p.pricing);
	return {
		level: p.level,
		currentUsd: p.currentUsd,
		ceilingUsd: p.ceilingUsd,
		...(finite(p.contextTokens) && p.contextTokens > 0 ? { contextTokens: p.contextTokens } : {}),
		raiseToUsd,
		...(pricing ? { pricing } : {}),
	};
}

/** `$5.00 of $5.00 ceiling`, `~$5.00 est of …` or `$5.00 +? of …`, with more digits for a sub-cent ceiling. */
export function budgetBlockSpendText(block: Pick<BudgetBlockView, "currentUsd" | "ceilingUsd" | "pricing">): string {
	return `${budgetSpendText(block.currentUsd, block.pricing)} of ${renderCostAmount(block.ceilingUsd, "known")} ceiling`;
}

/** The one-line operator notice for a ceiling stop; `error` once spend has passed the ceiling. */
export function describeBudgetBlock(block: BudgetBlockView): { level: "warn" | "error"; text: string } {
	const spend = budgetBlockSpendText(block);
	// Per-call context is what a raise would keep paying for, so the stop names it (#423).
	const perCall =
		block.contextTokens !== undefined
			? ` The next call sends ~${Math.round(block.contextTokens).toLocaleString("en-US")} context tokens.`
			: "";
	const remedy = `raise ${SESSION_COST_CEILING_SETTING} to ${renderUsdSetting(block.raiseToUsd)} to resume.`;
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
		pricing?: BudgetSpendPricing,
	) {
		// The context each call re-sends is the per-call cost a headless stop
		// cannot raise past, so the error names it when the caller knows it (#423).
		const perCall = budgetStopContextClause(contextTokens);
		super(
			runCap !== undefined && ceilingUsd >= runCap.ceilingUsd
				? `${SESSION_COST_CEILING_REASON}: this run's priced spend ${budgetSpendText(currentUsd - runCap.startUsd, pricing)} reached its --max-cost-usd ${renderCostAmount(runCap.maxUsd, "known")} cap${perCall}`
				: `${SESSION_COST_CEILING_REASON}: session priced spend ${budgetSpendText(currentUsd, pricing)} reached the ${renderCostAmount(ceilingUsd, "known")} ceiling${perCall}; raise safety.limits.sessionCostUsd`,
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
