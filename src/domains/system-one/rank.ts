/**
 * Relevance ranking as one injected function, for the surfaces that list a
 * catalog too long to show in full: the skills listing, the memory section and
 * the gateway's capability find.
 *
 * The ranker asks the `relevance` site once per distinct question in a turn and
 * remembers the answer, so a model that lists skills three times pays once. It
 * only reorders: every failure, an unbound site, an abstention or a slow engine
 * returns null and the caller keeps the order it already had.
 */

import { createHash, randomUUID } from "node:crypto";
import type { FollowUpTracker } from "./outcomes.js";
import type { RelevanceCandidate, RelevanceUse } from "./sites/relevance.js";
import { RELEVANCE_SITE } from "./sites/relevance.js";
import type { SystemOne } from "./types.js";

export interface RelevanceRankRequest {
	readonly use: RelevanceUse;
	/** What is being looked for: a find query, or empty to rank against the turn's task. */
	readonly need: string;
	readonly candidates: ReadonlyArray<RelevanceCandidate>;
}

export interface RelevanceRanking {
	/** Candidate id to probability of fitting; an absent id is an abstention. */
	readonly scores: Readonly<Record<string, number>>;
	/** The answering build, for the footer line that says who ordered the list. */
	readonly source: string;
	/** Join key of the ranking call, carried by the follow-up outcome rows. */
	readonly ref: string;
}

export interface RelevanceRanker {
	(request: RelevanceRankRequest, signal?: AbortSignal): Promise<RelevanceRanking | null>;
	/** Whether the `relevance` site has a usable binding now, so a caller can skip preparing candidates for nothing. */
	bound(): boolean;
}

export interface RelevanceRankerInput {
	readonly systemOne: Pick<SystemOne, "run" | "bound" | "shadowed">;
	/** Whether `systemOne.record` keeps a dataset, the only thing an unfitted ranking produces. */
	readonly recording: () => boolean;
	/** The turn's task text, which is the need of an unfiltered listing. */
	readonly task: () => string;
	/** Identity of the running turn; null disables the per-turn cache. */
	readonly turnKey: () => string | null;
	readonly tracker?: FollowUpTracker | undefined;
}

function digest(request: RelevanceRankRequest): string {
	return createHash("sha256")
		.update(JSON.stringify([request.use, request.need, request.candidates.map((c) => [c.id, c.summary])]))
		.digest("hex");
}

export function createRelevanceRanker(input: RelevanceRankerInput): RelevanceRanker {
	// One answer per use, replaced when the turn or the question changes.
	const cache = new Map<RelevanceUse, { turn: string; key: string; ranking: RelevanceRanking | null }>();
	const rank = async (request: RelevanceRankRequest, signal?: AbortSignal): Promise<RelevanceRanking | null> => {
		try {
			if (request.candidates.length === 0 || !input.systemOne.bound("relevance")) return null;
			const turn = input.turnKey();
			const key = digest(request);
			const held = cache.get(request.use);
			if (turn !== null && held !== undefined && held.turn === turn && held.key === key) return held.ranking;
			// An unfitted build never reorders, so with no dataset to feed the call is
			// pure spend: a catalog-sized request to a systemone server, or two to five
			// requests per candidate to an LLM engine. The build is rechecked once its
			// last answer ages out.
			if (input.systemOne.shadowed("relevance") && !input.recording()) {
				input.tracker?.unranked(request.use);
				return null;
			}
			const ref = `rk_${randomUUID()}`;
			const verdict = await input.systemOne.run(
				RELEVANCE_SITE,
				{ use: request.use, need: request.need, task: input.task(), candidates: request.candidates },
				{ ref, ...(signal !== undefined ? { signal } : {}) },
			);
			const ranking: RelevanceRanking | null =
				verdict === null ? null : { scores: verdict.value.scores, source: verdict.build, ref };
			// A null is cached too: a slow engine must not be asked again by the next
			// listing in the same turn. A caller's abort is not the engine's answer.
			if (turn !== null && signal?.aborted !== true) cache.set(request.use, { turn, key, ranking });
			if (ranking !== null) input.tracker?.ranked(request.use, ref, ranking.scores);
			else if (signal?.aborted !== true) input.tracker?.unranked(request.use);
			return ranking;
		} catch {
			return null;
		}
	};
	return Object.assign(rank, { bound: () => input.systemOne.bound("relevance") });
}
