/**
 * Per-turn holder for the relevance scores the pre-turn pass resolved.
 *
 * It exists because the pass is async and both its readers are not. The prompt
 * builder wants memory's scores while it is composing the system prompt, and
 * the skills listing wants its own later in the same turn, inside a
 * synchronous tool handler. One awaited call at the turn boundary fills this,
 * and both readers take what is there.
 *
 * Subjects are supplied by the composition root rather than read here, so this
 * module stays clear of the memory store and the skill loader and can be
 * tested without either.
 */

import type { PrecomputedRanking } from "../../core/precomputed-rank.js";
import { inspectDecisionSite, type ResolveDeciderInput } from "./decision-sites.js";
import { type RelevanceSubject, scoreTurnRelevance } from "./relevance-pass.js";

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
}

export interface TurnRelevanceStore {
	/**
	 * Resolve this turn's scores. Awaited at the turn boundary, so it is the one
	 * place the harness pays for the pass, and it always settles: every failure
	 * clears the store rather than rejecting.
	 */
	refresh(taskText: string, signal?: AbortSignal): Promise<void>;
	memory(): PrecomputedRanking | undefined;
	skills(): PrecomputedRanking | undefined;
	/** Drop the scores, so a turn that never refreshed cannot read a stale ranking. */
	clear(): void;
}

export function createTurnRelevanceStore(options: TurnRelevanceStoreOptions): TurnRelevanceStore {
	let memory: PrecomputedRanking | undefined;
	let skills: PrecomputedRanking | undefined;
	const clear = (): void => {
		memory = undefined;
		skills = undefined;
	};
	return {
		memory: () => memory,
		skills: () => skills,
		clear,
		async refresh(taskText, signal) {
			// Last turn's scores are wrong for this one, so they go before the new
			// ones arrive rather than after. A pass that fails leaves both sites
			// ranking the way they did before the sites existed.
			clear();
			try {
				const input = options.resolve();
				if (input === null) return;
				// Binding is checked before either catalog is read. Reading the memory
				// store and loading every skill are the expensive part of this, and an
				// operator who bound nothing must not pay for them once a turn.
				const wantsMemory = inspectDecisionSite("memory", input).bound;
				const wantsSkills = inspectDecisionSite("skills", input).bound;
				if (!wantsMemory && !wantsSkills) return;
				const result = await scoreTurnRelevance(input, {
					task: taskText,
					memory: wantsMemory ? options.listMemory() : [],
					skills: wantsSkills ? options.listSkills() : [],
					...(signal !== undefined ? { signal } : {}),
				});
				memory = result.memory ?? undefined;
				skills = result.skills ?? undefined;
			} catch {
				// Reading settings, the registry or either catalog can throw. None of
				// that is worth a turn.
				clear();
			}
		},
	};
}
