import type { ModelTier } from "../../../core/model-tier.js";

/** ContextFold vocabulary (CF-1): the cursor, owner, checkpoint and route facts a fold reads. */

/**
 * Where a fold reads the ledger: `hwm` is the turn id of the last ledger row when
 * the request was prepared, `leaf` the active-branch leaf it renders from.
 */
export interface FoldCursor {
	hwm: string | null;
	leaf: string | null;
}

/**
 * Whose ledger a fold reads: the session, and the fork binding when it is one, as
 * `continuityContextFromSession` derives both from the session meta.
 */
export interface FoldOwner {
	sessionId: string;
	fork?: { parentSessionId: string; parentTurnId: string };
}

/** Where a fold runs: submit, between tool batches, overflow recovery, an operator command, a step start. */
export type FoldCheckpoint = "submit" | "tool_batch" | "overflow" | "operator" | "step";

/** What the session route reports about itself, from its runtime resolution. */
export interface FoldRouteFacts {
	modelTier?: ModelTier;
	promptCaching?: boolean;
}

/** S0 runs only where the route does not cache prompts: no default ages a cached prefix. */
export function supersededStageApplies(route: FoldRouteFacts): boolean {
	return route.promptCaching === false;
}

/** S2 runs on a small model, or where the route does not cache prompts; independent of the S0 gate. */
export function stepCheckpointApplies(route: FoldRouteFacts): boolean {
	return route.modelTier === "small" || route.promptCaching === false;
}
