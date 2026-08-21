/**
 * Working-set layer contract.
 *
 * The working set is what the model sees on the next request. The ledger is
 * durable, append-only truth. This layer decides which tool-result bodies and
 * thinking blocks leave the working set, records that decision as
 * `contextEviction` entries, and applies it as an in-memory projection when
 * the replay messages are built. Nothing here rewrites the ledger and nothing
 * here calls a model.
 *
 * Shared by the live engine and the replay-lite runner by construction: a
 * policy is a pure function of `PolicyInput`, so the same selection runs in
 * both places. Widening these types is an owner decision; workers build
 * against them.
 */

import type { WorkingSetPolicyId, WorkingSetSettings } from "../../../core/defaults.js";
import type {
	ContextEvictionEntry,
	ContextRecallEntry,
	EvictedItem,
	EvictionReason,
	EvictionTrigger,
	RecallTrigger,
	SessionEntry,
	WorkingSetRef,
} from "../../session/entries.js";

export { EVICTION_REASONS, EVICTION_TRIGGERS, RECALL_TRIGGERS } from "../../session/entries.js";
export type {
	ContextEvictionEntry,
	ContextRecallEntry,
	EvictedItem,
	EvictionReason,
	EvictionTrigger,
	RecallTrigger,
	WorkingSetPolicyId,
	WorkingSetRef,
	WorkingSetSettings,
};

/**
 * Ref keys index `WorkingSetView.evicted`. A key is the entry turnId
 * (`ref.entry`); `fold.ts` owns the `refKey` / `parseRefKey` helpers.
 */
/** What the fold knows about one evicted unit. */
export interface EvictedState {
	reason: EvictionReason;
	marker: string;
	by?: string;
	tokensFreed: number;
	/** turnId of the `contextEviction` entry that evicted it (the latest one, after churn). */
	evictedAtTurnId: string;
	policyId: string;
}

/**
 * The fold of every `contextEviction` / `contextRecall` entry on the active
 * path. A recall does not remove its key: the recalled body lives in the
 * recall tool result at the tail of the working set, the marker stays at the
 * original position so the prefix cache is untouched, and repeated recalls of
 * one ref are the churn signal.
 */
export interface WorkingSetView {
	evicted: ReadonlyMap<string, EvictedState>;
	/** Applied eviction events on the active path. */
	evictionEvents: number;
	/** Items evicted across all events, including re-evictions after recall. */
	itemsEvicted: number;
	/** Recall entries on the active path. `churn = recalls / itemsEvicted`. */
	recalls: number;
	/** Policy that produced the most recent event; null when none. */
	lastPolicyId: string | null;
	/** turnId of the most recent eviction event; null when none. */
	lastEvictionTurnId: string | null;
}

export const EMPTY_WORKING_SET_VIEW: WorkingSetView = Object.freeze({
	evicted: new Map<string, EvictedState>(),
	evictionEvents: 0,
	itemsEvicted: 0,
	recalls: 0,
	lastPolicyId: null,
	lastEvictionTurnId: null,
});

export interface PressureInput {
	/** Estimated tokens in the current working set (projected), same estimator as the live pressure check. */
	tokens: number;
	contextWindow: number;
	/** `compaction.threshold`. */
	threshold: number;
	/** `context.workingSet.target`: the ratio an applied event batches down to. */
	target: number;
}

/**
 * Everything a policy may look at. `entries` are the active-path entries the
 * model can currently see: after the latest `compactionSummary` cut, in ledger
 * order, as `selectVisibleEntries` in visible.ts produces them. They are NOT
 * projected: a policy must consult `view.evicted` to skip units that are
 * already out. The view is folded over the full active path, so a ref evicted
 * before a later compaction is still known. Token counts enter selection only
 * through `settings.minEvictableTokens` and the headroom arithmetic against
 * `pressure.target`; no rule may rank candidates by size or recency score.
 */
export interface PolicyInput {
	entries: ReadonlyArray<SessionEntry>;
	view: WorkingSetView;
	settings: WorkingSetSettings;
	pressure: PressureInput;
	/** chars/4 estimator shared with `context-accounting.ts`, so replay and live agree. */
	estimateTokens: (entry: SessionEntry) => number;
}

/** A unit the policy wants out, with the typed reason. Ordered: apply in this order, stop when headroom is met. */
export interface EvictionCandidate {
	ref: WorkingSetRef;
	reason: EvictionReason;
	by?: string;
}

export interface WorkingSetPolicy {
	readonly id: WorkingSetPolicyId;
	/**
	 * Select candidates. Must be pure and deterministic for a given input.
	 * Returns an empty array when nothing qualifies. Units already in
	 * `input.view.evicted` must not be returned.
	 */
	select(input: PolicyInput): ReadonlyArray<EvictionCandidate>;
}

/** Materialized selection: markers rendered, tokens estimated, ready to become a ledger entry. */
export interface EvictionPlan {
	policyId: WorkingSetPolicyId;
	items: ReadonlyArray<EvictedItem>;
	tokensBefore: number;
	tokensAfter: number;
}

/** Fields the caller adds when appending the plan as a ledger entry. */
export type ContextEvictionFields = Omit<ContextEvictionEntry, "turnId" | "parentTurnId" | "timestamp">;
export type ContextRecallFields = Omit<ContextRecallEntry, "turnId" | "parentTurnId" | "timestamp">;

/** Typed failure for recall by ref. */
export type RecallError =
	| { kind: "not_on_active_path"; ref: string; nearest: string | null }
	| { kind: "not_evicted"; ref: string; nearest: string | null }
	| { kind: "invalid_ref"; ref: string };

export interface RecallResult {
	ref: WorkingSetRef;
	/** The ledger entry whose body is readmitted. */
	entry: SessionEntry;
	/** Exact original body as the projection would have rendered it before eviction. */
	body: string;
	tokens: number;
	/** Present when the original result was offloaded; recall returns the pointer, never the file. */
	offloadPath?: string;
}
