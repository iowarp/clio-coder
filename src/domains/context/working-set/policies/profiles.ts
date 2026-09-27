/**
 * Protection profiles: what a kind of work never gives up, on top of the
 * predicates in `protect.ts` that hold for every session.
 *
 * A profile is the operator's statement about the shape of the session
 * (`context.workingSet.profile`). It may narrow the step horizon or the
 * low-yield floor, and it may pin units the absolute predicates would let
 * go: a data-analysis session keeps the last few bash outputs that printed
 * numbers, because the figures are the work; a web-design session keeps the
 * last read of every stylesheet and component under edit and lets bash
 * output leave first, because the file the model is shaping is what it
 * needs beside the edit. Pins are protection only. A profile never selects
 * a unit for eviction and never reorders the rungs; it can only make the
 * age rung look at bash output before anything else.
 *
 * Profiles are selected for the main agent only. Workers run their own
 * in-memory guard (`src/domains/context/worker/pressure.ts`) and never fold
 * the working set, so a profile bound to a worker role would be inert; the
 * binding is deliberately not offered until that changes.
 */

import type { WorkingSetProfileId, WorkingSetSettings } from "../../../../core/defaults.js";
import type { SessionEntry } from "../../../session/entries.js";
import type { PathIndex } from "../path-index.js";
import { toolResultPayload, toolResultText } from "../payload.js";

export interface WorkingSetProfile {
	readonly id: WorkingSetProfileId;
	/** Overrides `context.workingSet.protectLastSteps` when set. */
	readonly protectLastSteps?: number;
	/** Overrides `context.workingSet.minEvictableTokens` when set. */
	readonly minEvictableTokens?: number;
	/** Force the churn pin on whatever the policy says; undefined leaves it to the policy. */
	readonly pinRecalledTwice?: boolean;
	/** Keep the newest N bash-class results whose output printed numbers. */
	readonly pinLastNumericBash?: number;
	/** Keep the newest read of every file with one of these suffixes that a later edit or write touched. */
	readonly pinLastReadOfEdited?: ReadonlyArray<string>;
	/** How the age rung orders candidates. */
	readonly ageOrder: "ledger" | "bash_first";
}

export const WORKING_SET_PROFILES: Readonly<Record<WorkingSetProfileId, WorkingSetProfile>> = {
	default: { id: "default", ageOrder: "ledger" },
	"data-analysis": { id: "data-analysis", pinLastNumericBash: 3, ageOrder: "ledger" },
	"web-design": {
		id: "web-design",
		pinLastReadOfEdited: [".css", ".scss", ".tsx", ".jsx", ".html", ".vue", ".svelte"],
		ageOrder: "bash_first",
	},
};

export function resolveWorkingSetProfile(settings: Pick<WorkingSetSettings, "profile">): WorkingSetProfile {
	return WORKING_SET_PROFILES[settings.profile] ?? WORKING_SET_PROFILES.default;
}

/** The settings the composer runs under: the operator's values with the profile's overrides applied. */
export function settingsUnderProfile(settings: WorkingSetSettings, profile: WorkingSetProfile): WorkingSetSettings {
	return {
		...settings,
		...(profile.protectLastSteps === undefined ? {} : { protectLastSteps: profile.protectLastSteps }),
		...(profile.minEvictableTokens === undefined ? {} : { minEvictableTokens: profile.minEvictableTokens }),
	};
}

/** A line holding at least two numeric tokens is a figure, not a path or a version stamp. */
const NUMERIC_LINE = /\b\d+(?:\.\d+)?(?:e[-+]?\d+)?\b[^\n]*\b\d+(?:\.\d+)?(?:e[-+]?\d+)?\b/i;

function printedNumbers(entry: SessionEntry): boolean {
	if (entry.kind !== "message" || entry.role !== "tool_result") return false;
	return NUMERIC_LINE.test(toolResultText(toolResultPayload(entry.payload).result));
}

/**
 * A bash-class result whose output printed figures. A chain aggregate counts
 * when one of its bash-class members did, judged on that member's own output,
 * so the pin keeps the whole aggregate the way it keeps a lone command.
 */
function isNumericBash(entry: SessionEntry, index: PathIndex): boolean {
	const members = index.chainMembers.get(entry.turnId);
	if (members === undefined) return index.byRef.get(entry.turnId)?.op === "bash" && printedNumbers(entry);
	return members.some((member) => member.observation?.op === "bash" && NUMERIC_LINE.test(toolResultText(member.result)));
}

/**
 * The units a profile pins, as entry turnIds. Computed once per selection
 * over the visible entries, so every rung sees the same pins.
 */
export function profilePins(
	profile: WorkingSetProfile,
	entries: ReadonlyArray<SessionEntry>,
	index: PathIndex,
): ReadonlySet<string> {
	const pins = new Set<string>();
	if (profile.pinLastNumericBash !== undefined && profile.pinLastNumericBash > 0) {
		let kept = 0;
		for (let i = entries.length - 1; i >= 0 && kept < profile.pinLastNumericBash; i -= 1) {
			const entry = entries[i];
			if (entry === undefined || !isNumericBash(entry, index)) continue;
			pins.add(entry.turnId);
			kept += 1;
		}
	}
	if (profile.pinLastReadOfEdited !== undefined && profile.pinLastReadOfEdited.length > 0) {
		const suffixes = profile.pinLastReadOfEdited;
		for (const [path, observations] of index.byPath) {
			if (!suffixes.some((suffix) => path.endsWith(suffix))) continue;
			if (
				!observations.some(
					(observation) => (observation.op === "edit" || observation.op === "write") && !observation.isError,
				)
			)
				continue;
			for (let i = observations.length - 1; i >= 0; i -= 1) {
				const observation = observations[i];
				if (observation?.op === "read" && !observation.isError) {
					pins.add(observation.ref.entry);
					break;
				}
			}
		}
	}
	return pins;
}
