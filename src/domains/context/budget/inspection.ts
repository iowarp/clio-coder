import type { LiveBudgetView } from "./live-view.js";

/** A native-session accounting port, never inherited by a dispatched worker. */
export type BudgetInspection =
	| {
			status: "available";
			capability: "native";
			view: LiveBudgetView;
			/** The compiled system prompt's sections and their estimated sizes, in prompt order (S-87). */
			promptSections?: Array<{ id: string; tokens: number }>;
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
