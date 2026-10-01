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
import type { RelevanceCandidate, RelevanceGroup, RelevanceUse } from "./sites/relevance.js";
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
				request.candidates.map((c) => [c.id, c.summary, c.group?.id ?? null]),
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

/**
 * The catalog's groups, or null when the candidates cannot be grouped honestly:
 * any entry without a category, a single group, or more groups than one
 * selection may offer. Null keeps the caller's local order.
 */
function groupsOf(
	candidates: ReadonlyArray<RelevanceCandidate>,
): Map<string, { group: RelevanceGroup; members: RelevanceCandidate[] }> | null {
	const groups = new Map<string, { group: RelevanceGroup; members: RelevanceCandidate[] }>();
	for (const candidate of candidates) {
		const group = candidate.group;
		if (group === undefined || group.id.trim().length === 0 || group.description.trim().length === 0) return null;
		const held = groups.get(group.id);
		if (held === undefined) groups.set(group.id, { group, members: [candidate] });
		else held.members.push(candidate);
	}
	return groups.size >= 2 && groups.size <= RELEVANCE_MAX_CLUSTERS ? groups : null;
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
	 * requests inside the flat site's one deadline. Entries of unselected groups,
	 * and of a selected group too large to ask in one request, get no score, which
	 * every caller reads as "keep its place", so local discovery still lists them.
	 * No recursion, no tournament, and no group is cut into chunks.
	 */
	const rankHierarchical = async (
		request: RelevanceRankRequest,
		task: string,
		ref: string,
		signal: AbortSignal | undefined,
	): Promise<RelevanceRanking | null> => {
		const groups = groupsOf(request.candidates);
		if (groups === null) return null;
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
					groups: [...groups.values()].map(({ group, members }) => ({ ...group, size: members.length })),
				},
				{ ref, signal: budget.signal, ...flowOption() },
			);
			if (clusters === null) return null;
			const chosen = clusters.value.selected
				.map((id) => groups.get(id))
				.filter(
					(entry): entry is NonNullable<typeof entry> =>
						entry !== undefined && entry.members.length <= RELEVANCE_MAX_GROUP,
				);
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
			return { scores, source: [...new Set([clusters.build, ...sources])].join(" + "), ref };
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
			// Each candidate is its own yes/no, so the flat ask is bounded by the window,
			// not by an option count. Past the window, or past the flat site's candidate
			// cap, the catalog's own groups are the only way to ask; without them a flat
			// ask that fits keeps its old behavior (the first RELEVANCE_MAX_CANDIDATES
			// scored, the rest keeping their places), and one that does not abstains.
			const window = limits?.windowTokens ?? null;
			const fits = window === null || flatTokens(request, task) <= window;
			const grouped = groupsOf(request.candidates) !== null;
			const ranking =
				grouped && (!fits || request.candidates.length > RELEVANCE_MAX_CANDIDATES)
					? await rankHierarchical(request, task, ref, signal)
					: fits
						? await rankFlat(request, task, ref, signal)
						: null;
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
