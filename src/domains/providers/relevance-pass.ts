/**
 * The memory and skills relevance judgments, as two pre-turn sites.
 *
 * Both rank a catalog against the turn's task: memory reads its scores at
 * prompt build, and skills holds onto its own until the model asks for the
 * listing, because that handler is synchronous and cannot await anything. Both
 * consume the scores through the precomputed ranking path, so neither has to
 * become async to gain a ranking. The call itself belongs to the pre-turn
 * brief, which batches these questions with every other bound pre-turn site.
 *
 * An unbound site, a refused connection, a malformed answer and an abstention
 * all produce the same thing: no score for that candidate, which leaves it
 * exactly where the caller's own order put it.
 */

import type { PrecomputedRanking } from "../../core/precomputed-rank.js";
import type { ResolveDeciderInput } from "./decision-sites.js";
import { isTrue, yesNo } from "./decisions.js";
import { type PreTurnAsk, type PreTurnSite, runPreTurnBrief } from "./pre-turn-brief.js";
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

/** Code points of one candidate's summary. */
const MAX_SUMMARY_CHARS = 240;

/**
 * Candidates per site in one pass.
 *
 * State carries each candidate's text once and the questions reference it by
 * id, so a pass costs roughly `task + sum(summaries)` rather than repeating the
 * evidence per question. That is linear in the catalog, not quadratic, but
 * still linear: a measured four-candidate pass spent 593 input tokens, almost
 * all of it candidate text, so the request grows at roughly 60 tokens per
 * additional candidate at the summary bound above.
 *
 * 24 per site keeps a worst-case pass near 2k input tokens and inside one
 * round trip, which is the point of batching. A store larger than that is
 * already being cut by the token budget and the item limit downstream, so the
 * candidates past this bound would be ranked and then discarded anyway. They
 * are dropped before the request instead, and they rank as abstentions, which
 * leaves them exactly where the caller's own order put them.
 */
const MAX_SUBJECTS = 24;

type RelevanceSite = "memory" | "skills";

export interface RelevanceSubject {
	/**
	 * Stable key the caller ranks by; scores come back under it.
	 *
	 * The score follows the text behind the id, which a control run confirmed by
	 * swapping two summaries and watching their scores swap with them. The id is
	 * not inert, though: the same text scored differently under two ids, so
	 * nothing here may assume ids are semantically neutral. Callers pass the
	 * identifier they already rank by and do not invent a synthetic one.
	 */
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
function askFor(subjects: ReadonlyArray<RelevanceSubject>): PreTurnAsk | null {
	const bound = subjects.slice(0, MAX_SUBJECTS);
	if (bound.length === 0) return null;
	const questions: Record<string, DecisionQuestion> = {};
	const candidates: Record<string, string> = {};
	for (const subject of bound) {
		questions[subject.id] = yesNo(
			`Does candidate ${subject.id} help with this task?`,
			"Directly useful for the task described in state.task",
			"Unrelated to that task, or useful only by coincidence",
		);
		candidates[subject.id] = bounded(subject.summary, MAX_SUMMARY_CHARS);
	}
	return { questions, state: { candidates } };
}

/**
 * Read one site's scores out of its answers.
 *
 * The probability is the score, not the verdict: a confident "no" at 0.05 is a
 * real judgment that ranks last, while an undecided 0.52 produces no entry at
 * all and leaves the candidate where it was. `isTrue` is what separates the
 * two, because it returns null for exactly the undecided case.
 */
function scoresFrom(answers: Readonly<Record<string, DecisionAnswer>>, ask: PreTurnAsk): Record<string, number> {
	const scores: Record<string, number> = {};
	for (const id of Object.keys(ask.questions)) {
		const answer = answers[id];
		if (answer === undefined || answer.noul === undefined) continue;
		if (isTrue(answer, { minConfidence: MIN_CERTAINTY }) === null) continue;
		scores[id] = answer.noul;
	}
	return scores;
}

/** Scores keyed by candidate id. The ranking's source is stamped by whoever reads the brief. */
export type RelevanceScores = Readonly<Record<string, number>>;

/**
 * A relevance site over a catalog. `listSubjects` runs only when the site is
 * bound, because reading the memory store and loading every skill are the
 * expensive part and an operator who bound nothing must not pay for them.
 */
export function relevanceSite(
	site: RelevanceSite,
	listSubjects: () => ReadonlyArray<RelevanceSubject>,
): PreTurnSite<RelevanceScores> {
	return {
		site,
		version: RELEVANCE_PASS_VERSION,
		prepare: () => askFor(listSubjects()),
		read(answers, ask) {
			const scores = scoresFrom(answers, ask);
			return Object.keys(scores).length > 0 ? scores : null;
		},
	};
}

/**
 * Score everything this turn wants ranked, as a standalone brief over the two
 * relevance sites. The chat loop reaches the same sites through its brief
 * store together with every other pre-turn site.
 */
export async function scoreTurnRelevance(
	input: ResolveDeciderInput,
	request: RelevancePassRequest,
): Promise<TurnRelevance> {
	const sites = [relevanceSite("memory", () => request.memory), relevanceSite("skills", () => request.skills)];
	const brief = await runPreTurnBrief(input, sites, { task: request.task }, request.signal);
	const ranking = (site: RelevanceSite): PrecomputedRanking | null => {
		const answer = brief.get(site);
		return answer === undefined ? null : { scores: answer.value as RelevanceScores, source: answer.source };
	};
	return { memory: ranking("memory"), skills: ranking("skills") };
}
