import type { ThinkingLevel } from "../../../core/defaults.js";
import type { EngineModel } from "../../../engine/types.js";
import { DEFAULT_RESERVE_TOKENS } from "./defaults.js";
import { summaryReasoningShare } from "./reasoning-share.js";

export interface SummaryOutputBudget {
	/** Explicit output cap for the summary request; undefined lets the server decide. */
	maxTokens: number | undefined;
	/** Room the summary text keeps in the next context. */
	summaryRoom: number;
}

/**
 * The reasoning share the trigger assumes on a reasoning route that has written no summary yet, so it keeps the
 * summary room twice over rather than the route's whole output limit. The request itself may still ask for the limit.
 */
const DEFAULT_REASONING_SHARE = 0.5;

/** The route of a summary call: the key its observed reasoning share is remembered under. */
type SummaryRoute = Pick<EngineModel, "provider" | "baseUrl" | "id">;

/**
 * The thinking level a capped summary call runs at, as its send resolves it: the portable request asks thinking off
 * and keeps whatever level its route still resolves (an always-on model), the live prefix keeps the turn's. Absent
 * reads as off.
 */
type SummaryThinking = ThinkingLevel | undefined;

/**
 * Whether a capped summary call (ContextFold A5, a chat-route summary under 52,428 tokens) spends output on reasoning:
 * only when its effective thinking is above off, whatever the model could do (CTX-3). An uncapped summary keys on the
 * model's capability, as ContextFold pins.
 */
function cappedSummaryReasons(thinking: SummaryThinking): boolean {
	return thinking !== undefined && thinking !== "off";
}

/**
 * The text share of a capped summary call. A call that thinks keeps at least the share the trigger assumes: a route
 * whose summaries reported no reasoning got a request of exactly its stated room, and a summarizer that ran past that
 * budget stopped at the output limit and saved no checkpoint (bt3 drv-m3c b3). A call with thinking off keeps all of
 * it (CTX-3).
 */
function cappedTextShare(model: SummaryRoute, thinking: SummaryThinking): number {
	if (!cappedSummaryReasons(thinking)) return 1;
	return Math.min(1 - (summaryReasoningShare(model) ?? DEFAULT_REASONING_SHARE), 1 - DEFAULT_REASONING_SHARE);
}

/**
 * The output cap that leaves a capped summary `roomTokens` of text past the send's reasoning share, so a stated
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
 * An uncapped summary's budget: the room, plus `reasoningShare` when one was observed; a `reasoning` call with none
 * observed gets the whole output limit.
 */
function uncappedSummaryBudget(
	model: Pick<EngineModel, "maxTokens">,
	reserveTokens: number,
	reasoning: boolean,
	reasoningShare: number | undefined,
): SummaryOutputBudget {
	const outputLimit = Number.isFinite(model.maxTokens) && model.maxTokens >= 1 ? Math.floor(model.maxTokens) : undefined;
	const summaryRoom = summaryRoomTokens(reserveTokens);
	const maxTokens =
		outputLimit === undefined
			? undefined
			: Math.min(
					outputLimit,
					reasoningShare === undefined
						? reasoning
							? outputLimit
							: summaryRoom
						: Math.ceil(summaryRoom / (1 - reasoningShare)),
				);
	return { maxTokens, summaryRoom };
}

/**
 * The summary request's output budget. A route that reports no output limit gets
 * no explicit cap and the server decides; refusing it would leave a reactive
 * overflow compaction with no way out. The summary text keeps the reserve's room
 * in the next context. A route that reasons spends output on reasoning first, so
 * the cap adds the reasoning share observed on that route, up to the model's
 * output limit; a reasoning route with nothing observed yet gets its whole limit. An `outputCap` bounds the cap
 * further, and the room to what that cap leaves past reasoning: a chat-route summary on a small window keeps to the
 * admissible reserve (bt-18). Under a cap a call that thinks keeps at least the trigger's reasoning share, so the
 * request asks the room plus that share, never just the room (bt3 drv-m3c b3); whether it thinks is the call's
 * effective `thinking`, not the model's capability, so a capped summary with thinking off gets no reasoning room
 * (CTX-3). `thinking` is read only under a cap.
 */
export function summaryOutputBudget(
	model: SummaryRoute & Pick<EngineModel, "maxTokens" | "reasoning">,
	reserveTokens: number = DEFAULT_RESERVE_TOKENS,
	outputCap?: number,
	thinking?: SummaryThinking,
): SummaryOutputBudget {
	if (outputCap === undefined)
		return uncappedSummaryBudget(model, reserveTokens, model.reasoning, summaryReasoningShare(model));
	const outputLimit = Number.isFinite(model.maxTokens) && model.maxTokens >= 1 ? Math.floor(model.maxTokens) : undefined;
	const summaryRoom = Math.min(
		summaryRoomTokens(reserveTokens),
		summaryRoomTokens(outputCap * cappedTextShare(model, thinking)),
	);
	return {
		maxTokens:
			outputLimit === undefined
				? undefined
				: Math.min(outputLimit, outputCap, summaryOutputForRoom(model, summaryRoom, thinking)),
		summaryRoom,
	};
}

/**
 * Tokens the automatic trigger keeps free beside the context for a compaction summary, so the summary still fits.
 * A summary written on a separate route runs in that route's own window, and the chat window then holds only the
 * summary it returns. One written on the chat route shares the window with its output, reasoning included. `capped`
 * marks a chat-route summary under its A5 output cap; its reasoning room then follows the summary call's effective
 * thinking (CTX-3). Every other reserve keys on the model's capability, as ContextFold pins.
 */
export function summaryOutputReserve(
	model: SummaryRoute & Pick<EngineModel, "maxTokens" | "reasoning">,
	options: { summaryOnChatRoute: boolean; reserveTokens?: number; capped?: { thinking: SummaryThinking } },
): number {
	const share = summaryReasoningShare(model);
	const reasons = options.capped ? cappedSummaryReasons(options.capped.thinking) : model.reasoning;
	const { maxTokens, summaryRoom } = uncappedSummaryBudget(
		model,
		options.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
		reasons,
		options.capped && !reasons ? undefined : share,
	);
	if (!options.summaryOnChatRoute || maxTokens === undefined) return summaryRoom;
	if (reasons && share === undefined) {
		return Math.min(maxTokens, Math.ceil(summaryRoom / (1 - DEFAULT_REASONING_SHARE)));
	}
	return maxTokens;
}
