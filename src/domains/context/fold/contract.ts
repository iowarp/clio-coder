import type { ModelTier } from "../../../core/model-tier.js";

/**
 * ContextFold vocabulary (CF-1). A checkpoint runs the fold stages in order;
 * each stage commits a ledger record, holds, finds nothing, or fails. Later
 * lanes build on these names; this module defines them and wires nothing.
 */

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

/**
 * The fold stages in checkpoint order. A value reuses the `context.pruned` stage
 * name where one exists, so a decision and its pruning event name one stage.
 */
export const FoldStage = {
	/** S0: results a later identical read covered. */
	superseded: "superseded",
	/** S1: structural working-set eviction. */
	structural: "working_set",
	/** S2: the step-boundary checkpoint a step turn starts from. */
	stepCheckpoint: "step_checkpoint",
	/** S3: the summary checkpoint. */
	summary: "llm_summary",
	/** Physical fit: the request cannot be sent at the size the fold reached. */
	stop: "stop",
} as const;
export type FoldStageId = (typeof FoldStage)[keyof typeof FoldStage];
export const FOLD_STAGE_IDS: ReadonlyArray<FoldStageId> = Object.values(FoldStage);

/** What one stage did at one checkpoint. */
export type FoldStageOutcome = "committed" | "held" | "none" | "failed";
export const FOLD_STAGE_OUTCOMES: ReadonlyArray<FoldStageOutcome> = ["committed", "held", "none", "failed"];

/** Where a fold runs: submit, between tool batches, overflow recovery, an operator command, a step start. */
export type FoldCheckpoint = "submit" | "tool_batch" | "overflow" | "operator" | "step";
export const FOLD_CHECKPOINTS: ReadonlyArray<FoldCheckpoint> = ["submit", "tool_batch", "overflow", "operator", "step"];

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
