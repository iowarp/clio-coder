/**
 * Per-route sizing of the main session's per-turn budgets (XR-6, CLI-P26).
 *
 * The per-turn tool-call budget (`safety.limits.chatToolCallsPerTurn`) and the
 * observation pool were sized for a serial model that makes about 1.2 calls per
 * provider round (opus measured 1.21 over the 0.8.5 night). A wide-parallel
 * route (sol 3.35, neon 3.95 calls per round) spends the same budget in a third
 * of the rounds and was cut off mid-exploration. The scale keeps the budget at
 * the same number of rounds for every route.
 *
 * Source of the measurement: the live transcript of this session. Every
 * assistant message the current model wrote that carries tool calls is one
 * round; its tool-call blocks are that round's calls. Only the newest
 * {@link WIDTH_SAMPLE_ROUNDS} rounds count, and fewer than
 * {@link WIDTH_MIN_ROUNDS} rounds measure nothing (scale 1).
 *
 * Floor and ceiling: the scale never drops below 1, so a serial route keeps the
 * operator's budget exactly, and never rises above {@link WIDTH_SCALE_CEILING}.
 * The observation pool takes at most {@link OBSERVATION_WIDTH_SCALE_CEILING}
 * of it, because that pool guards the context window and not the call count.
 */

/** Calls per round the operator's budget was sized for. */
const WIDTH_BASELINE_CALLS_PER_ROUND = 1.25;
/** Newest tool rounds of the current route that the measurement reads. */
const WIDTH_SAMPLE_ROUNDS = 40;
/** Rounds the route must have made before its width counts. */
const WIDTH_MIN_ROUNDS = 4;
/** Most the call budget grows: three times the operator's budget. */
const WIDTH_SCALE_CEILING = 3;
/** Most the observation pool grows, under its own 1 MiB ceiling. */
export const OBSERVATION_WIDTH_SCALE_CEILING = 1.5;

/** Rounds and calls the current route made in the newest sample of the transcript. */
export function routeCallsPerRound(
	messages: readonly unknown[],
	modelId: string | undefined,
): { rounds: number; calls: number } {
	let rounds = 0;
	let calls = 0;
	if (modelId === undefined || modelId.length === 0) return { rounds, calls };
	for (let index = messages.length - 1; index >= 0 && rounds < WIDTH_SAMPLE_ROUNDS; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		const row = message as { role?: unknown; model?: unknown; content?: unknown };
		if (row.role !== "assistant" || row.model !== modelId || !Array.isArray(row.content)) continue;
		const width = row.content.filter(
			(block) => block !== null && typeof block === "object" && (block as { type?: unknown }).type === "toolCall",
		).length;
		if (width === 0) continue;
		rounds += 1;
		calls += width;
	}
	return { rounds, calls };
}

/** The multiplier for the per-turn call budget, 1 to {@link WIDTH_SCALE_CEILING}, from a route's measured width. */
export function turnBudgetWidthScale(measured: { rounds: number; calls: number }): number {
	if (measured.rounds < WIDTH_MIN_ROUNDS) return 1;
	const perRound = measured.calls / measured.rounds;
	return Math.min(WIDTH_SCALE_CEILING, Math.max(1, perRound / WIDTH_BASELINE_CALLS_PER_ROUND));
}
