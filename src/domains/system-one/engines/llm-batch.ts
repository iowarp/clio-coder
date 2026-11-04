/**
 * The LLM readout: every question of one ask in one schema-bound request, answered
 * with labels.
 *
 * A label has no probability scale, so an answer is not a confidence. Its mass is
 * one-hot and the profile's readout says so, so nothing may read it as a probability.
 */

import type { EngineReply, Question } from "../types.js";

type RawAnswer = EngineReply["answers"][string];

/** Part of every batch build key. Bump it with any wording or schema change below. */
export const BATCH_PROMPT_VERSION = "b1";

const ABSTAIN = "unsure";

export interface Prompt {
	readonly system: string;
	readonly user: string;
}

/** The serialized state, shared by every question of one call. */
export function renderState(state: Readonly<Record<string, unknown>>): string {
	return JSON.stringify(state, null, 1) ?? "";
}

const SYSTEM_PROMPT = `You are a strict decision function. You receive a STATE and QUESTIONS. Each question lists the only labels it accepts and what each label means. Reply with ONLY a JSON object mapping every question id to one of its labels, or to "${ABSTAIN}" when the STATE does not decide that question. No explanation.`;

/** Room for the JSON punctuation of one answer line, in tokens. */
const TOKENS_PER_ANSWER = 8;
/** Headroom for a model that pretty-prints or a tokenizer that splits ids finely. */
const TOKENS_RESERVE = 32;

function labelsOf(question: Question): ReadonlyArray<readonly [label: string, meaning: string]> {
	if (question.type === "noul") {
		return [
			["yes", question.criteria.true],
			["no", question.criteria.false],
		];
	}
	if (question.type === "choice") return Object.entries(question.criteria);
	return question.criteria.map((text, index) => [String(index), text] as const);
}

/** A question with one option has no uncertainty, so it costs no words in the request. */
export function isDecided(question: Question): boolean {
	return question.type === "choice" && Object.keys(question.criteria).length === 1;
}

export function batchPrompt(stateText: string, questions: Readonly<Record<string, Question>>): Prompt {
	const lines = Object.entries(questions).map(([id, question]) => {
		const labels = labelsOf(question)
			.map(([label, meaning]) => `  ${label}: ${meaning}`)
			.join("\n");
		return `${id}: ${question.instructions}\n${labels}`;
	});
	return { system: SYSTEM_PROMPT, user: `STATE:\n${stateText}\n\nQUESTIONS:\n${lines.join("\n")}` };
}

export function batchSchema(questions: Readonly<Record<string, Question>>): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	for (const [id, question] of Object.entries(questions)) {
		properties[id] = { type: "string", enum: [...labelsOf(question).map(([label]) => label), ABSTAIN] };
	}
	return { type: "object", additionalProperties: false, required: Object.keys(questions), properties };
}

/** An upper bound on the reply: each id and its longest label, plus punctuation. */
export function batchMaxTokens(questions: Readonly<Record<string, Question>>): number {
	let chars = 0;
	for (const [id, question] of Object.entries(questions)) {
		const longest = Math.max(ABSTAIN.length, ...labelsOf(question).map(([label]) => label.length));
		chars += id.length + longest;
	}
	return TOKENS_RESERVE + Object.keys(questions).length * TOKENS_PER_ANSWER + Math.ceil(chars / 2);
}

function answerFrom(question: Question, label: unknown): RawAnswer | null {
	if (typeof label !== "string" || label === ABSTAIN) return null;
	const labels = labelsOf(question).map(([name]) => name);
	if (!labels.includes(label)) return null;
	if (question.type === "noul") return { type: "noul", noul: label === "yes" ? 1 : 0 };
	const probabilities = Object.fromEntries(labels.map((name) => [name, name === label ? 1 : 0]));
	return question.type === "choice"
		? { type: "choice", choice: label, probabilities }
		: { type: "score", score: Number(label), probabilities };
}

/** The first JSON object in a reply, which a server that ignored the schema may fence or introduce. */
function parseObject(text: string): Record<string, unknown> | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const parsed: unknown = JSON.parse(text.slice(start, end + 1));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		// A truncated or prose reply carries no answers, and the caller says so.
		return null;
	}
}

/**
 * Answers per question id, or null when the reply holds no JSON object. A label
 * outside a question's list, or the abstention, leaves that question unanswered.
 */
export function readBatchReply(
	text: string,
	questions: Readonly<Record<string, Question>>,
): Record<string, RawAnswer> | null {
	const parsed = parseObject(text);
	if (parsed === null) return null;
	const answers: Record<string, RawAnswer> = {};
	for (const [id, question] of Object.entries(questions)) {
		const answer = Object.hasOwn(parsed, id) ? answerFrom(question, parsed[id]) : null;
		if (answer !== null) answers[id] = answer;
	}
	return answers;
}

/** The answer to a question with one option, which needs no request. */
export function decidedAnswer(question: Question): RawAnswer | null {
	const only = labelsOf(question)[0]?.[0];
	return only === undefined ? null : answerFrom(question, only);
}
