/**
 * A structural policy is an ordered rung list plus a protection profile.
 *
 * `composePolicy` turns that description into a `WorkingSetPolicy`. The
 * composer owns everything a rung is not allowed to decide: it builds the
 * path index and the protection cutoff once, resolves the profile's pins,
 * runs every candidate through `isProtected`, refuses duplicates and units
 * that are already out, and keeps the running projection the age rung
 * stops on. The rungs only say which units qualify and why.
 *
 * Policy ids are the composition spelled out. The two shipped ids name
 * fixed lists (`structural-v1`, the recorded previous default, and
 * `structural-v2`, the master), and the replay CLI accepts three derived
 * forms so an ablation is reproducible from the command line: `<id>+<rung>`
 * appends a rung before the pressure rungs, `<id>-<rung>` drops one, and
 * `rungs:<a>/<b>/<c>` spells the whole list. Live settings accept only the
 * shipped ids.
 */

import type { WorkingSetPolicyId } from "../../../../core/defaults.js";
import type { EvictionReason, SessionEntry } from "../../../session/entries.js";
import type { EvictionCandidate, PolicyInput, WorkingSetPolicy } from "../contract.js";
import { tokensFreedByEviction } from "../engine.js";
import { protectionCutoffIndex } from "../horizon.js";
import { buildPathIndex, callPathsByToolCallId } from "../path-index.js";
import { isProtected } from "../protect.js";
import { profilePins, resolveWorkingSetProfile, settingsUnderProfile, type WorkingSetProfile } from "./profiles.js";
import { isRungId, RUNGS, type RungEmitter, type RungId } from "./rungs.js";

/** Rungs that look at pressure or that a composition keeps last; `+rung` inserts before them. */
const TAIL_RUNGS: ReadonlyArray<RungId> = ["thinking_turn_closed", "age_horizon"];

export const STRUCTURAL_V1_RUNGS: ReadonlyArray<RungId> = [
	"stale_after_mutation",
	"superseded_read",
	"failure_resolved",
	"superseded_call",
	"listing_consumed",
	"thinking_turn_closed",
	"age_horizon",
];

/**
 * The master composition: v1 plus the one new rung whose own replay row
 * moved the aggregate objective, `offloaded_body`, plus the churn pin. The
 * other three candidates stay available as rungs but not here: at the
 * shipped floor `diff_applied` cannot fire (every edit or write echo in the
 * recorded corpus is under 90 tokens), `search_narrowed` never found a
 * search whose every hit was later used, and `dispatch_receipt_settled` took
 * eight items on the real corpus without moving a metric. The pin cannot be
 * measured by replay (no corpus holds a recall entry); it enters as the one
 * signal the model itself emits.
 */
export const STRUCTURAL_V2_RUNGS: ReadonlyArray<RungId> = [
	"stale_after_mutation",
	"superseded_read",
	"failure_resolved",
	"superseded_call",
	"listing_consumed",
	"offloaded_body",
	"thinking_turn_closed",
	"age_horizon",
	"recalled_twice",
];

const SHIPPED: ReadonlyMap<string, ReadonlyArray<RungId>> = new Map([
	["structural-v1", STRUCTURAL_V1_RUNGS],
	["structural-v2", STRUCTURAL_V2_RUNGS],
]);

export interface ComposedPolicyOptions {
	/** Fixed profile; absent means the profile named by the policy input's settings. */
	profile?: WorkingSetProfile;
}

export function composePolicy(
	id: string,
	rungIds: ReadonlyArray<RungId>,
	options: ComposedPolicyOptions = {},
): WorkingSetPolicy {
	const rungs = rungIds.map((rungId) => {
		const rung = RUNGS.get(rungId);
		if (rung === undefined) throw new Error(`unknown working-set rung: ${rungId}`);
		return rung;
	});
	const pinsChurn = rungIds.includes("recalled_twice");
	return {
		// The live enum is the shipped ids; a composed id only ever reaches the replay harness.
		id: id as WorkingSetPolicyId,
		select(raw: PolicyInput): ReadonlyArray<EvictionCandidate> {
			const profile = options.profile ?? resolveWorkingSetProfile(raw.settings);
			const input: PolicyInput = { ...raw, settings: settingsUnderProfile(raw.settings, profile) };
			const { entries, view, estimateTokens } = input;
			const index = buildPathIndex(entries, { cwd: input.cwd });
			const callPaths = callPathsByToolCallId(entries);
			const cutoffIndex = protectionCutoffIndex(entries, input.settings);
			const pins = profilePins(profile, entries, index);
			const pinRecalledTwice = profile.pinRecalledTwice ?? pinsChurn;
			const candidates: EvictionCandidate[] = [];
			const claimed = new Set<string>();
			let freed = 0;

			const entryIndexOf = new Map<string, number>();
			for (let i = 0; i < entries.length; i += 1) {
				const entry = entries[i];
				if (entry !== undefined) entryIndexOf.set(entry.turnId, i);
			}

			const emit = ((turnId: string, reason: EvictionReason, by?: string): boolean => {
				if (claimed.has(turnId) || view.evicted.has(turnId)) return false;
				const entryIndex = entryIndexOf.get(turnId);
				if (entryIndex === undefined) return false;
				const entry: SessionEntry | undefined = entries[entryIndex];
				if (entry === undefined) return false;
				if (isProtected(entry, { entryIndex, cutoffIndex, input, index, pins, pinRecalledTwice })) return false;
				const candidate: EvictionCandidate = { ref: { entry: turnId }, reason, ...(by === undefined ? {} : { by }) };
				const tokens = tokensFreedByEviction(estimateTokens, entry, candidate, callPaths);
				// Priced here for the same reason `planEviction` refuses it: a unit
				// whose marker is as long as its body frees nothing, and the age
				// rung's headroom must not count it.
				if (tokens <= 0) return false;
				claimed.add(turnId);
				candidates.push(candidate);
				freed += tokens;
				return true;
			}) as RungEmitter;
			emit.projected = () => input.pressure.tokens - freed;

			// Newest-first within every rung, for the cost reason in charter 4.6:
			// evicting the youngest safe unit keeps the cold region after the
			// eviction point small, so the turn that pays for the event pays least.
			const newestFirst = [...index.observations].reverse();
			const rungInput = { input, index, cutoffIndex, newestFirst, ageOrder: profile.ageOrder };
			for (const rung of rungs) rung.run(rungInput, emit);
			return candidates;
		},
	};
}

function withoutTail(ids: ReadonlyArray<RungId>): { head: RungId[]; tail: RungId[] } {
	const head: RungId[] = [];
	const tail: RungId[] = [];
	for (const id of ids) (TAIL_RUNGS.includes(id) || id === "recalled_twice" ? tail : head).push(id);
	return { head, tail };
}

/**
 * Resolve a composition id. Returns null for an id this module does not
 * spell (`age-horizon` and the replay controls live elsewhere).
 */
export function resolveComposedPolicy(id: string, options: ComposedPolicyOptions = {}): WorkingSetPolicy | null {
	const shipped = SHIPPED.get(id);
	if (shipped !== undefined) return composePolicy(id, shipped, options);
	if (id.startsWith("rungs:")) {
		const ids = id
			.slice("rungs:".length)
			.split("/")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		if (ids.length === 0 || !ids.every(isRungId)) return null;
		return composePolicy(id, ids as RungId[], options);
	}
	const derived = /^([a-z0-9-]+?)([+-])([a-z_]+)$/.exec(id);
	if (derived === null) return null;
	const [, baseId, operator, rungId] = derived;
	const base = baseId === undefined ? undefined : SHIPPED.get(baseId);
	if (base === undefined || rungId === undefined || !isRungId(rungId)) return null;
	if (operator === "-")
		return composePolicy(
			id,
			base.filter((existing) => existing !== rungId),
			options,
		);
	if (base.includes(rungId)) return composePolicy(id, base, options);
	const { head, tail } = withoutTail(base);
	return composePolicy(id, [...head, rungId, ...tail], options);
}
