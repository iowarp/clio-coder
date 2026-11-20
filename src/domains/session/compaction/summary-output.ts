import type { ThinkingLevel } from "../../../core/defaults.js";
import type { EngineModel } from "../../../engine/types.js";
import { DEFAULT_RESERVE_TOKENS } from "./defaults.js";
import { summaryReasoningShare } from "./reasoning-share.js";

/** The route of a summary call: the key its observed reasoning share is remembered under. */
type SummaryRoute = Pick<EngineModel, "provider" | "baseUrl" | "id">;

/**
 * The thinking level a summary call runs at, as its send resolves it: the portable request asks thinking off and keeps
 * whatever level its route still resolves (an always-on model), the live prefix keeps the turn's. Absent reads as off.
 */
type SummaryThinking = ThinkingLevel | undefined;

/** Only a summary call whose effective thinking is above off spends output on reasoning (CTX-3). */
function summaryReasons(thinking: SummaryThinking): boolean {
	return thinking !== undefined && thinking !== "off";
}

export interface SummaryOutputBudget {
	/** Explicit output cap for the summary request; undefined lets the server decide. */
	maxTokens: number | undefined;
	/** Room the summary text keeps in the next context. */
	summaryRoom: number;
}

/**
 * The reasoning share the trigger assumes for a thinking summary on a route that has written no summary yet, so it keeps the
 * summary room twice over rather than the route's whole output limit. The request itself may still ask for the limit.
 */
const DEFAULT_REASONING_SHARE = 0.5;

/**
 * The share of a summary call's output left for its text: past the observed reasoning share, or the default's, when
 * the call thinks. A call with thinking off keeps all of it, whatever the model could do (CTX-3).
 */
function summaryTextShare(model: SummaryRoute, thinking: SummaryThinking): number {
	return summaryReasons(thinking) ? 1 - (summaryReasoningShare(model) ?? DEFAULT_REASONING_SHARE) : 1;
}

/**
 * The text share of a capped summary call. A call that thinks keeps at least the share the trigger assumes: a
 * route whose summaries reported no reasoning got a request of exactly its stated room, and a summarizer that ran past
 * that budget stopped at the output limit and saved no checkpoint (bt3 drv-m3c b3).
 */
function cappedTextShare(model: SummaryRoute, thinking: SummaryThinking): number {
	const share = summaryTextShare(model, thinking);
	return summaryReasons(thinking) ? Math.min(share, 1 - DEFAULT_REASONING_SHARE) : share;
}

/**
 * The output cap that leaves a capped summary `roomTokens` of text past the route's reasoning share, so a stated
 * length budget is also the request's (bt-18 item 8).
 */
export function summaryOutputForRoom(model: SummaryRoute, roomTokens: number, thinking: SummaryThinking): number {
	return Math.ceil(roomTokens / cappedTextShare(model, thinking));
}

/** Tokens a checkpoint summary keeps in the next context: the reserve's room. */
export function summaryRoomTokens(reserveTokens: number = DEFAULT_RESERVE_TOKENS): number {
	return Math.max(1024, Math.floor(reserveTokens * 0.8));
}

/**
 * The summary request's output budget. A route that reports no output limit gets
 * no explicit cap and the server decides; refusing it would leave a reactive
 * overflow compaction with no way out. The summary text keeps the reserve's room
 * in the next context. A call that thinks spends output on reasoning first, so
 * the cap adds the reasoning share observed on that route, up to the model's
 * output limit; a thinking call with nothing observed yet gets its whole limit. An `outputCap` bounds the cap
 * further, and the room to what that cap leaves past reasoning: a chat-route summary on a small window keeps to the
 * admissible reserve (bt-18). Under a cap a thinking call keeps at least the trigger's reasoning share, so the
 * request asks the room plus that share, never just the room (bt3 drv-m3c b3). Whether the call thinks is its
 * effective thinking level, not the model's capability: a reasoning model asked with thinking off gets no reasoning
 * room (CTX-3).
 */
export function summaryOutputBudget(
	model: SummaryRoute & Pick<EngineModel, "maxTokens">,
	thinking: SummaryThinking,
	reserveTokens: number = DEFAULT_RESERVE_TOKENS,
	outputCap?: number,
): SummaryOutputBudget {
	const outputLimit = Number.isFinite(model.maxTokens) && model.maxTokens >= 1 ? Math.floor(model.maxTokens) : undefined;
	const summaryRoom = Math.min(
		summaryRoomTokens(reserveTokens),
		outputCap === undefined ? Number.POSITIVE_INFINITY : summaryRoomTokens(outputCap * cappedTextShare(model, thinking)),
	);
	if (outputCap !== undefined)
		return {
			maxTokens:
				outputLimit === undefined
					? undefined
					: Math.min(outputLimit, outputCap, summaryOutputForRoom(model, summaryRoom, thinking)),
			summaryRoom,
		};
	if (outputLimit === undefined) return { maxTokens: undefined, summaryRoom };
	if (!summaryReasons(thinking)) return { maxTokens: Math.min(outputLimit, summaryRoom), summaryRoom };
	const reasoningShare = summaryReasoningShare(model);
	const maxTokens = Math.min(
		outputLimit,
		reasoningShare === undefined ? outputLimit : Math.ceil(summaryRoom / (1 - reasoningShare)),
	);
	return { maxTokens, summaryRoom };
}

/**
 * Tokens the automatic trigger keeps free beside the context for a compaction summary, so the summary still fits.
 * A summary written on a separate route runs in that route's own window, and the chat window then holds only the
 * summary it returns. One written on the chat route shares the window with its output, reasoning included when the
 * summary call's effective `thinking` is above off.
 */
export function summaryOutputReserve(
	model: SummaryRoute & Pick<EngineModel, "maxTokens">,
	options: { summaryOnChatRoute: boolean; thinking: SummaryThinking; reserveTokens?: number },
): number {
	const { maxTokens, summaryRoom } = summaryOutputBudget(
		model,
		options.thinking,
		options.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
	);
	if (!options.summaryOnChatRoute || maxTokens === undefined) return summaryRoom;
	if (summaryReasons(options.thinking) && summaryReasoningShare(model) === undefined) {
		return Math.min(maxTokens, Math.ceil(summaryRoom / (1 - DEFAULT_REASONING_SHARE)));
	}
	return maxTokens;
}
