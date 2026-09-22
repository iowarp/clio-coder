/**
 * Per-turn holder for every pre-turn decision, with typed readers for the two
 * relevance sites.
 *
 * The brief is async and its readers are not. The prompt builder wants
 * memory's scores while it is composing the system prompt, the skills listing
 * wants its own later in the same turn inside a synchronous tool handler, and
 * turn_start middleware wants every hint. One awaited call at the turn
 * boundary fills this, and every reader takes what is there.
 *
 * Subjects are supplied by the composition root rather than read here, so this
 * module stays clear of the memory store and the skill loader and can be
 * tested without either.
 */

import type { PrecomputedRanking } from "../../core/precomputed-rank.js";
import type { ResolveDeciderInput } from "./decision-sites.js";
import {
	createPreTurnBriefStore,
	type PreTurnBrief,
	type PreTurnEvidence,
	type PreTurnSite,
} from "./pre-turn-brief.js";
import { type RelevanceScores, type RelevanceSubject, relevanceSite } from "./relevance-pass.js";

export interface TurnRelevanceStoreOptions {
	/**
	 * Settings and the provider registry as they stand this turn, or null when
	 * the host has no authoritative snapshot yet. Null skips the pass.
	 */
	resolve: () => ResolveDeciderInput | null;
	/** Rankable memory records, cheapest-first; called only when a site is bound. */
	listMemory: () => ReadonlyArray<RelevanceSubject>;
	/** Rankable installed skills; called only when a site is bound. */
	listSkills: () => ReadonlyArray<RelevanceSubject>;
	/** Every other pre-turn site. They join the same request as memory and skills. */
	sites?: ReadonlyArray<PreTurnSite<unknown>>;
}

export interface TurnRelevanceStore {
	/**
	 * Resolve this turn's answers. Awaited at the turn boundary, so it is the one
	 * place the harness pays for the brief, and it always settles: every failure
	 * clears the store rather than rejecting. A bare string is the task alone.
	 */
	refresh(evidence: string | PreTurnEvidence, signal?: AbortSignal): Promise<void>;
	memory(): PrecomputedRanking | undefined;
	skills(): PrecomputedRanking | undefined;
	/** This turn's value for any registered site. */
	get<T>(site: PreTurnSite<T>): T | undefined;
	/** Every settled answer this turn. */
	current(): PreTurnBrief;
	/** The task text of the last refresh, for a mid-turn site that ranks against it. */
	task(): string;
	/** Every site this store asks, relevance sites first. */
	readonly sites: ReadonlyArray<PreTurnSite<unknown>>;
	/** Drop the answers, so a turn that never refreshed cannot read a stale one. */
	clear(): void;
}

export function createTurnRelevanceStore(options: TurnRelevanceStoreOptions): TurnRelevanceStore {
	const sites: ReadonlyArray<PreTurnSite<unknown>> = [
		relevanceSite("memory", options.listMemory),
		relevanceSite("skills", options.listSkills),
		...(options.sites ?? []),
	];
	const store = createPreTurnBriefStore({ resolve: options.resolve, sites });
	const ranking = (site: "memory" | "skills"): PrecomputedRanking | undefined => {
		const answer = store.current().get(site);
		return answer === undefined ? undefined : { scores: answer.value as RelevanceScores, source: answer.source };
	};
	let task = "";
	return {
		sites,
		task: () => task,
		refresh: (evidence, signal) => {
			const resolved = typeof evidence === "string" ? { task: evidence } : evidence;
			task = resolved.task;
			return store.refresh(resolved, signal);
		},
		memory: () => ranking("memory"),
		skills: () => ranking("skills"),
		get: (site) => store.get(site),
		current: () => store.current(),
		clear: () => store.clear(),
	};
}
