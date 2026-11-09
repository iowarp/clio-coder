/**
 * What `research resume` rebuilds from the journal: the best commit, the iterations and spend already used, the trees
 * already measured, whether the A/A check ran, and the wall time earlier runs took. The journal is the only source;
 * nothing a dead process held in memory is needed, except the check artifacts, which the loop learns again by running
 * the checks on the best commit.
 */
import { budgetStop } from "./budget.js";
import { foldJournal } from "./report.js";
import type { ResearchCampaign, ResearchCost, ResearchJournalEvent } from "./types.js";

export interface ResearchResumeState {
	best: string;
	iterations: number;
	costs: ResearchCost[];
	/** Trees earlier iterations measured, or were about to: a change that reproduces one is a duplicate. */
	seenTrees: string[];
	/** The A/A check already ran and allowed the campaign; it is not measured again. */
	aaDone: boolean;
	/** Wall time earlier runs used, which the `maxWallMinutes` budget keeps counting. */
	elapsedMs: number;
}

export type ResearchResumePlan =
	| { ok: true; state: ResearchResumeState; interrupted: number[] }
	| { ok: false; reason: string };

/** Never graded, so their tree was not really measured and a later iteration may produce it again. */
const UNGRADED = new Set(["interrupted", "deadline"]);

function stamp(event: ResearchJournalEvent): number | null {
	const ms = Date.parse(event.at);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Wall time the journal shows the campaign running: from each `opened` or `resumed` to the `stopped` that ended it,
 * or to the last event before the next resume when the process died without one.
 */
export function researchElapsedMs(events: ReadonlyArray<ResearchJournalEvent>): number {
	let total = 0;
	let since: number | null = null;
	let last: number | null = null;
	const close = (): void => {
		if (since !== null && last !== null && last > since) total += last - since;
		since = null;
	};
	for (const event of events) {
		const ms = stamp(event);
		if (ms === null) continue;
		if (event.type === "opened" || event.type === "resumed") {
			close();
			since = ms;
		}
		last = ms;
		if (event.type === "stopped") close();
	}
	close();
	return total;
}

/** Decide whether a campaign can go on and rebuild its loop state, or say why it cannot. */
export function planResearchResume(
	campaign: ResearchCampaign,
	events: ReadonlyArray<ResearchJournalEvent>,
	refHead: string | null,
): ResearchResumePlan {
	const view = foldJournal(campaign, events);
	if (view.stop?.reason === "noisy" || (view.aa !== null && !view.aa.allowed))
		return {
			ok: false,
			reason:
				"its A/A check already called a change, so its measurements cannot be trusted; start a new campaign with more --trials or --allow-noisy",
		};
	if (refHead === null) return { ok: false, reason: `${campaign.ref} no longer exists` };
	if (refHead !== view.best)
		return {
			ok: false,
			reason: `${campaign.ref} points at ${refHead.slice(0, 12)}, not the journal's best ${view.best.slice(0, 12)}; something else moved it`,
		};
	const interrupted = view.iterations.filter((entry) => entry.outcome === "running").map((entry) => entry.iteration);
	const skip = new Set([
		...interrupted,
		...view.iterations.filter((entry) => UNGRADED.has(entry.outcome)).map((entry) => entry.iteration),
	]);
	const seenTrees: string[] = [];
	for (const event of events) if (event.type === "committed" && !skip.has(event.iteration)) seenTrees.push(event.tree);
	const state: ResearchResumeState = {
		best: view.best,
		iterations: view.iterations.reduce((most, entry) => Math.max(most, entry.iteration), 0),
		costs: events.flatMap((event) => (event.type === "agent-finished" ? [event.cost] : [])),
		seenTrees,
		aaDone: view.aa !== null,
		elapsedMs: researchElapsedMs(events),
	};
	const spent = budgetStop(campaign.budget, state);
	if (spent !== null) return { ok: false, reason: `its budget is spent (${spent.reason}: ${spent.detail})` };
	return { ok: true, state, interrupted };
}
