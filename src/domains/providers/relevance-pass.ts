/**
 * The one System One call a turn makes for its relevance judgments.
 *
 * Questions are independent, so a batch costs the same round trip whether it
 * carries three questions or thirty. The sites that rank what a turn carries
 * therefore ask together, once, before the turn: memory reads its scores
 * immediately at prompt build, and skills holds onto its own until the model
 * asks for the listing, because that handler is synchronous and cannot await
 * anything. Both consume the scores through the precomputed ranking path, so
 * neither has to become async to gain a ranking.
 *
 * Nothing here throws and nothing here blocks. An unbound site, a refused
 * connection, a malformed answer and an abstention all produce the same thing:
 * no score for that candidate, which leaves it exactly where the caller's own
 * order put it.
 */

import type { PrecomputedRanking } from "../../core/precomputed-rank.js";
import { inspectDecisionSite, type ResolveDeciderInput } from "./decision-sites.js";
import { type Decider, isTrue, yesNo } from "./decisions.js";
import type { DecisionAnswer, DecisionQuestion } from "./types/inference.js";

/** Bumped when the question wording changes, so a cached ranking does not outlive it. */
export const RELEVANCE_PASS_VERSION = "systemone-relevance-v1";

/**
 * How far off a coin-flip a `noul` must land before it counts as an opinion.
 *
 * A noul's certainty is its distance from 0.5 on the same axis every other
 * primitive reports, so 0.2 here abstains on anything inside 0.4..0.6. A
 * confident negative is not an abstention: it scores low and ranks last, which
 * is a judgment the caller asked for. Only the undecided middle holds its slot.
 */
const MIN_CERTAINTY = 0.2;

/** Code points of task text sent as evidence. Enough to say what the turn is doing. */
const MAX_TASK_CHARS = 600;
/** Code points of one candidate's summary. */
const MAX_SUMMARY_CHARS = 240;
/** Candidates per site in one pass, so a large store cannot size the request. */
const MAX_SUBJECTS = 24;

/** The sites this pass answers for. Routing resolves its own, on the dispatch path. */
const PASS_SITES = ["memory", "skills"] as const;
type PassSite = (typeof PASS_SITES)[number];

export interface RelevanceSubject {
	/** Stable key the caller ranks by; scores come back under it. */
	readonly id: string;
	/** One short line saying what the candidate is. Never file contents. */
	readonly summary: string;
}

export interface RelevancePassRequest {
	/** What the turn was asked to do. The only free text the pass sends. */
	readonly task: string;
	readonly memory: ReadonlyArray<RelevanceSubject>;
	readonly skills: ReadonlyArray<RelevanceSubject>;
	readonly signal?: AbortSignal;
}

/** Null for a site that is unbound, had nothing to rank, or got no usable answer. */
export interface TurnRelevance {
	readonly memory: PrecomputedRanking | null;
	readonly skills: PrecomputedRanking | null;
}

const NO_RELEVANCE: TurnRelevance = { memory: null, skills: null };

function bounded(value: string, maxCodePoints: number): string {
	const points = [...value.replace(/\s+/g, " ").trim()];
	return points.length <= maxCodePoints ? points.join("") : `${points.slice(0, maxCodePoints - 1).join("")}…`;
}

/**
 * One question per candidate, all against one body of state.
 *
 * The instruction names the candidate's key and nothing else. Its text lives in
 * a state field under that key, because interpolating the candidate into the
 * instruction would send the same evidence once per question and make the
 * request grow with the square of the catalog.
 */
function questionsFor(site: PassSite, subjects: ReadonlyArray<RelevanceSubject>): Record<string, DecisionQuestion> {
	const questions: Record<string, DecisionQuestion> = {};
	for (const subject of subjects) {
		questions[`${site}.${subject.id}`] = yesNo(
			`Does candidate ${subject.id} help with this task?`,
			"Directly useful for the task described in state.task",
			"Unrelated to that task, or useful only by coincidence",
		);
	}
	return questions;
}

function stateFor(request: RelevancePassRequest, sites: ReadonlyArray<PassSite>): object {
	const candidates: Record<string, string> = {};
	for (const site of sites) {
		for (const subject of request[site]) candidates[subject.id] = bounded(subject.summary, MAX_SUMMARY_CHARS);
	}
	return { task: bounded(request.task, MAX_TASK_CHARS), candidates };
}

/**
 * Read one site's scores out of a batch.
 *
 * The probability is the score, not the verdict: a confident "no" at 0.05 is a
 * real judgment that ranks last, while an undecided 0.52 produces no entry at
 * all and leaves the candidate where it was. `isTrue` is what separates the
 * two, because it returns null for exactly the undecided case.
 */
function scoresFor(
	site: PassSite,
	subjects: ReadonlyArray<RelevanceSubject>,
	answers: Record<string, DecisionAnswer>,
): Record<string, number> {
	const scores: Record<string, number> = {};
	for (const subject of subjects) {
		const answer = answers[`${site}.${subject.id}`];
		if (answer === undefined || answer.noul === undefined) continue;
		if (isTrue(answer, { minConfidence: MIN_CERTAINTY }) === null) continue;
		scores[subject.id] = answer.noul;
	}
	return scores;
}

interface BoundSite {
	readonly site: PassSite;
	readonly decider: Decider;
	readonly subjects: ReadonlyArray<RelevanceSubject>;
	/** Target and model, which is both the batching key and the reported source. */
	readonly source: string;
}

function boundSites(input: ResolveDeciderInput, request: RelevancePassRequest): BoundSite[] {
	const bound: BoundSite[] = [];
	for (const site of PASS_SITES) {
		const subjects = request[site].slice(0, MAX_SUBJECTS);
		if (subjects.length === 0) continue;
		const status = inspectDecisionSite(site, input);
		if (!status.bound) continue;
		bound.push({ site, decider: status.decider, subjects, source: `${status.targetId}/${status.model ?? "default"}` });
	}
	return bound;
}

/**
 * Score everything this turn wants ranked.
 *
 * Both sites normally name the same profile, and then they share one request.
 * They are separately bindable, though, so a settings file that points them at
 * different targets gets one request each rather than a batch that silently
 * asks the wrong model half its questions.
 */
export async function scoreTurnRelevance(
	input: ResolveDeciderInput,
	request: RelevancePassRequest,
): Promise<TurnRelevance> {
	let bound: BoundSite[];
	try {
		bound = boundSites(input, request);
	} catch {
		// Resolution reads settings and the provider registry, and a site that
		// cannot even be looked at is a site that is off.
		return NO_RELEVANCE;
	}
	if (bound.length === 0) return NO_RELEVANCE;

	const batches = new Map<string, BoundSite[]>();
	for (const entry of bound) {
		const existing = batches.get(entry.source);
		if (existing) existing.push(entry);
		else batches.set(entry.source, [entry]);
	}

	const results = await Promise.all(
		[...batches.values()].map(async (group) => {
			const sites = group.map((entry) => entry.site);
			const questions: Record<string, DecisionQuestion> = {};
			for (const entry of group) Object.assign(questions, questionsFor(entry.site, entry.subjects));
			try {
				const answers = await (group[0] as BoundSite).decider.ask(stateFor(request, sites), questions, {
					...(request.signal !== undefined ? { signal: request.signal } : {}),
				});
				return group.map((entry) => ({
					site: entry.site,
					ranking: { scores: scoresFor(entry.site, entry.subjects, answers), source: entry.source },
				}));
			} catch {
				// A refused connection, a timeout and a contract break all mean the
				// same thing to a caller: rank the way you did before.
				return [];
			}
		}),
	);

	const out: { memory: PrecomputedRanking | null; skills: PrecomputedRanking | null } = { memory: null, skills: null };
	for (const entry of results.flat()) {
		if (Object.keys(entry.ranking.scores).length > 0) out[entry.site] = entry.ranking;
	}
	return out;
}
