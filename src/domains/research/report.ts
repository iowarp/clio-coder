/**
 * Read models of a campaign for `research status|report|list` and the `/research` overlay. `summarizeCampaign` folds
 * the journal as written. `recomputeCampaign` regrades every measured iteration and the A/A check from the raw
 * samples with the recorded seed and says, per grade, whether the recomputation agrees with the journal.
 */
import { type SpendTotal, totalSpend } from "./budget.js";
import { grade } from "./grader.js";
import { listCampaignIds, readCampaign, readJournal, readSamples } from "./store.js";
import type {
	ResearchAgentAutonomy,
	ResearchArchiveReason,
	ResearchCampaign,
	ResearchCost,
	ResearchGateResult,
	ResearchGrade,
	ResearchHypothesisVerdict,
	ResearchJournalEvent,
	ResearchStopReason,
} from "./types.js";

export interface ResearchIterationView {
	iteration: number;
	parent: string;
	commit: string | null;
	changed: string[];
	agent: { exitCode: number | null; sessionId: string | null; outcome: string | null; summary: string } | null;
	/** The yolo run's audit: its pause, if any, and the calls it left for the operator. */
	autonomy: ResearchAgentAutonomy | null;
	cost: ResearchCost | null;
	samples: string | null;
	grade: ResearchGrade | null;
	gates: ResearchGateResult[];
	outcome: "ratcheted" | ResearchArchiveReason | "running";
	detail: string;
	hypothesis: string | null;
	hypothesisVerdict: ResearchHypothesisVerdict | null;
	claims: string[];
}

export interface ResearchCampaignView {
	campaign: ResearchCampaign;
	state: "running" | "stopped";
	stop: { reason: ResearchStopReason; detail: string; at: string } | null;
	best: string;
	aa: { grade: ResearchGrade; noisy: boolean; allowed: boolean; samples: string } | null;
	iterations: ResearchIterationView[];
	spend: SpendTotal;
	ratchets: number;
	unreadableJournalLines: number;
}

export function foldJournal(
	campaign: ResearchCampaign,
	events: ReadonlyArray<ResearchJournalEvent>,
	unreadable = 0,
): ResearchCampaignView {
	const iterations = new Map<number, ResearchIterationView>();
	let aa: ResearchCampaignView["aa"] = null;
	let stop: ResearchCampaignView["stop"] = null;
	let best = campaign.base;
	let ratchets = 0;
	const at = (iteration: number): ResearchIterationView | undefined => iterations.get(iteration);
	for (const event of events) {
		switch (event.type) {
			case "aa":
				aa = { grade: event.grade, noisy: event.noisy, allowed: event.allowed, samples: event.samples };
				break;
			case "iteration-started":
				iterations.set(event.iteration, {
					iteration: event.iteration,
					parent: event.parent,
					commit: null,
					changed: [],
					agent: null,
					autonomy: null,
					cost: null,
					samples: null,
					grade: null,
					gates: [],
					outcome: "running",
					detail: "",
					hypothesis: null,
					hypothesisVerdict: null,
					claims: [],
				});
				break;
			case "agent-finished": {
				const view = at(event.iteration);
				if (view === undefined) break;
				view.agent = {
					exitCode: event.exitCode,
					sessionId: event.sessionId,
					outcome: event.outcome,
					summary: event.summary,
				};
				view.cost = event.cost;
				view.autonomy = event.autonomy ?? null;
				break;
			}
			case "committed": {
				const view = at(event.iteration);
				if (view === undefined) break;
				view.commit = event.commit;
				view.changed = event.changed;
				break;
			}
			case "measured": {
				const view = at(event.iteration);
				if (view !== undefined) view.samples = event.samples;
				break;
			}
			case "graded": {
				const view = at(event.iteration);
				if (view === undefined) break;
				view.grade = event.grade;
				view.gates = event.gates;
				break;
			}
			case "recorded": {
				const view = at(event.iteration);
				if (view === undefined) break;
				view.hypothesis = event.hypothesis;
				view.hypothesisVerdict = event.verdict ?? null;
				view.claims = event.claims;
				break;
			}
			case "ratcheted": {
				const view = at(event.iteration);
				best = event.to;
				ratchets += 1;
				if (view === undefined) break;
				view.outcome = "ratcheted";
				view.detail = `${event.from.slice(0, 12)} -> ${event.to.slice(0, 12)}`;
				break;
			}
			case "archived": {
				const view = at(event.iteration);
				if (view === undefined) break;
				view.outcome = event.reason;
				view.detail = event.detail;
				break;
			}
			case "stopped":
				stop = { reason: event.reason, detail: event.detail, at: event.at };
				best = event.best;
				break;
			case "resumed":
				stop = null;
				best = event.best;
				break;
			case "opened":
				break;
		}
	}
	const list = [...iterations.values()].sort((a, b) => a.iteration - b.iteration);
	return {
		campaign,
		state: stop === null ? "running" : "stopped",
		stop,
		best,
		aa,
		iterations: list,
		spend: totalSpend(list.flatMap((view) => (view.cost === null ? [] : [view.cost]))),
		ratchets,
		unreadableJournalLines: unreadable,
	};
}

export function summarizeCampaign(project: string, id: string): ResearchCampaignView {
	const campaign = readCampaign(project, id);
	const journal = readJournal(project, id);
	return foldJournal(campaign, journal.events, journal.unreadable);
}

export function listCampaigns(project: string): Array<ResearchCampaignView | { id: string; error: string }> {
	return listCampaignIds(project).map((id) => {
		try {
			return summarizeCampaign(project, id);
		} catch (error) {
			return { id, error: error instanceof Error ? error.message : String(error) };
		}
	});
}

export interface RecomputedGrade {
	/** `aa` or the iteration number. */
	of: "aa" | number;
	samples: string;
	journal: ResearchGrade | null;
	recomputed: ResearchGrade;
	agrees: boolean;
}

function sameGrade(a: ResearchGrade | null, b: ResearchGrade): boolean {
	if (a === null) return false;
	const close = (x: number | null, y: number | null): boolean =>
		x === null || y === null ? x === y : Math.abs(x - y) <= 1e-12 * Math.max(1, Math.abs(x), Math.abs(y));
	return (
		a.verdict === b.verdict &&
		a.classification === b.classification &&
		close(a.baseMedian, b.baseMedian) &&
		close(a.candidateMedian, b.candidateMedian) &&
		close(a.delta, b.delta) &&
		(a.ci === null || b.ci === null ? a.ci === b.ci : close(a.ci.low, b.ci.low) && close(a.ci.high, b.ci.high))
	);
}

/** Regrade the A/A check and every measured iteration from its raw samples with the seed the journal recorded. */
export function recomputeCampaign(
	project: string,
	id: string,
): {
	view: ResearchCampaignView;
	grades: RecomputedGrade[];
	agrees: boolean;
} {
	const view = summarizeCampaign(project, id);
	const { campaign } = view;
	const regrade = (relative: string, seed: number): ResearchGrade => {
		const samples = readSamples(project, id, relative);
		return grade({
			direction: campaign.objective.direction,
			minImprovement: campaign.objective.minImprovement,
			base: samples.pairs.map((pair) => pair.base),
			candidate: samples.pairs.map((pair) => pair.candidate),
			seed,
			resamples: campaign.resamples,
		});
	};
	const grades: RecomputedGrade[] = [];
	if (view.aa !== null) {
		const recomputed = regrade(view.aa.samples, campaign.seed);
		grades.push({
			of: "aa",
			samples: view.aa.samples,
			journal: view.aa.grade,
			recomputed,
			agrees: sameGrade(view.aa.grade, recomputed),
		});
	}
	for (const iteration of view.iterations) {
		if (iteration.samples === null) continue;
		const recomputed = regrade(iteration.samples, campaign.seed + iteration.iteration);
		grades.push({
			of: iteration.iteration,
			samples: iteration.samples,
			journal: iteration.grade,
			recomputed,
			agrees: sameGrade(iteration.grade, recomputed),
		});
	}
	return { view, grades, agrees: grades.every((entry) => entry.agrees) };
}
