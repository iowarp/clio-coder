/**
 * Relevance ranking as one injected function, for the surfaces that list a
 * catalog too long to show in full: the skills listing, the memory section and
 * the gateway's capability find.
 *
 * Nothing waits for a ranking. The ranker answers from a cache of finished
 * rankings, keyed by the catalog, the question, the binding and the flow
 * restrictions; a miss returns null at once and starts one detached call that
 * fills the cache for the next listing that asks the same thing. It only
 * reorders: every miss, failure, abstention or slow engine leaves the caller
 * with the order it already had.
 */

import { createHash, randomUUID } from "node:crypto";
import type { CategoryGroup, Grouping } from "./hierarchy.js";
import { groupByCategory } from "./hierarchy.js";
import type { FollowUpTracker } from "./outcomes.js";
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
	/** The finished ranking for this request, or null; a miss starts the call that fills it. Never waits. */
	(request: RelevanceRankRequest): RelevanceRanking | null;
	/**
	 * Whether a ranking would be asked for now: the site is bound, and its build
	 * is not a shadowed one with nothing recording. A caller skips preparing
	 * candidates otherwise.
	 */
	asks(): boolean;
}

export interface RelevanceRankerInput {
	readonly systemOne: Pick<SystemOne, "run" | "bound" | "shadowed" | "describe"> & Partial<Pick<SystemOne, "limits">>;
	/** Whether `systemOne.record` keeps a dataset, the only thing an unfitted ranking produces. */
	readonly recording: () => boolean;
	/** The turn's task text, which is the need of an unfiltered listing. */
	readonly task: () => string;
	readonly tracker?: FollowUpTracker | undefined;
	/** The turn's inherited information-flow restrictions, passed to every ranking call unread. */
	readonly flow?: () => unknown;
}

/** Finished rankings kept for reuse; a session asks about a handful of catalogs. */
const READY_RANKINGS = 32;

function digest(request: RelevanceRankRequest, task: string, binding: unknown, flow: unknown): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				request.use,
				request.need,
				task,
				request.candidates.map((c) => [
					c.id,
					c.summary,
					// Label and purpose are question wording; a change must not reuse a cached ranking.
					(c.categories ?? []).map((category) => [category.id, category.label, category.purpose]),
				]),
				// Another engine or model, or a narrower flow, must ask again rather than
				// reuse what was answered under the old ones.
				binding ?? null,
				flow ?? null,
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
	const flowOption = (flow: unknown): { flow?: unknown } => (flow !== undefined ? { flow } : {});
	const rankFlat = async (
		request: RelevanceRankRequest,
		task: string,
		ref: string,
		flow: unknown,
	): Promise<RelevanceRanking | null> => {
		const verdict = await input.systemOne.run(
			RELEVANCE_SITE,
			{ use: request.use, need: request.need, task, candidates: request.candidates },
			{ ref, ...flowOption(flow) },
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
		flow: unknown,
	): Promise<RelevanceRanking | null> => {
		const grouping = groupsFor(request.candidates);
		if ("abstain" in grouping) return null;
		const groups = new Map<string, CategoryGroup<RelevanceCandidate>>(grouping.groups.map((group) => [group.key, group]));
		const budget = new AbortController();
		const timer = setTimeout(
			() => budget.abort(new Error(`relevance hierarchy exceeded ${RELEVANCE_SITE.deadlineMs}ms`)),
			RELEVANCE_SITE.deadlineMs,
		);
		try {
			const clusters = await input.systemOne.run(
				RELEVANCE_CLUSTER_SITE,
				{
					use: request.use,
					need: request.need,
					task,
					groups: grouping.groups,
				},
				{ ref, signal: budget.signal, ...flowOption(flow) },
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
						{ ref, signal: budget.signal, ...flowOption(flow) },
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
		}
	};

	// Finished rankings, a null among them: an engine that had no opinion or ran
	// out of time is not asked the same question again. Oldest first.
	const ready = new Map<string, RelevanceRanking | null>();
	const pending = new Set<string>();
	const remember = (key: string, ranking: RelevanceRanking | null): void => {
		ready.delete(key);
		ready.set(key, ranking);
		while (ready.size > READY_RANKINGS) {
			const oldest = ready.keys().next().value;
			if (oldest === undefined) break;
			ready.delete(oldest);
		}
	};

	const fill = async (key: string, request: RelevanceRankRequest, task: string, flow: unknown): Promise<void> => {
		try {
			const ref = `rk_${randomUUID()}`;
			const limits = input.systemOne.limits?.("relevance", "relevance") ?? null;
			// Each candidate is its own yes/no, so the flat ask is bounded by the window
			// and the flat site's candidate cap, never by an option count. Past either,
			// the catalog's own categories are the only honest way to ask; a catalog
			// without them abstains, so the caller keeps its full baseline order rather
			// than a ranking of whichever entries happened to come first.
			const window = limits?.windowTokens ?? null;
			const flat =
				request.candidates.length <= RELEVANCE_MAX_CANDIDATES && (window === null || flatTokens(request, task) <= window);
			remember(key, flat ? await rankFlat(request, task, ref, flow) : await rankHierarchical(request, task, ref, flow));
		} catch {
			// A fill that failed leaves the key unanswered, so the next listing asks again.
		} finally {
			pending.delete(key);
		}
	};

	// An unfitted build never reorders, so with no dataset to feed a call is pure
	// spend: a catalog-sized request to a systemone server, or two to five requests
	// per candidate to an LLM engine. The build is rechecked once its last answer
	// ages out.
	const asks = (): boolean => {
		try {
			if (!input.systemOne.bound("relevance")) return false;
			return !input.systemOne.shadowed("relevance") || input.recording();
		} catch {
			return false;
		}
	};

	const rank = (request: RelevanceRankRequest): RelevanceRanking | null => {
		try {
			if (request.candidates.length === 0 || !asks()) {
				input.tracker?.unranked(request.use);
				return null;
			}
			const task = input.task();
			const flow = input.flow?.();
			const binding = input.systemOne.describe().find((info) => info.site === "relevance");
			const key = digest(request, task, binding, flow);
			const ranking = ready.get(key);
			if (ranking !== undefined) {
				if (ranking !== null) input.tracker?.ranked(request.use, ranking.ref, ranking.scores);
				else input.tracker?.unranked(request.use);
				return ranking;
			}
			if (!pending.has(key)) {
				pending.add(key);
				void fill(key, request, task, flow);
			}
			input.tracker?.unranked(request.use);
			return null;
		} catch {
			return null;
		}
	};
	return Object.assign(rank, { asks });
}
