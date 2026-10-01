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
import type { CategoryGroup, Grouping } from "./hierarchy.js";
import { groupByCategory } from "./hierarchy.js";
import type { RelevanceCandidate, RelevanceUse } from "./sites/relevance.js";
import {
	RELEVANCE_CLUSTER_SITE,
	RELEVANCE_MAX_CANDIDATES,
	RELEVANCE_MAX_CLUSTERS,
	RELEVANCE_MAX_GROUP,
	RELEVANCE_SITE,
} from "./sites/relevance.js";
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
	/** Selected groups left unranked because they exceed one request and have no finer category. */
	readonly abstained?: ReadonlyArray<string>;
}

export interface RelevanceRanker {
	(request: RelevanceRankRequest, signal?: AbortSignal): Promise<RelevanceRanking | null>;
	/** Whether the `relevance` site has a usable binding now, so a caller can skip preparing candidates for nothing. */
	bound(): boolean;
}

export interface RelevanceRankerInput {
	readonly systemOne: Pick<SystemOne, "run" | "bound" | "shadowed"> & Partial<Pick<SystemOne, "limits">>;
	/** Whether `systemOne.record` keeps a dataset, the only thing an unfitted ranking produces. */
	readonly recording: () => boolean;
	/** The turn's task text, which is the need of an unfiltered listing. */
	readonly task: () => string;
	/** Identity of the running turn; null disables the per-turn cache. */
	readonly turnKey: () => string | null;
	readonly tracker?: FollowUpTracker | undefined;
	/** The turn's inherited information-flow restrictions, passed to every ranking call unread. */
	readonly flow?: () => unknown;
}

function digest(request: RelevanceRankRequest): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				request.use,
				request.need,
				request.candidates.map((c) => [
					c.id,
					c.summary,
					// Label and purpose are question wording; a change must not reuse a cached ranking.
					(c.categories ?? []).map((category) => [category.id, category.label, category.purpose]),
				]),
			]),
		)
		.digest("hex");
}

/** chars/4 of the flat relevance state, the estimate the runner's window check uses, with each summary at its cap. */
function flatTokens(request: RelevanceRankRequest, task: string): number {
	let chars = request.need.length + Math.min(task.length, 600) + 64;
	for (const candidate of request.candidates.slice(0, RELEVANCE_MAX_CANDIDATES)) {
		chars += candidate.id.length + Math.min(candidate.summary.length, 240) + 6;
	}
	return Math.ceil(chars / 4);
}

function groupsFor(candidates: ReadonlyArray<RelevanceCandidate>): Grouping<RelevanceCandidate> {
	return groupByCategory(candidates, { maxGroups: RELEVANCE_MAX_CLUSTERS, maxMembers: RELEVANCE_MAX_GROUP });
}

export function createRelevanceRanker(input: RelevanceRankerInput): RelevanceRanker {
	// Read per call: restrictions grow as the turn reads restricted sources.
	const flowOption = (): { flow?: unknown } => {
		const flow = input.flow?.();
		return flow !== undefined ? { flow } : {};
	};
	const rankFlat = async (
		request: RelevanceRankRequest,
		task: string,
		ref: string,
		signal: AbortSignal | undefined,
	): Promise<RelevanceRanking | null> => {
		const verdict = await input.systemOne.run(
			RELEVANCE_SITE,
			{ use: request.use, need: request.need, task, candidates: request.candidates },
			{ ref, ...(signal !== undefined ? { signal } : {}), ...flowOption() },
		);
		return verdict === null ? null : { scores: verdict.value.scores, source: verdict.build, ref };
	};

	/**
	 * Two levels, bounded: one cluster selection over the catalog's own groups,
	 * then one entry ranking per selected group, at most 1 + RELEVANCE_MAX_SELECTED
	 * requests inside the flat site's one deadline. Groups are the catalog's own
	 * categories, refined by finer categories where `groupByCategory` can. Entries
	 * of unselected groups get no score, which every caller reads as "keep its
	 * place", so local discovery still lists them; a selected group too large for
	 * one request is named in `abstained` rather than partly ranked. No recursion,
	 * no tournament, and no group is cut into chunks.
	 */
	const rankHierarchical = async (
		request: RelevanceRankRequest,
		task: string,
		ref: string,
		signal: AbortSignal | undefined,
	): Promise<RelevanceRanking | null> => {
		// A listener added below never fires for a signal that was already aborted.
		if (signal?.aborted === true) return null;
		const grouping = groupsFor(request.candidates);
		if ("abstain" in grouping) return null;
		const groups = new Map<string, CategoryGroup<RelevanceCandidate>>(
			grouping.groups.map((group) => [group.key, group]),
		);
		const budget = new AbortController();
		const timer = setTimeout(
			() => budget.abort(new Error(`relevance hierarchy exceeded ${RELEVANCE_SITE.deadlineMs}ms`)),
			RELEVANCE_SITE.deadlineMs,
		);
		const onAbort = () => budget.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const clusters = await input.systemOne.run(
				RELEVANCE_CLUSTER_SITE,
				{
					use: request.use,
					need: request.need,
					task,
					groups: grouping.groups,
				},
				{ ref, signal: budget.signal, ...flowOption() },
			);
			if (clusters === null) return null;
			const picked = clusters.value.selected
				.map((key) => groups.get(key))
				.filter((group): group is CategoryGroup<RelevanceCandidate> => group !== undefined);
			// A selected group too large for one request and with no finer category
			// abstains as a whole; ranking part of it would hide the rest.
			const abstained = picked.filter((group) => group.oversized).map((group) => group.key);
			const chosen = picked.filter((group) => !group.oversized);
			const verdicts = await Promise.all(
				chosen.map(({ members }) =>
					input.systemOne.run(
						RELEVANCE_SITE,
						{ use: request.use, need: request.need, task, candidates: members },
						{ ref, signal: budget.signal, ...flowOption() },
					),
				),
			);
			const scores: Record<string, number> = {};
			const sources = new Set<string>();
			for (const verdict of verdicts) {
				if (verdict === null) continue;
				Object.assign(scores, verdict.value.scores);
				sources.add(verdict.build);
			}
			if (Object.keys(scores).length === 0) return null;
			return {
				scores,
				source: [...new Set([clusters.build, ...sources])].join(" + "),
				ref,
				...(abstained.length > 0 ? { abstained } : {}),
			};
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	};

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
			const task = input.task();
			const limits = input.systemOne.limits?.("relevance", "relevance") ?? null;
			// Each candidate is its own yes/no, so the flat ask is bounded by the window
			// and the flat site's candidate cap, never by an option count. Past either,
			// the catalog's own categories are the only honest way to ask; a catalog
			// without them abstains, so the caller keeps its full baseline order rather
			// than a ranking of whichever entries happened to come first.
			const window = limits?.windowTokens ?? null;
			const flat =
				request.candidates.length <= RELEVANCE_MAX_CANDIDATES &&
				(window === null || flatTokens(request, task) <= window);
			const ranking = flat
				? await rankFlat(request, task, ref, signal)
				: await rankHierarchical(request, task, ref, signal);
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
