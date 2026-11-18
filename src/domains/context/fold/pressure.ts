import { type ContextCompactionVerdict, shouldCompact } from "../../session/compaction/auto.js";
import { requestFits } from "../budget/request-fit.js";

/**
 * The two questions ContextFold §3.4 keeps apart. Economic pressure asks
 * whether context is large enough to be worth reducing; it reads the live
 * estimate against the trigger window and may be answered early. Physical fit
 * asks whether one finalized attempt can be sent at all; it reads that
 * attempt's input against the real window. Neither answers for the other.
 */

export interface EconomicPressureInput {
	/** The live context estimate. */
	tokens: number;
	/** The configured threshold, as the route's compaction budget clamps it. */
	threshold: number;
	/** The route's real window when it is known, otherwise the configured ceiling. */
	triggerWindow: number;
	/** The output the trigger reserves beside the context; see `foldTriggerReserve`. */
	reserve: number;
}

/** Whether the live estimate has crossed the trigger, counting the reserve the threshold leaves uncovered. */
export function economicPressure(input: EconomicPressureInput): ContextCompactionVerdict {
	return shouldCompact(input.tokens, input.threshold, input.triggerWindow, input.reserve);
}

export interface FoldTriggerReserveInput {
	/** The route's real context window, the one its turn reserve is bounded by; zero or less when it reports none. */
	window: number;
	/** The summary's output reserve; it shares the window with the context it reads. */
	summaryReserve: () => number;
	/** The turn's own output reserve, the one admission checks. */
	turnReserve: () => number;
}

/**
 * The reserve the trigger counts: on a known window the larger of the summary's
 * and the turn's, so the trigger fires before admission would refuse the next
 * request; on an unknown window the summary's alone. The turn reserve is read
 * only when the window is known. On a known window the summary's share is
 * bounded at half the window, as the turn reserve is: a reasoning route's 26K
 * summary reserve put a 28K window's trigger at 1,786 tokens, below the static
 * prefix, so a summary fired nearly every round (bt-47 cf1j-b, ContextFold A1).
 */
export function foldTriggerReserve(input: FoldTriggerReserveInput): number {
	if (!(input.window > 0)) return input.summaryReserve();
	return Math.max(Math.min(input.summaryReserve(), Math.floor(input.window / 2)), input.turnReserve());
}

/** Twice a reasoning route's default 26,214 summary reserve: below this known window A1 bounds the trigger's share. */
const SMALL_WINDOW_TOKENS = 52_428;

export interface EvictionPressureInput {
	/** The automatic checkpoint; `/compact`, overflow recovery and the worker guard are not. */
	automatic: boolean;
	/** The route's real context window; zero or less when it reports none. */
	window: number;
	/** The configured threshold, as the route's compaction budget clamps it. */
	threshold: number;
	/** The working-set target fraction. */
	target: number;
	/** The fraction the automatic trigger fires at, counting its reserve; read only when it applies. */
	triggerFraction: () => number;
}

/**
 * S1's threshold and target. On a known window under 52,428 tokens the automatic trigger sits below S1's own gate,
 * so the age rung never acted and every pass paid for a summary; there S1 takes the trigger's fraction, and its
 * target scales by the same ratio, as notice and prepare do (0.75 x the trigger at the defaults). Every other case
 * keeps the raw figures (bt-47 tui-cf1 D6, cf1h-D5, ContextFold A3).
 */
export function evictionPressure(input: EvictionPressureInput): { threshold: number; target: number } {
	if (!input.automatic || !(input.window > 0) || input.window >= SMALL_WINDOW_TOKENS || !(input.threshold > 0))
		return { threshold: input.threshold, target: input.target };
	const threshold = input.triggerFraction();
	return { threshold, target: input.target * (threshold / input.threshold) };
}

/**
 * Whether one finalized attempt fits the real window: input plus reserved
 * output at most the window, so exactly at the window fits. An unknown window
 * (`null`) admits and leaves the verdict to the server.
 */
export function physicalFit(input: number | null, output: number | null, window: number | null): boolean {
	return window === null || requestFits(input, output, window);
}
