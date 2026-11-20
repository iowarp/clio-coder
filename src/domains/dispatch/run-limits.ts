import { renderUsdEstimate } from "../../core/telemetry/render.js";
import { budgetLimitWords, type RunToolBudgetEnvelope } from "./budget-envelope.js";

export interface PlanCardLimitsInput {
	/** False when the route has no rates and the estimate is only the unknown-pricing sentinel. */
	priced: boolean;
	costUpperBoundUsd: number;
	/** Output tokens the estimate priced: the route's output bound. */
	outputBoundTokens: number;
	budget: RunToolBudgetEnvelope;
	/** Only a native worker's own loop applies the per-response limit. */
	nativeWorker: boolean;
	/** `safety.limits.workerResponseSeconds`. */
	responseSeconds: number;
}

/**
 * The bounds one dispatched run has, as its plan card states them (ruling 13).
 * A priced route names its estimate and the output bound it was priced at; an
 * unpriced route has no cost bound, so the card names what does stop it in
 * 0.8.5: the per-response limit, the caller's own timeout_ms, and the tool
 * ceiling. There is no run-wide wall clock to name until one exists.
 */
export function planCardLimits(input: PlanCardLimitsInput): string {
	const tools = budgetLimitWords(input.budget);
	if (input.priced) {
		return `cost ${renderUsdEstimate(input.costUpperBoundUsd)} per model call at a ${input.outputBoundTokens}-token output bound; ${tools}`;
	}
	const response = input.nativeWorker ? `each response stops at ${input.responseSeconds} s and ` : "";
	return `unpriced route, bounded by wall clock and the tool ceiling: ${response}the run only at the call's timeout_ms; ${tools}`;
}
