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

/** The lexical term set ranking uses, shared so recall scores bank entries the same way. */
export function memoryTerms(value: string): string[] {
	return [...new Set(normalized(value.replace(/([a-z])([A-Z])/g, "$1 $2")).match(/[\p{L}\p{N}]+/gu) ?? [])].filter(
		(term) => term.length >= 2 && !STOP_WORDS.has(term),
	);
}

/**
 * Words that say nothing about a record's subject. Kept apart from STOP_WORDS,
 * which would otherwise move every score the section and recall rank by.
 */
const FUNCTION_WORDS = new Set(
	"about after again all also any been before being but can could did does doing done down each few get got had has have having her here him his how its just more most nor not now off once one only other our out over own she should some such than their them then there these they too under until very was were what where which while who whom why will would you your don didn doesn isn wasn won sure please need want let give make set say tell thing things know think".split(
		" ",
	),
);
const TASK_LESSON_MIN_TERMS = 3;
const TASK_LESSON_MIN_COVERAGE = 0.5;
const TASK_LESSON_LIMIT = 2;
/** A pasted log or file cannot be about one lesson, and matching stays cheap at turn start. */
const TASK_TEXT_LIMIT = 4_096;

function subjectTerms(value: string): string[] {
	return memoryTerms(value).filter((term) => term.length >= 3 && !FUNCTION_WORDS.has(term));
}

/**
 * The lessons a task is plainly asking about: at least three subject terms in
 * the lesson's own text covering at least half of the task's. Conditions, keys
 * and evidence do not count, because promotion writes repository paths and
 * session ids there. Precision over recall: a miss costs what it cost before
 * this existed, and a false hit puts unrelated text in the turn's request.
 */
export function lessonsForTask<T extends { readonly text: string }>(task: string, lessons: ReadonlyArray<T>): T[] {
	if (task.length > TASK_TEXT_LIMIT) return [];
	const terms = subjectTerms(task);
	if (terms.length < TASK_LESSON_MIN_TERMS) return [];
	return lessons
		.map((lesson) => {
			const own = new Set(subjectTerms(lesson.text));
			return { lesson, matched: terms.filter((term) => own.has(term)).length };
		})
		.filter(({ matched }) => matched >= TASK_LESSON_MIN_TERMS && matched / terms.length >= TASK_LESSON_MIN_COVERAGE)
		.sort((a, b) => b.matched - a.matched)
		.slice(0, TASK_LESSON_LIMIT)
		.map(({ lesson }) => lesson);
}

/**
 * Coding vocabulary nearly every task and lesson shares. Two records that both
 * say "fix the test file" are not about the same thing, so these never count
 * toward the gate below. Ranking scores are unaffected.
 */
const GENERIC_TASK_TERMS = new Set(
	"add added adding build change changed changes check code error errors file files fix fixed fixing function line lines make new output run running test tests update use used using value work".split(
		" ",
	),
);
/**
 * Directory and extension fragments a path splits into. A task naming
 * `src/x.json` and a lesson naming `src/y.json` share layout, not a subject;
 * an exact path still matches through the path feature. Plural forms appear
 * folded (`scripts` is checked as `script`).
 */
const PATH_FRAGMENT_TERMS = new Set(
	"src lib docs doc app apps pkg cmd bin dist out script package internal vendor json yaml yml toml tsx jsx mjs cjs".split(
		" ",
	),
);
/** Distinctive subject terms a record must share with the turn to ride in unasked. */
export const MEMORY_GATE_MIN_TERMS = 2;
/** What a record the model kept leaving unused must share instead. */
export const MEMORY_GATE_DEMOTED_MIN_TERMS = 4;

/** Distinctive subject terms, plural folded, generic coding words dropped; shared with recall-use detection. */
export function memoryGateTerms(value: string): Set<string> {
	return new Set(
		subjectTerms(value)
			.map((term) => (term.length > 4 && term.endsWith("s") && !term.endsWith("ss") ? term.slice(0, -1) : term))
			.filter((term) => !GENERIC_TASK_TERMS.has(term) && !PATH_FRAGMENT_TERMS.has(term)),
	);
}

/**
 * The records a turn carries without asking: those sharing an active path or
 * symbol with it, or at least `MEMORY_GATE_MIN_TERMS` distinctive subject terms
 * of the lesson's own text and conditions. A record with no overlap is never
 * promoted, so an unrelated lesson stays out of the request; `memory_recall`
 * still reaches it. A `demoted` record, one the model kept leaving unused when
 * it was carried, needs `MEMORY_GATE_DEMOTED_MIN_TERMS` shared terms unless an
 * active path or symbol names it. Path fragments (`src`, `json`) are not subject
 * terms. Order is
 * the ranking's, fallback promotion excluded.
 */
export function selectRelevantMemory(
	records: ReadonlyArray<MemoryRecord>,
	options: Omit<MemoryRetrievalOptions, "tokenBudget">,
	input: MemoryRelevanceInput,
	demoted: ReadonlySet<string> = new Set(),
): RankedMemoryCandidate[] {
	const task = memoryGateTerms(input.taskText.slice(0, TASK_TEXT_LIMIT));
	return rankMemoryByRelevance(records, options, input)
		.filter((candidate) => {
			const own = memoryGateTerms([candidate.record.lesson, ...candidate.record.appliesWhen].join("\n"));
			const shared = [...task].filter((term) => own.has(term)).length;
			// An exact active path or symbol is the strongest signal the gate has, so it carries even a demoted record.
			if (candidate.matches.paths.length + candidate.matches.symbols.length > 0) return true;
			return shared >= (demoted.has(candidate.record.id) ? MEMORY_GATE_DEMOTED_MIN_TERMS : MEMORY_GATE_MIN_TERMS);
		})
		.map((candidate) => (candidate.fallback ? { ...candidate, fallback: false } : candidate))
		.sort((a, b) => b.score - a.score);
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
	const taskTerms = memoryTerms(input.taskText).slice(0, 64);
	const paths = [...new Set((input.activePaths ?? []).map(pathKey).filter(Boolean))].slice(0, 32);
	const symbols = [...new Set((input.activeSymbols ?? []).map(normalized).filter(Boolean))].slice(0, 32);
	const candidates = eligibleMemoryRecords(records, options).map((record): RankedMemoryCandidate => {
		const text = [record.key, record.lesson, ...record.appliesWhen].join("\n");
		const textTerms = new Set(memoryTerms(text));
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
