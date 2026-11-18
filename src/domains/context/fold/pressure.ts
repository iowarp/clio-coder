/**
 * The two questions ContextFold §3.4 keeps apart. Economic pressure asks
 * whether context is large enough to be worth reducing; it reads the live
 * estimate against the trigger window and may be answered early. Physical fit
 * asks whether one finalized attempt can be sent at all; it reads that
 * attempt's input against the real window. Neither answers for the other.
 */

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
	/** The static prefix (system prompt and tool schemas) the request carries whatever S1 evicts. */
	prefixTokens?: number;
}

/**
 * S1's threshold and target. On a known window under 52,428 tokens the automatic trigger sits below S1's own gate,
 * so the age rung never acted and every pass paid for a summary; there S1 takes the trigger's fraction, and its
 * target scales by the same ratio, as notice and prepare do (0.75 x the trigger at the defaults). Every other case
 * keeps the raw figures (bt-47 tui-cf1 D6, cf1h-D5, ContextFold A3).
 *
 * That ratio applies to the history below the trigger, not to the static prefix S1 cannot evict: counted over the
 * whole trigger, an 8K prefix left the 40K route's history about half its space (bt-18 item 8).
 */
export function evictionPressure(input: EvictionPressureInput): { threshold: number; target: number } {
	if (!input.automatic || !(input.window > 0) || input.window >= SMALL_WINDOW_TOKENS || !(input.threshold > 0))
		return { threshold: input.threshold, target: input.target };
	const threshold = input.triggerFraction();
	const ratio = input.target / input.threshold;
	const prefix = (input.prefixTokens ?? 0) / input.window;
	if (!(prefix > 0) || prefix >= threshold) return { threshold, target: input.target * (threshold / input.threshold) };
	return { threshold, target: prefix + ratio * (threshold - prefix) };
}

export interface FitOutputReserveInput {
	/** The route's real context window; zero or less when it reports none. */
	window: number;
	/** The turn's own output reserve, the one the automatic trigger counts. */
	turnReserve: number;
	/** The reserve that still leaves the wire a usable response; see `ADMISSIBLE_OUTPUT_RESERVE`. */
	admissibleReserve: number;
	/** A configured chat.maxOutputTokens: the operator's reserve, refused by name rather than shrunk (bt-13). */
	hardReserve: boolean;
}

/**
 * The output reserve physical fit counts. Under 52,428 tokens an uncapped turn reserve is half the window, the figure
 * the automatic trigger counts too, so fit failed exactly where the trigger fired: every pass took the overflow path,
 * A1's no-gain skip and A3's S1 never ran, and the post-tool guard stopped requests the provider accepts (bt3 m2a).
 * There fit counts the admissible reserve, never more than the turn's, so it fails only above the trigger. A
 * configured chat.maxOutputTokens and every other window keep the turn reserve (ContextFold A5).
 */
export function fitOutputReserve(input: FitOutputReserveInput): number {
	if (input.hardReserve || !(input.window > 0) || input.window >= SMALL_WINDOW_TOKENS) return input.turnReserve;
	return Math.min(input.turnReserve, input.admissibleReserve);
}

/**
 * The cap on a chat-route compaction summary call's own output. Under 52,428 tokens it is the admissible reserve, or
 * a configured chat.maxOutputTokens above it, as fit counts (A5): a reasoning route asked its whole output limit, and
 * the summary request kept that much of a small window from the history it reads (bt-18). Every other window has
 * no cap, as today.
 */
export function summaryOutputCap(input: {
	window: number;
	admissibleReserve: number;
	configured: number | null;
}): number | undefined {
	if (!(input.window > 0) || input.window >= SMALL_WINDOW_TOKENS) return undefined;
	return Math.max(input.admissibleReserve, input.configured ?? 0);
}
