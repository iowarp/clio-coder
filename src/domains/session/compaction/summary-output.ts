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
 * The summary request's output budget. A route that reports no output limit gets
 * no explicit cap and the server decides; refusing it would leave a reactive
 * overflow compaction with no way out. The summary text keeps the reserve's room
 * in the next context. A route that reasons spends output on reasoning first, so
 * the cap adds the reasoning share observed on that route, up to the model's
 * output limit; a reasoning route with nothing observed yet gets its whole limit.
 */
export function summaryOutputBudget(
	model: Pick<EngineModel, "provider" | "baseUrl" | "id" | "maxTokens" | "reasoning">,
	reserveTokens: number = DEFAULT_RESERVE_TOKENS,
): SummaryOutputBudget {
	const outputLimit = Number.isFinite(model.maxTokens) && model.maxTokens >= 1 ? Math.floor(model.maxTokens) : undefined;
	const summaryRoom = Math.max(1024, Math.floor(reserveTokens * 0.8));
	const reasoningShare = summaryReasoningShare(model);
	const maxTokens =
		outputLimit === undefined
			? undefined
			: Math.min(
					outputLimit,
					reasoningShare === undefined
						? model.reasoning
							? outputLimit
							: summaryRoom
						: Math.ceil(summaryRoom / (1 - reasoningShare)),
				);
	return { maxTokens, summaryRoom };
}

/**
 * Output tokens a compaction summary needs beside the context it reads; the
 * automatic trigger counts them against the window so the summary still fits.
 */
export function summaryOutputReserve(
	model: Pick<EngineModel, "provider" | "baseUrl" | "id" | "maxTokens" | "reasoning">,
	reserveTokens: number = DEFAULT_RESERVE_TOKENS,
): number {
	const { maxTokens, summaryRoom } = summaryOutputBudget(model, reserveTokens);
	return maxTokens ?? summaryRoom;
}
