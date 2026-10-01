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
	/**
	 * The catalog's own category for this entry (an MCP server, a capability
	 * namespace), when it has one. Only such metadata may group candidates for a
	 * bounded hierarchy; nothing is grouped by name order or invented similarity.
	 */
	readonly group?: RelevanceGroup;
}

/** A catalog category, described by the catalog that owns it. */
export interface RelevanceGroup {
	readonly id: string;
	readonly label: string;
	/** What the category's entries do, in the catalog's words. */
	readonly description: string;
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

/** Groups offered in one cluster selection; a catalog with more abstains to its own order. */
export const RELEVANCE_MAX_CLUSTERS = 32;
/** Groups whose entries are ranked after a selection, each in one request. */
export const RELEVANCE_MAX_SELECTED = 3;
/** Entries of one selected group ranked in its request; a larger group is left to local discovery. */
export const RELEVANCE_MAX_GROUP = 64;
/** Code points of one group's representative description. */
const MAX_GROUP_DESCRIPTION_CHARS = 240;

export interface ClusterObject {
	readonly use: RelevanceUse;
	readonly need: string;
	readonly task: string;
	/** The groups, each with its entry count, in the catalog's order. */
	readonly groups: ReadonlyArray<RelevanceGroup & { readonly size: number }>;
}

export interface ClusterValue {
	/** Up to `RELEVANCE_MAX_SELECTED` group ids, most fitting first. Empty never: no fitting group is no value. */
	readonly selected: ReadonlyArray<string>;
	readonly scores: Readonly<Record<string, number>>;
}

function offeredGroups(object: ClusterObject): ClusterObject["groups"] {
	const seen = new Set<string>();
	return object.groups.filter((group) => {
		if (group.id.trim().length === 0 || group.id === "__proto__" || seen.has(group.id)) return false;
		seen.add(group.id);
		return true;
	});
}

/**
 * Which catalog groups could hold what the need asks for. This is its own
 * question with its own task (`clusterSelect`), version and cut key: choosing a
 * category from its description is not judging an entry, so neither Jev's
 * `relevance.ranked` marker nor any entry-level measurement validates it. A
 * build selects groups only once `relevance.clusters` has a cut for it, and is
 * otherwise asked and recorded in shadow. Each group is an independent yes/no,
 * so "none of these" is every group answered no, which abstains.
 */
export const RELEVANCE_CLUSTER_SITE: SiteDefinition<ClusterObject, ClusterValue> = {
	id: "relevance",
	version: "relevance-cluster-v1",
	moment: "clusters",
	deadlineMs: 1500,
	taskOf: () => "clusterSelect",
	cutTask: () => "clusterSelect",
	state(object) {
		const task = boundedHead(object.task, MAX_NEED_CHARS);
		const need = boundedHead(object.need, MAX_NEED_CHARS) || task;
		const groups = offeredGroups(object);
		if (need.length === 0 || groups.length < 2 || groups.length > RELEVANCE_MAX_CLUSTERS) return null;
		return {
			need,
			...(task.length > 0 && task !== need ? { task } : {}),
			groups: Object.fromEntries(
				groups.map((group) => [
					group.id,
					`${boundedHead(group.label, 80)} (${group.size} entries): ${boundedHead(group.description, MAX_GROUP_DESCRIPTION_CHARS)}`,
				]),
			),
		};
	},
	questions(object) {
		const noun = NOUN[object.use];
		const questions: Record<string, Question> = {};
		for (const group of offeredGroups(object)) {
			questions[group.id] = yesNo(
				`Could a ${noun} in group ${group.id} of state.groups serve the need described in state.need?`,
				"The group's described purpose covers that need",
				"The group's described purpose is unrelated to that need",
			);
		}
		return questions;
	},
	read(answers, object, cuts) {
		const cut = cuts.cut("clusters");
		if (cut === undefined) return null;
		const scores: Record<string, number> = {};
		for (const group of offeredGroups(object)) {
			const answer = answers[group.id];
			if (answer === undefined || answer.type !== "noul" || answer.noul === undefined) continue;
			if (!Number.isFinite(answer.noul)) continue;
			scores[group.id] = answer.noul;
		}
		const selected = Object.entries(scores)
			.filter(([, score]) => score >= cut)
			.sort((left, right) => right[1] - left[1])
			.slice(0, RELEVANCE_MAX_SELECTED)
			.map(([id]) => id);
		return selected.length > 0 ? { selected, scores } : null;
	},
	summarize: (value) => ({ selected: value.selected.join(","), offered: Object.keys(value.scores).length }),
};
