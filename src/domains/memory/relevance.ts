import { eligibleMemoryRecords } from "./operations.js";
import type { MemoryRecord, MemoryRetrievalOptions } from "./types.js";

/** Versioned, deterministic heuristic; not a semantic applicability or truth check. */
export const MEMORY_RELEVANCE_VERSION = "lexical-v1";
export const MEMORY_RELEVANCE_WEIGHTS = { taskTerm: 1, path: 8, symbol: 4 } as const;

export interface MemoryRelevanceInput {
	readonly taskText: string;
	readonly activePaths?: readonly string[];
	readonly activeSymbols?: readonly string[];
}

export interface RankedMemoryCandidate {
	readonly record: MemoryRecord;
	readonly score: number;
	readonly matches: {
		readonly taskTerms: readonly string[];
		readonly paths: readonly string[];
		readonly symbols: readonly string[];
	};
	readonly fallback: boolean;
}

const STOP_WORDS = new Set(["and", "are", "for", "from", "into", "the", "this", "that", "with", "use", "when"]);

function normalized(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

function terms(value: string): string[] {
	return [...new Set(normalized(value.replace(/([a-z])([A-Z])/g, "$1 $2")).match(/[\p{L}\p{N}]+/gu) ?? [])].filter(
		(term) => term.length >= 2 && !STOP_WORDS.has(term),
	);
}

function pathKey(value: string): string {
	return normalized(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * Gates are identical to legacy retrieval and run before scoring. Text features
 * use NFKC/lowercase exact Unicode terms; paths/symbols match whole lexical
 * features, never filesystem ancestry or fuzzy substrings. Task features are
 * bounded to 64 terms, 32 explicit paths, and 32 symbols in supplied order.
 * Evidence IDs and avoidWhen do not create positive relevance.
 *
 * One legacy-priority zero-overlap lesson gets an early opportunity after the
 * first positive hit. This can displace a relevant item and cannot guarantee
 * that general constraints fit a finite budget. All other ties retain legacy
 * verification/creation-time then ID order. No input record is mutated.
 */
export function rankMemoryByRelevance(
	records: ReadonlyArray<MemoryRecord>,
	options: Omit<MemoryRetrievalOptions, "tokenBudget">,
	input: MemoryRelevanceInput,
): RankedMemoryCandidate[] {
	const taskTerms = terms(input.taskText).slice(0, 64);
	const paths = [...new Set((input.activePaths ?? []).map(pathKey).filter(Boolean))].slice(0, 32);
	const symbols = [...new Set((input.activeSymbols ?? []).map(normalized).filter(Boolean))].slice(0, 32);
	const candidates = eligibleMemoryRecords(records, options).map((record): RankedMemoryCandidate => {
		const text = [record.key, record.lesson, ...record.appliesWhen].join("\n");
		const textTerms = new Set(terms(text));
		const textPaths = new Set(
			(text.match(/[\p{L}\p{N}_./\\:-]+/gu) ?? []).map((path) => pathKey(path.replace(/[.:]+$/, ""))),
		);
		const textSymbols = new Set(normalized(text).match(/[\p{L}\p{N}_$]+/gu) ?? []);
		const matches = {
			taskTerms: taskTerms.filter((term) => textTerms.has(term)),
			paths: paths.filter((path) => textPaths.has(path)),
			symbols: symbols.filter((symbol) => textSymbols.has(symbol)),
		};
		return {
			record,
			matches,
			fallback: false,
			score:
				matches.taskTerms.length * MEMORY_RELEVANCE_WEIGHTS.taskTerm +
				matches.paths.length * MEMORY_RELEVANCE_WEIGHTS.path +
				matches.symbols.length * MEMORY_RELEVANCE_WEIGHTS.symbol,
		};
	});
	// Stable sorting preserves the already established legacy tie ordering.
	candidates.sort((a, b) => b.score - a.score);
	if ((candidates[0]?.score ?? 0) > 0) {
		const fallbackIndex = candidates.findIndex((candidate) => candidate.score === 0);
		if (fallbackIndex >= 0) {
			const [fallback] = candidates.splice(fallbackIndex, 1);
			if (fallback !== undefined) candidates.splice(1, 0, { ...fallback, fallback: true });
		}
	}
	return candidates;
}
