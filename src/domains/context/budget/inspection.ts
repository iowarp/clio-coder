import type { LiveBudgetView } from "./live-view.js";

/** A native-session accounting port, never inherited by a dispatched worker. */
export type BudgetInspection =
	| {
			status: "available";
			capability: "native";
			view: LiveBudgetView;
			/** The view's fit output reserve resolved at another input count, for a caller that adds input to it. */
			outputReserveAt?: (inputTokens: number) => number;
			/** A chars/4 token count priced at the route's measured chars per token, as the view prices its input (CTX-1). */
			priceAt?: (charsOver4Tokens: number) => number;
			/**
			 * Whether the next fold's summary can ride the main route's cached prefix: the summary runs on the chat route
			 * and the last request passes the live-prefix request checks. The fold still weighs price and fit (MD9).
			 */
			livePrefixSummary?: () => boolean;
			/** The compiled system prompt's sections and the compiler's token estimate of each, in prompt order (S-87). */
			promptSections?: Array<{ id: string; tokenEstimate: number }>;
	  }
	| { status: "unavailable" | "unsupported"; reason: string };

/** Refreshes accounting only: no runtime initialization, model calls or I/O. */
export type BudgetProvider = () => BudgetInspection;

/**
 * The main route's live history capacity after fixed prompt and reserves,
 * and how much of it the conversation occupies. Null while the live budget
 * is unavailable or only a persisted measurement exists.
 */
export function liveHistoryBudget(budget: BudgetInspection): { usable: number; used: number } | null {
	if (
		budget.status !== "available" ||
		budget.view.historical ||
		!budget.view.breakdown ||
		budget.view.outputReserveTokens === null
	)
		return null;
	const view = budget.view;
	return {
		usable:
			(view.effectiveWindow ?? 0) -
			(view.outputReserveTokens ?? 0) -
			(view.breakdown?.systemPromptTokens ?? 0) -
			(view.breakdown?.toolSchemaTokens ?? 0) -
			64,
		used: (view.breakdown?.messageTokens ?? 0) + (view.breakdown?.pendingUserTokens ?? 0),
	};
}
