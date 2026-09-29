import type { PrecomputedRanking } from "../../core/precomputed-rank.js";
import type { RelevanceRanker } from "../system-one/rank.js";
import type { MemoryPromptReader, MemoryPromptRequest } from "./prompt-cache.js";

/**
 * The prompt builder's ranking source for memory.
 *
 * Memory is ranked only when the order decides what the prompt carries: more
 * eligible records than the section admits, and no ranking pinned earlier in
 * the session. Otherwise nothing is asked and the section keeps its base order.
 * The reader owns that judgment because it owns the pin, so the candidates come
 * from it. Every failure returns undefined, which is the order memory had
 * before a ranking existed.
 */
export function createMemoryRelevance(input: {
	reader: Pick<MemoryPromptReader, "rankingCandidates">;
	rank: RelevanceRanker;
}): (request: MemoryPromptRequest, signal?: AbortSignal) => Promise<PrecomputedRanking | undefined> {
	return async (request, signal) => {
		try {
			// The cheap check first: an unbound site must not cost a store read.
			if (!input.rank.bound()) return undefined;
			const candidates = input.reader.rankingCandidates(request);
			if (candidates === null) return undefined;
			const ranked = await input.rank({ use: "memory", need: request.taskText, candidates }, signal);
			return ranked === null ? undefined : { scores: ranked.scores, source: ranked.source };
		} catch {
			return undefined;
		}
	};
}
