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
 * from it. The prompt never waits: a ranking is used only if it already
 * finished, and every miss or failure returns undefined, which is the order
 * memory had before a ranking existed.
 */
export function createMemoryRelevance(input: {
	reader: Pick<MemoryPromptReader, "rankingCandidates">;
	rank: RelevanceRanker;
}): (request: MemoryPromptRequest) => PrecomputedRanking | undefined {
	return (request) => {
		try {
			// The cheap check first: a site that would not be asked must not cost a store read.
			if (!input.rank.asks()) return undefined;
			const candidates = input.reader.rankingCandidates(request);
			if (candidates === null) return undefined;
			const ranked = input.rank({ use: "memory", need: request.taskText, candidates });
			return ranked === null ? undefined : { scores: ranked.scores, source: ranked.source };
		} catch {
			return undefined;
		}
	};
}
