/**
 * `relevance`: which catalog entries fit what the model or the turn needs.
 *
 * Skills, gateway capabilities and memory records sit in catalogs too long to
 * list in full, and the caller ranks them by local vocabulary first. A
 * paraphrase can still miss. This site scores the entries the caller pruned by
 * meaning, and the caller uses the scores only to reorder a listing or to add a
 * few related entries beside a query's own hits. It never removes an entry and
 * never reorders the entries a query matched.
 *
 * There is no probability threshold to fit, but a build still has to be
 * validated before its order reaches the operator. `relevance.ranked` in
 * `calibration.ts` is that marker: a build without it is asked and recorded in
 * shadow, and the listing keeps its own order.
 *
 * Each candidate's text is carried once in the state and named by key from its
 * question, so the request grows with the catalog rather than with candidates
 * times evidence.
 */

import { yesNo } from "../questions.js";
import type { Question, SiteDefinition } from "../types.js";
import { boundedHead } from "./bounds.js";

/** Entries scored in one call; the remainder stays available through local discovery. */
export const RELEVANCE_MAX_CANDIDATES = 256;
/** Code points of one description. */
const MAX_SUMMARY_CHARS = 240;
/** Code points of the need and of the turn's task. */
const MAX_NEED_CHARS = 600;
/**
 * How far off a coin-flip a noul must land before it counts as an opinion. A
 * confident negative is not an abstention: it scores low and ranks last, which
 * is a judgment the caller asked for. Only the undecided middle holds its slot.
 */
const MIN_CERTAINTY = 0.2;

export type RelevanceUse = "skills" | "capabilities" | "memory";

const NOUN: Readonly<Record<RelevanceUse, string>> = {
	skills: "skill",
	capabilities: "capability",
	memory: "memory entry",
};

export interface RelevanceCandidate {
	/**
	 * Stable key the caller ranks by; scores come back under it. The id is not
	 * inert: the same text scored differently under two ids, so the caller
	 * passes the identifier it already ranks by and invents no synthetic one.
	 */
	readonly id: string;
	/** One short line saying what the candidate is. Never file contents. */
	readonly summary: string;
}

export interface RelevanceObject {
	readonly use: RelevanceUse;
	/** What is being looked for right now: the find query, or the task itself for a listing. */
	readonly need: string;
	/** What the turn was asked to do, or empty when unknown. */
	readonly task: string;
	/** The candidates the caller pre-pruned lexically. */
	readonly candidates: ReadonlyArray<RelevanceCandidate>;
}

export interface RelevanceValue {
	/** Candidate id to probability of fitting. Absent means undecided. */
	readonly scores: Readonly<Record<string, number>>;
}

/** Candidates that can be asked about: unique, named, and never a key that rewrites a prototype. */
function subjects(object: RelevanceObject): RelevanceCandidate[] {
	const seen = new Set<string>();
	const out: RelevanceCandidate[] = [];
	for (const candidate of object.candidates) {
		if (out.length >= RELEVANCE_MAX_CANDIDATES) break;
		if (candidate.id.trim().length === 0 || candidate.id === "__proto__" || seen.has(candidate.id)) continue;
		seen.add(candidate.id);
		out.push(candidate);
	}
	return out;
}

export const RELEVANCE_SITE: SiteDefinition<RelevanceObject, RelevanceValue> = {
	id: "relevance",
	version: "relevance-v1",
	deadlineMs: 1500,
	state(object) {
		const task = boundedHead(object.task, MAX_NEED_CHARS);
		// With no query the task is the need, which is what an unfiltered listing is for.
		const need = boundedHead(object.need, MAX_NEED_CHARS) || task;
		const candidates = subjects(object);
		if (need.length === 0 || candidates.length === 0) return null;
		return {
			need,
			...(task.length > 0 && task !== need ? { task } : {}),
			candidates: Object.fromEntries(
				candidates.map((candidate) => [candidate.id, boundedHead(candidate.summary, MAX_SUMMARY_CHARS)]),
			),
		};
	},
	questions(object) {
		const noun = NOUN[object.use];
		const questions: Record<string, Question> = {};
		for (const candidate of subjects(object)) {
			questions[candidate.id] = yesNo(
				`Does ${noun} ${candidate.id} serve the need described in state.need?`,
				"Directly serves that need",
				"Unrelated to that need, or useful only by coincidence",
			);
		}
		return questions;
	},
	read(answers, object, cuts) {
		// Fitted is computed in `cutsFor` from the build's table, and the runner
		// records it on the call. Unvalidated builds return no value, so no caller
		// reorders and no listing claims to be judged by them.
		if (cuts.cut("ranked") === undefined) return null;
		const scores: Record<string, number> = {};
		for (const candidate of subjects(object)) {
			const answer = answers[candidate.id];
			if (answer === undefined || answer.type !== "noul" || answer.noul === undefined) continue;
			if (!Number.isFinite(answer.noul) || answer.certainty < MIN_CERTAINTY) continue;
			scores[candidate.id] = answer.noul;
		}
		return Object.keys(scores).length > 0 ? { scores } : null;
	},
	summarize: (value) => ({ scored: Object.keys(value.scores).length }),
};
