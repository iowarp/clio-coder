/**
 * Budget hard stops. A campaign stops before an iteration once it has run `maxIterations`, spent `maxWallMinutes`, or
 * spent `maxCostUsd`. Spend is the sum of each agent run's `Fact` cost. A run whose spend is unknown makes the cost cap
 * unenforceable: the campaign then stops with `budget-unenforceable` unless `allowUnpriced` was given. Unknown spend is
 * never counted as zero, and a report says when spend was not measured.
 */
import type { FactSum } from "../../core/telemetry/fact.js";
import type { ResearchBudget, ResearchCost, ResearchStopReason } from "./types.js";

/** The `usage.cost` a `run --json` `agent_end` frame carries, as far as this reader trusts it. */
export interface PricingSumLike {
	usd: Pick<FactSum, "measured" | "estimated" | "unknownCount">;
	free: boolean;
}

function isPricingSum(value: unknown): value is PricingSumLike {
	if (value === null || typeof value !== "object") return false;
	const usd = (value as { usd?: unknown }).usd;
	if (usd === null || typeof usd !== "object") return false;
	const sum = usd as Record<string, unknown>;
	return (
		typeof sum.measured === "number" &&
		typeof sum.estimated === "number" &&
		typeof sum.unknownCount === "number" &&
		typeof (value as { free?: unknown }).free === "boolean"
	);
}

/** One run's spend from the cost sums of its `agent_end` frames. No frame at all is unknown spend, not zero. */
export function costFromPricing(sums: ReadonlyArray<unknown>): ResearchCost {
	if (sums.length === 0) return { kind: "unknown", reason: "the run reported no usage" };
	let measured = 0;
	let estimated = 0;
	let free = true;
	for (const sum of sums) {
		if (!isPricingSum(sum)) return { kind: "unknown", reason: "the run reported a cost this build cannot read" };
		if (sum.free) continue;
		free = false;
		if (sum.usd.unknownCount > 0)
			return { kind: "unknown", reason: `${sum.usd.unknownCount} call(s) had no price for their model` };
		measured += sum.usd.measured;
		estimated += sum.usd.estimated;
	}
	if (free) return { kind: "free" };
	return estimated > 0 ? { kind: "estimated", usd: measured + estimated } : { kind: "measured", usd: measured };
}

export interface SpendTotal {
	/** Known spend: measured plus estimated dollars. */
	usd: number;
	/** Runs whose spend is unknown; when positive, `usd` is a lower bound. */
	unknownRuns: number;
	estimated: boolean;
}

export function totalSpend(costs: ReadonlyArray<ResearchCost>): SpendTotal {
	let usd = 0;
	let unknownRuns = 0;
	let estimated = false;
	for (const cost of costs) {
		if (cost.kind === "unknown") unknownRuns += 1;
		else if (cost.kind !== "free") usd += cost.usd;
		if (cost.kind === "estimated") estimated = true;
	}
	return { usd, unknownRuns, estimated };
}

export interface BudgetState {
	iterations: number;
	elapsedMs: number;
	costs: ReadonlyArray<ResearchCost>;
}

export interface BudgetStop {
	reason: Extract<ResearchStopReason, "max-iterations" | "max-wall-minutes" | "max-cost-usd" | "budget-unenforceable">;
	detail: string;
}

/** The stop that binds before the next iteration, or null when another one may run. */
export function budgetStop(budget: ResearchBudget, state: BudgetState): BudgetStop | null {
	if (state.iterations >= budget.maxIterations)
		return { reason: "max-iterations", detail: `ran ${state.iterations} of ${budget.maxIterations} iterations` };
	if (budget.maxWallMinutes !== undefined && state.elapsedMs >= budget.maxWallMinutes * 60_000)
		return {
			reason: "max-wall-minutes",
			detail: `ran ${(state.elapsedMs / 60_000).toFixed(1)} of ${budget.maxWallMinutes} minutes`,
		};
	if (budget.maxCostUsd !== undefined) {
		const spend = totalSpend(state.costs);
		if (spend.unknownRuns > 0 && !budget.allowUnpriced)
			return {
				reason: "budget-unenforceable",
				detail: `${spend.unknownRuns} agent run(s) reported unknown spend, so the $${budget.maxCostUsd} cap cannot be enforced; pass --allow-unpriced to continue on the iteration and wall caps`,
			};
		if (spend.usd >= budget.maxCostUsd)
			return { reason: "max-cost-usd", detail: `spent $${spend.usd.toFixed(4)} of $${budget.maxCostUsd}` };
	}
	return null;
}

/** What the next agent run may use: the wall time and known spend left, passed down as `--timeout` and `--max-cost-usd`. */
export function nextRunLimits(
	budget: ResearchBudget,
	state: BudgetState,
): { timeoutSeconds?: number; maxCostUsd?: number } {
	const limits: { timeoutSeconds?: number; maxCostUsd?: number } = {};
	if (budget.maxWallMinutes !== undefined)
		limits.timeoutSeconds = Math.max(1, Math.floor((budget.maxWallMinutes * 60_000 - state.elapsedMs) / 1000));
	if (budget.maxCostUsd !== undefined) {
		const left = budget.maxCostUsd - totalSpend(state.costs).usd;
		limits.maxCostUsd = Math.max(0.0001, Number(left.toFixed(6)));
	}
	return limits;
}
