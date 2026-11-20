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

/** The run clause of an unpriced card before the call's `timeout_ms` is known: no run timer exists without one. */
const NO_RUN_TIMER = "the run has no wall-clock bound unless timeout_ms is set";

/**
 * The bounds one dispatched run has, as its plan card states them (ruling 13).
 * A priced route names its estimate and the output bound it was priced at; an
 * unpriced route has no cost bound, so the card names only what does stop it
 * in 0.8.5: the per-response limit of a native worker, the call's timeout_ms
 * when it sets one (`planCardLimitsUnderTimeout`), and the tool ceiling. An
 * external one-shot worker's tool calls are not counted, so it is promised no
 * tool ceiling.
 */
export function planCardLimits(input: PlanCardLimitsInput): string {
	const tools =
		input.budget.enforcement.classification === "external-one-shot"
			? "one launch whose tool calls Clio cannot count, so no tool ceiling applies"
			: budgetLimitWords(input.budget);
	if (input.priced) {
		return `cost ${renderUsdEstimate(input.costUpperBoundUsd)} per model call at a ${input.outputBoundTokens}-token output bound; ${tools}`;
	}
	const response = input.nativeWorker ? `each response stops at ${input.responseSeconds} s, and ` : "";
	return `unpriced route: ${response}${NO_RUN_TIMER}; ${tools}`;
}

/** The card's limits once the dispatch call sets `timeout_ms`, whose timer stops every run the call started. */
export function planCardLimitsUnderTimeout(limits: string, timeoutMs: number): string {
	return limits.replace(NO_RUN_TIMER, `the call's timeout_ms stops the run within ${timeoutMs} ms`);
}
