/**
 * The p1 prompt: one question, one state, one letter.
 *
 * The state comes first and is byte-identical for every question about the
 * same object, so a server's prefix cache prefills it once and each further
 * question costs only its own tail. Anything that varies per question goes
 * after it. The wording is measured behavior, not decoration: changing it
 * changes what every fitted temperature means, so it bumps `PROMPT_VERSION`
 * and with it the build key.
 */

import type { Question } from "../types.js";

/** Part of every LLM build key. Bump it with any wording change below. */
export const PROMPT_VERSION = "p1";

export const SYSTEM_PROMPT =
	"You are a strict decision function. You receive a STATE and one QUESTION with lettered options. Reply with ONLY the single letter of the best option. No words, no punctuation, no explanation.";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** One letter per option, so a question with more options than this is read as a tournament. */
export const MAX_LETTERED_OPTIONS = LETTERS.length;
/** Group size for a tournament round; one under the letter limit keeps every group unambiguous. */
export const TOURNAMENT_GROUP_SIZE = 25;

function letterAt(index: number): string {
	return LETTERS[index] ?? "?";
}

/** The index a normalized token names, or -1 when it is not one of the first `count` letters. */
export function letterIndex(token: string, count: number): number {
	const index = token.length === 1 ? LETTERS.indexOf(token) : -1;
	return index >= 0 && index < count ? index : -1;
}

/** One answerable option: the id an answer reports, and the line the model reads. */
export interface OptionItem {
	readonly id: string;
	readonly line: string;
}

/** The options in declared order. A noul reads false then true; a score reads lowest level first. */
export function optionItems(question: Question): OptionItem[] {
	if (question.type === "noul") {
		return [
			{ id: "false", line: `false: ${question.criteria.false}` },
			{ id: "true", line: `true: ${question.criteria.true}` },
		];
	}
	if (question.type === "choice") {
		return Object.entries(question.criteria).map(([key, description]) => ({ id: key, line: `${key}: ${description}` }));
	}
	return question.criteria.map((text, index) => ({ id: String(index), line: `level ${index}: ${text}` }));
}

const TAILS = {
	noul: "Decide which option is true of the STATE.",
	choice: "Choose the single best option.",
	score: "Rate the STATE on the ordered levels.",
} as const;

/** The serialized state, shared by every request of one call. */
export function renderState(state: Readonly<Record<string, unknown>>): string {
	return JSON.stringify(state, null, 1) ?? "";
}

export interface Prompt {
	readonly system: string;
	readonly user: string;
}

export function renderPrompt(stateText: string, question: Question, ordered: ReadonlyArray<OptionItem>): Prompt {
	const options = ordered.map((item, index) => `${letterAt(index)}) ${item.line}`).join("\n");
	return {
		system: SYSTEM_PROMPT,
		user: `STATE:\n${stateText}\n\nQUESTION: ${question.instructions}\n${TAILS[question.type]}\nOptions:\n${options}\n\nAnswer with the option letter only.`,
	};
}

/** The schema a schema-bound vote is held to: one letter from the labels in play. */
export function voteSchema(count: number): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: false,
		required: ["a"],
		properties: { a: { type: "string", enum: [...LETTERS.slice(0, count)] } },
	};
}
