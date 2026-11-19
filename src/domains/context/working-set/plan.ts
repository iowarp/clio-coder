/**
 * One eviction record from the stages a fold checkpoint reached (SPEC §2.4):
 * S0's superseded selection and S1's policy selection, priced once and
 * materialized together.
 *
 * S0 selects first. S1 then selects against the request S0 leaves: the
 * estimate less what S0 frees, over a view where S0's units are already out,
 * so neither stage claims a unit twice and S1 stops at the same target it
 * would have reached alone. The union goes through head pricing in request
 * order (skipped when the request must fit) and is materialized by
 * `planEviction` as one selection. Last, every S0 item must still name a
 * visible cover and the S0 bytes must still meet the floor; a union that
 * broke either drops S0 and plans S1 alone, once.
 */

import type {
	EvictedState,
	EvictionCandidate,
	EvictionPlan,
	PolicyInput,
	WorkingSetPolicy,
	WorkingSetPolicyId,
	WorkingSetView,
} from "./contract.js";
import { planEviction } from "./engine.js";
import { callPathsByToolCallId } from "./path-index.js";
import { dropUnpricedHead } from "./policies/cache-price.js";
import {
	SUPERSEDED_FLOOR_BYTES,
	SUPERSEDED_POLICY_ID,
	type SupersededCandidate,
	supersededBytes,
} from "./superseded.js";

type Planner = (policy: WorkingSetPolicy, input: PolicyInput) => EvictionPlan | null;

export interface FoldPlanInput {
	/** S1's policy; null when the checkpoint reaches S0 only. */
	policy: (WorkingSetPolicy & { selectCandidates?: (input: PolicyInput) => ReadonlyArray<EvictionCandidate> }) | null;
	/** S0's selection; empty off an uncached route. */
	superseded: ReadonlyArray<SupersededCandidate>;
	input: PolicyInput;
	/** S1 alone, as the checkpoint planned it before S0 existed (the test seam). */
	planner?: Planner;
}

/** S0's part of a plan, for the stage entry the checkpoint writes. */
export type SupersededOutcome = { outcome: "none" | "held" | "dropped" } | { outcome: "planned"; items: number };

export interface FoldPlan {
	plan: EvictionPlan | null;
	superseded: SupersededOutcome;
	/** S1 placed at least one item in the record. */
	structural: boolean;
}

function withEvicted(view: WorkingSetView, plan: EvictionPlan): WorkingSetView {
	const evicted = new Map<string, EvictedState>(view.evicted);
	for (const item of plan.items)
		evicted.set(item.ref.entry, {
			...(item.alias === undefined ? {} : { alias: item.alias }),
			reason: item.reason,
			marker: item.marker,
			...(item.by === undefined ? {} : { by: item.by }),
			tokensFreed: item.tokensFreed,
			evictedAtTurnId: "",
			policyId: plan.policyId,
		});
	return { ...view, evicted };
}

/** Materialize a selection already made, under an internal stage id. */
export function planSelection(
	policyId: string,
	candidates: ReadonlyArray<EvictionCandidate>,
	input: PolicyInput,
): EvictionPlan | null {
	// The internal stage ids are not shipped policy ids; compose.ts names its composed ids the same way.
	return planEviction({ id: policyId as WorkingSetPolicyId, select: () => candidates }, input);
}

export function planFold(input: FoldPlanInput): FoldPlan {
	const { policy, input: policyInput } = input;
	const planS1 = (): EvictionPlan | null =>
		policy === null ? null : (input.planner ?? planEviction)(policy, policyInput);
	const visible = new Set(policyInput.entries.map((entry) => entry.turnId));
	const selected = input.superseded.filter((candidate) => visible.has(candidate.ref.entry));
	const alone = (superseded: SupersededOutcome): FoldPlan => {
		const plan = planS1();
		return { plan, superseded, structural: plan !== null };
	};
	if (selected.length === 0) return alone({ outcome: "none" });
	if (supersededBytes(selected) < SUPERSEDED_FLOOR_BYTES) return alone({ outcome: "held" });
	const first = planSelection(SUPERSEDED_POLICY_ID, selected, policyInput);
	if (first === null) return alone({ outcome: "dropped" });
	let structural: ReadonlyArray<EvictionCandidate> = [];
	if (policy !== null) {
		const after: PolicyInput = {
			...policyInput,
			view: withEvicted(policyInput.view, first),
			pressure: { ...policyInput.pressure, tokens: first.tokensAfter },
		};
		structural = policy.selectCandidates ? policy.selectCandidates(after) : policy.select(after);
	}
	const order = new Map(policyInput.entries.map((entry, index) => [entry.turnId, index]));
	const at = (candidate: EvictionCandidate) => order.get(candidate.ref.entry) ?? -1;
	const union = [...selected, ...structural].sort((a, b) => at(a) - at(b));
	const priced = policyInput.pressure.forced
		? union
		: dropUnpricedHead(union, policyInput, callPathsByToolCallId(policyInput.entries));
	const s1Ids = new Set(structural.map((candidate) => candidate.ref.entry));
	const policyId = policy !== null && priced.some((candidate) => s1Ids.has(candidate.ref.entry)) ? policy.id : null;
	const plan = planSelection(policyId ?? SUPERSEDED_POLICY_ID, priced, policyInput);
	const s0ById = new Map(selected.map((candidate) => [candidate.ref.entry, candidate]));
	const items = plan?.items ?? [];
	const out = new Set(items.map((item) => item.ref.entry));
	const kept = items.flatMap((item) => {
		const candidate = s0ById.get(item.ref.entry);
		return candidate === undefined ? [] : [candidate];
	});
	const covered = kept.every((candidate) => !policyInput.view.evicted.has(candidate.by) && !out.has(candidate.by));
	if (plan === null || !covered || supersededBytes(kept) < SUPERSEDED_FLOOR_BYTES) return alone({ outcome: "dropped" });
	return {
		plan,
		superseded: { outcome: "planned", items: kept.length },
		structural: kept.length < items.length,
	};
}
