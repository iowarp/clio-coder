/**
 * Turn a policy's selection into something the session can append.
 *
 * `planEviction` is the whole decision: it asks the policy what should leave,
 * materializes each candidate into an `EvictedItem` (marker rendered, tokens
 * measured), and prices the result against the projection the model will
 * actually receive. It writes nothing and calls no model, so the live engine
 * and the replay-lite runner drive it identically.
 *
 * `buildEvictionFields` is the boring half: the plan plus the trigger facts,
 * shaped as the ledger entry minus the three fields the session owns
 * (`turnId`, `parentTurnId`, `timestamp`).
 */

import type { EvictedItem, SessionEntry } from "../../session/entries.js";
import type {
	ContextEvictionFields,
	EvictedState,
	EvictionCandidate,
	EvictionPlan,
	EvictionTrigger,
	PolicyInput,
	WorkingSetPolicy,
	WorkingSetView,
} from "./contract.js";
import { refKey } from "./fold.js";
import { renderMarker } from "./marker.js";
import { hasThinking, offloadPathOf, primaryPathOf, toolResultPayload, toolResultText } from "./payload.js";
import { projectWorkingSet } from "./project.js";

/**
 * The event has no turnId until `session.appendEntry` gives it one, and the
 * projection reads only `reason` and `marker`, so plan-time states carry this
 * placeholder rather than a fabricated id.
 */
const PENDING_EVENT_TURN_ID = "";

/**
 * The stub that replaces this unit's body, or null when there is nothing to
 * evict. Thinking eviction renders no marker at all: the reasoning simply
 * stops being replayed.
 */
function markerFor(entry: SessionEntry, candidate: EvictionCandidate): string | null {
	if (entry.kind !== "message") return null;
	if (entry.role === "assistant") return hasThinking(entry.payload) ? "" : null;
	if (entry.role !== "tool_result") return null;
	const payload = toolResultPayload(entry.payload);
	return renderMarker({
		ref: candidate.ref,
		reason: candidate.reason,
		by: candidate.by,
		toolName: payload.toolName,
		text: toolResultText(payload.result),
		offloadPath: offloadPathOf(payload),
		path: primaryPathOf(payload),
	});
}

function pendingState(candidate: EvictionCandidate, marker: string, policyId: string): EvictedState {
	return {
		reason: candidate.reason,
		marker,
		...(candidate.by === undefined ? {} : { by: candidate.by }),
		tokensFreed: 0,
		evictedAtTurnId: PENDING_EVENT_TURN_ID,
		policyId,
	};
}

/** A view holding exactly one item, for pricing that item on its own. */
function soloView(key: string, state: EvictedState): WorkingSetView {
	return {
		evicted: new Map([[key, state]]),
		// Zero events: pricing one body must not also stamp usage invalidation,
		// which would put the cost of a different mechanism in this item's total.
		evictionEvents: 0,
		itemsEvicted: 1,
		recalls: 0,
		lastPolicyId: null,
		lastEvictionTurnId: null,
	};
}

/**
 * The view this plan would produce. `evictionEvents` and `lastEvictionTurnId`
 * stay where they were on purpose: both totals are then measured under the same
 * usage-invalidation state, so `tokensBefore - tokensAfter` is exactly the
 * bodies this event removes and nothing else.
 */
function viewWithItems(view: WorkingSetView, items: ReadonlyArray<EvictedItem>, policyId: string): WorkingSetView {
	const evicted = new Map(view.evicted);
	for (const item of items) {
		evicted.set(refKey(item.ref), {
			reason: item.reason,
			marker: item.marker,
			...(item.by === undefined ? {} : { by: item.by }),
			tokensFreed: item.tokensFreed,
			evictedAtTurnId: PENDING_EVENT_TURN_ID,
			policyId,
		});
	}
	return { ...view, evicted, itemsEvicted: view.itemsEvicted + items.length };
}

function sumTokens(entries: ReadonlyArray<SessionEntry>, estimate: (entry: SessionEntry) => number): number {
	let total = 0;
	for (const entry of entries) total += estimate(entry);
	return total;
}

/**
 * What one candidate takes out of the working set: the entry as it stands now
 * minus the entry as the projection would render it. Zero when the candidate
 * does not apply to the entry, and never negative, because a marker longer than
 * the body it replaces is a bad trade, not a negative saving.
 *
 * Exported so a policy can do headroom arithmetic (`structural-v1` rung 6 needs
 * to know when to stop) against the same numbers `planEviction` will record.
 * A policy that priced evictions its own way would report headroom the ledger
 * then contradicts.
 */
export function tokensFreedByEviction(
	estimateTokens: (entry: SessionEntry) => number,
	entry: SessionEntry,
	candidate: EvictionCandidate,
): number {
	const marker = markerFor(entry, candidate);
	if (marker === null) return 0;
	const key = refKey(candidate.ref);
	const projected = projectWorkingSet([entry], soloView(key, pendingState(candidate, marker, "")))[0] ?? entry;
	return Math.max(0, estimateTokens(entry) - estimateTokens(projected));
}

export function planEviction(policy: WorkingSetPolicy, input: PolicyInput): EvictionPlan | null {
	const candidates = policy.select(input);
	if (candidates.length === 0) return null;

	const byTurnId = new Map<string, SessionEntry>();
	for (const entry of input.entries) byTurnId.set(entry.turnId, entry);

	const items: EvictedItem[] = [];
	const claimed = new Set<string>();
	for (const candidate of candidates) {
		const key = refKey(candidate.ref);
		// A policy is contractually forbidden from returning a unit that is
		// already out, and a duplicate inside one selection would double-count
		// the tokens it frees. Both are cheap to refuse here.
		if (input.view.evicted.has(key) || claimed.has(key)) continue;
		const entry = byTurnId.get(key);
		if (entry === undefined) continue;
		const marker = markerFor(entry, candidate);
		if (marker === null) continue;
		claimed.add(key);
		items.push({
			ref: candidate.ref,
			reason: candidate.reason,
			tokensFreed: tokensFreedByEviction(input.estimateTokens, entry, candidate),
			marker,
			...(candidate.by === undefined ? {} : { by: candidate.by }),
		});
	}
	if (items.length === 0) return null;

	return {
		policyId: policy.id,
		items,
		tokensBefore: sumTokens(projectWorkingSet(input.entries, input.view), input.estimateTokens),
		tokensAfter: sumTokens(
			projectWorkingSet(input.entries, viewWithItems(input.view, items, policy.id)),
			input.estimateTokens,
		),
	};
}

export function buildEvictionFields(
	plan: EvictionPlan,
	meta: { trigger: EvictionTrigger; pressureBefore: number | null; snapshotIdBefore: string | null },
): ContextEvictionFields {
	return {
		kind: "contextEviction",
		policyId: plan.policyId,
		trigger: meta.trigger,
		evicted: plan.items,
		tokensBefore: plan.tokensBefore,
		tokensAfter: plan.tokensAfter,
		pressureBefore: meta.pressureBefore,
		snapshotIdBefore: meta.snapshotIdBefore,
	};
}
