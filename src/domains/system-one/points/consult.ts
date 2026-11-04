/**
 * `consult`: the main agent asks the bound engine a typed question.
 *
 * The questions come from the agent, per call, so this is a factory rather than
 * a fixed definition. The value is the distribution the engine returned and
 * never a chosen option: a `pick` comes back as mass per option, not as a
 * winner, because the agent decides. There is no cut and no policy.
 *
 * The filter form scores items the agent does not hold, and only ids and scores
 * come back, so the agent's context pays for what matched and nothing else.
 */

import { isTrue } from "../answers.js";
import type { ReadoutKind } from "../contract.js";
import { estimateTokens } from "../formation.js";
import { filterQuestions } from "../questions.js";
import type { Abstention, Answer, DecisionPoint, PointQuestion, Question, RouteInfo } from "../types.js";
import { isAnswered } from "../types.js";
import { probability } from "./bounds.js";

/**
 * The total across every route. The agent's turn waits on this, and it has to outlast
 * a hung route so the next one is still usable: two hung typed routes (5 s each) still
 * leave an LLM route its full 30 s, and a hung LLM route leaves another 15 s to answer.
 * Unmeasured: this is a bound from the kind timeouts in `engine-kinds.ts`, not a fit to
 * any latency anyone recorded.
 */
export const CONSULT_DEADLINE_MS = 45_000;

/**
 * Files carried as evidence, and code points of one file's head. The point's
 * bound governs, because a smaller state keeps engine latency and contamination
 * between questions down; the tool reads no more than this per file.
 */
export const CONSULT_MAX_FILES = 12;
export const CONSULT_MAX_FILE_CHARS = 6000;
const MAX_PATH_CHARS = 200;

export interface ConsultObject {
	/** The evidence the agent supplied. The engine sees this and nothing else. */
	readonly state: Readonly<Record<string, unknown>>;
	/** File contents by path, read by the caller, sent under `state.files`. */
	readonly files: Readonly<Record<string, string>>;
}

/** One question's reading, in the shape the consult tool has always returned. */
export type ConsultReading =
	| { readonly kind: "yesNo"; readonly pTrue: number; readonly certainty: number }
	| { readonly kind: "pick"; readonly distribution: Readonly<Record<string, number>>; readonly certainty: number }
	| {
			readonly kind: "rate";
			readonly position?: number;
			readonly distribution: Readonly<Record<string, number>>;
			readonly certainty: number;
	  }
	| { readonly kind: "yesNo" | "pick" | "rate"; readonly abstained: true; readonly reason?: string };

export interface ConsultValue {
	/** A reading per asked question. An abstention is marked, never dropped. */
	readonly answers: Readonly<Record<string, ConsultReading>>;
	/** What the numbers are, as the answering engine declares it. A `categorical` reading is a label, not a probability. */
	readonly readout?: ReadoutKind;
}

function rounded(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function roundedMap(values: Readonly<Record<string, number>> | undefined): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [key, value] of Object.entries(values ?? {})) {
		if (Number.isFinite(value)) out[key] = rounded(value);
	}
	return out;
}

function kindOf(question: Question): "yesNo" | "pick" | "rate" {
	return question.type === "noul" ? "yesNo" : question.type === "choice" ? "pick" : "rate";
}

/** The distribution only. A pick's winning key is left out on purpose: the agent picks. */
function reading(question: Question, given: Answer | Abstention | undefined): ConsultReading {
	const kind = kindOf(question);
	if (given !== undefined && "abstained" in given) return { kind, abstained: true, reason: given.abstained };
	const answer = isAnswered(given) ? given : undefined;
	if (answer === undefined || answer.type !== question.type) return { kind, abstained: true };
	const certainty = rounded(answer.certainty);
	if (question.type === "noul") {
		return answer.noul === undefined
			? { kind, abstained: true }
			: { kind: "yesNo", pTrue: rounded(answer.noul), certainty };
	}
	if (question.type === "choice") return { kind: "pick", distribution: roundedMap(answer.probabilities), certainty };
	const byRung: Record<string, number> = {};
	for (const [index, mass] of Object.entries(answer.probabilities ?? {})) {
		const rung = question.criteria[Number(index)];
		if (rung !== undefined && Number.isFinite(mass)) byRung[rung] = rounded(mass);
	}
	return {
		kind: "rate",
		...(answer.score !== undefined ? { position: rounded(answer.score) } : {}),
		distribution: byRung,
		certainty,
	};
}

function boundedFiles(files: Readonly<Record<string, string>>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [path, content] of Object.entries(files)) {
		if (Object.keys(out).length >= CONSULT_MAX_FILES) break;
		if (path === "__proto__") continue;
		out[[...path].slice(0, MAX_PATH_CHARS).join("")] = [...content.slice(0, CONSULT_MAX_FILE_CHARS * 2)]
			.slice(0, CONSULT_MAX_FILE_CHARS)
			.join("");
	}
	return out;
}

export function consultPoint(
	questions: Readonly<Record<string, PointQuestion>>,
): DecisionPoint<ConsultObject, ConsultValue> {
	return {
		id: "consult",
		version: "consult-v1",
		deadlineMs: CONSULT_DEADLINE_MS,
		state(object) {
			const files = boundedFiles(object.files);
			if (Object.keys(object.state).length === 0 && Object.keys(files).length === 0) return null;
			return { ...object.state, ...(Object.keys(files).length > 0 ? { files } : {}) };
		},
		questions: () => questions,
		read(answers) {
			const readings: Record<string, ConsultReading> = {};
			let answered = 0;
			let readout: ReadoutKind | undefined;
			for (const [id, item] of Object.entries(questions)) {
				const value = reading(item.question, answers[id]);
				if (!("abstained" in value)) answered += 1;
				readings[id] = value;
				const given = answers[id];
				if (isAnswered(given)) readout ??= given.readout;
			}
			return answered > 0 ? { answers: readings, ...(readout !== undefined ? { readout } : {}) } : null;
		},
	};
}

/**
 * The smallest window any usable route counts a whole request against, or null when
 * none declares one. Formation refuses such a request outright, and the state is built
 * once per ask, so an ask that fits this one is carried by every route and failover
 * still has somewhere to go. A per-question route needs no share here: each row is
 * judged alone and a row too large abstains, which its reader reports.
 */
export function smallestRequestWindow(routes: ReadonlyArray<RouteInfo>): number | null {
	let smallest: number | null = null;
	for (const route of routes) {
		if (route.problem !== undefined || route.windowCounts !== "whole-request") continue;
		const window = route.windowTokens;
		if (typeof window === "number" && (smallest === null || window < smallest)) smallest = window;
	}
	return smallest;
}

/** Item text across one filter ask, in code points. */
export const CONSULT_FILTER_MAX_CHARS = 64_000;

/** The yes boundary is the question's own, stated here once so every source reads the same claim. */
const FILTER_WHEN_TRUE = "The item as shown meets the criterion";
const FILTER_WHEN_FALSE = "The item as shown does not meet the criterion";
/** Room for one answer line in the reply, which shares the window with the prompt (`engines/llm-batch.ts`). */
const REPLY_TOKENS_PER_ITEM = 10;

export interface ConsultFilterObject {
	readonly source: string;
}

export interface ConsultFilterMatch {
	readonly id: string;
	/** Absent when the engine answered with a label, which has no scale. */
	readonly score?: number;
}

export interface ConsultFilterValue {
	/** Every item at or over the yes boundary, highest first. */
	readonly matches: ReadonlyArray<ConsultFilterMatch>;
	/** Items that got a usable reading, match or not. */
	readonly scored: ReadonlyArray<string>;
	/** Items that did not, with why. An abstention is never read as a low score. */
	readonly unscored: Readonly<Record<string, string>>;
	readonly readout: ReadoutKind;
}

function filterItemQuestions(
	criterion: string,
	items: Readonly<Record<string, string>>,
): Readonly<Record<string, PointQuestion>> {
	return filterQuestions({ instructions: criterion, whenTrue: FILTER_WHEN_TRUE, whenFalse: FILTER_WHEN_FALSE }, items);
}

/**
 * Which items one filter ask carries, in offered order: the total text bound and the
 * smallest whole-request window both hold, counted exactly as formation will count them,
 * plus the reply each item needs. Anything left out is the caller's to report.
 */
export function fitFilterItems(input: {
	readonly source: string;
	readonly criterion: string;
	readonly items: Readonly<Record<string, string>>;
	readonly window: number | null;
}): { readonly fitted: Record<string, string>; readonly overTotal: string[]; readonly overWindow: string[] } {
	const fitted: Record<string, string> = {};
	const overTotal: string[] = [];
	const overWindow: string[] = [];
	let chars = 0;
	let tokens = estimateTokens({ source: input.source });
	for (const [id, text] of Object.entries(input.items)) {
		const length = [...text].length;
		if (chars + length > CONSULT_FILTER_MAX_CHARS) {
			overTotal.push(id);
			continue;
		}
		const question = filterItemQuestions(input.criterion, { [id]: text })[id]?.question;
		const cost = estimateTokens(question) + estimateTokens(id) * 2 + REPLY_TOKENS_PER_ITEM;
		if (input.window !== null && tokens + cost > input.window) {
			overWindow.push(id);
			continue;
		}
		chars += length;
		tokens += cost;
		fitted[id] = text;
	}
	return { fitted, overTotal, overWindow };
}

/**
 * One independent yes/no per item under one criterion. A match is p >= 0.5, the
 * question's own boundary, so there is no table to tune and nothing to calibrate. The
 * item text goes to the engine alone: the value holds ids and scores.
 */
export function consultFilterPoint(
	criterion: string,
	items: Readonly<Record<string, string>>,
): DecisionPoint<ConsultFilterObject, ConsultFilterValue> {
	const questions = filterItemQuestions(criterion, items);
	return {
		id: "consult",
		version: "consult-filter-v1",
		deadlineMs: CONSULT_DEADLINE_MS,
		state: (object) => ({ source: object.source }),
		questions: () => questions,
		read(answers) {
			const scored: string[] = [];
			const unscored: Record<string, string> = {};
			const hits: Array<{ id: string; p: number }> = [];
			let readout: ReadoutKind | undefined;
			for (const id of Object.keys(questions)) {
				const given = answers[id];
				const answer = isAnswered(given) ? given : undefined;
				const p = probability(answer);
				if (answer === undefined || p === null) {
					unscored[id] = given !== undefined && "abstained" in given ? given.abstained : "the engine gave no usable answer";
					continue;
				}
				readout ??= answer.readout;
				scored.push(id);
				if (isTrue(answer) === true) hits.push({ id, p });
			}
			if (readout === undefined) return null;
			const labels = readout === "categorical";
			const matches = hits.sort((a, b) => b.p - a.p).map(({ id, p }) => (labels ? { id } : { id, score: rounded(p) }));
			return { matches, scored, unscored, readout };
		},
	};
}
