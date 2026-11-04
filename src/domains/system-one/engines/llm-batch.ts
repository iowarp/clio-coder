/**
 * The LLM readout: every question of one ask in one schema-bound request, answered
 * with labels.
 *
 * A label has no probability scale, so an answer is not a confidence. Its mass is
 * one-hot and the profile's readout says so, so nothing may read it as a probability.
 */

import { filterItemOf } from "../questions.js";
import type { EngineReply, Question } from "../types.js";

type RawAnswer = EngineReply["answers"][string];

/** Part of every batch build key. Bump it with any wording or schema change below. */
export const BATCH_PROMPT_VERSION = "b2";

const ABSTAIN = "unsure";

export interface Prompt {
	readonly system: string;
	readonly user: string;
}

/** The serialized state, shared by every question of one call. */
function renderState(state: Readonly<Record<string, unknown>>): string {
	return JSON.stringify(state, null, 1) ?? "";
}

/**
 * How a reply lays out its answers. `by-id` maps each id to its label and holds every id,
 * and a grammar for it stops compiling on the Messages API between 57 and 94 required
 * properties, under the 256 items one filter carries. `list` is one small schema at any
 * length and takes every id as data, so a route that holds replies through that API uses it.
 */
export type ReplyShape = "by-id" | "list";

const SYSTEM_INTRO =
	"You are a strict decision function. You receive a STATE and QUESTIONS. Each question lists the only labels it accepts and what each label means. Read the STATE and the question together and decide every question on its own.";

const REPLY_LINE: Readonly<Record<ReplyShape, string>> = {
	"by-id": `Reply with ONLY a JSON object mapping every question id to one of its labels, using "${ABSTAIN}" only when neither says enough to decide that question. No explanation.`,
	list: `Reply with ONLY a JSON object whose "answers" list holds one {"id", "label"} entry for every question id, in order, using the label "${ABSTAIN}" only when neither says enough to decide that question. No explanation.`,
};

/** Room for the JSON punctuation of one answer line, in tokens. */
const TOKENS_PER_ANSWER: Readonly<Record<ReplyShape, number>> = { "by-id": 8, list: 16 };
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

function labelLines(question: Question): string {
	return labelsOf(question)
		.map(([label, meaning]) => `  ${label}: ${meaning}`)
		.join("\n");
}

/**
 * A call whose questions all ask one rule of one item each, which reads as one rule over
 * items held in the state: the item is what the rule reads, and a state that lacked it told
 * a literal model to abstain on everything. Null for any other call.
 */
function filterOf(
	questions: Readonly<Record<string, Question>>,
): { rule: string; labels: string; items: Record<string, string> } | null {
	let filter: { rule: string; labels: string; items: Record<string, string> } | null = null;
	for (const [id, question] of Object.entries(questions)) {
		const parts = filterItemOf(question);
		if (parts === null) return null;
		const labels = labelLines(question);
		filter ??= { rule: parts.rule, labels, items: {} };
		if (parts.rule !== filter.rule || labels !== filter.labels) return null;
		filter.items[id] = parts.item;
	}
	return filter;
}

function replySchema(questions: Readonly<Record<string, Question>>, shape: ReplyShape): Record<string, unknown> {
	if (shape === "by-id") {
		const properties: Record<string, unknown> = {};
		for (const [id, question] of Object.entries(questions)) {
			properties[id] = { type: "string", enum: [...labelsOf(question).map(([label]) => label), ABSTAIN] };
		}
		return { type: "object", additionalProperties: false, required: Object.keys(questions), properties };
	}
	const labels = new Set<string>([ABSTAIN]);
	for (const question of Object.values(questions)) for (const [label] of labelsOf(question)) labels.add(label);
	const entry = {
		type: "object",
		additionalProperties: false,
		required: ["id", "label"],
		properties: { id: { type: "string" }, label: { type: "string", enum: [...labels] } },
	};
	return {
		type: "object",
		additionalProperties: false,
		required: ["answers"],
		properties: { answers: { type: "array", items: entry } },
	};
}

/** An upper bound on the reply: each id and its longest label, plus punctuation. */
function replyMaxTokens(
	questions: Readonly<Record<string, Question>>,
	wireIds: Readonly<Record<string, string>>,
	shape: ReplyShape,
): number {
	let chars = 0;
	for (const [id, question] of Object.entries(questions)) {
		const longest = Math.max(ABSTAIN.length, ...labelsOf(question).map(([label]) => label.length));
		chars += (wireIds[id] ?? id).length + longest;
	}
	return TOKENS_RESERVE + Object.keys(questions).length * TOKENS_PER_ANSWER[shape] + Math.ceil(chars / 2);
}

export interface Batch {
	readonly prompt: Prompt;
	readonly schema: Record<string, unknown>;
	readonly maxTokens: number;
	/** Answers per question id, or null when the reply holds no JSON object. */
	read(text: string): Record<string, RawAnswer> | null;
}

/** One request for every question of a call, and how to read what comes back. */
export function formBatch(
	state: Readonly<Record<string, unknown>>,
	questions: Readonly<Record<string, Question>>,
	shape: ReplyShape,
): Batch {
	const filter = filterOf(questions);
	// A filter's ids are paths and caller text, which cost output tokens on every line and
	// invite a respelled id, so a list reply takes them by position. The item text keeps what they said.
	const byPosition = filter !== null && shape === "list";
	const wireIds = Object.fromEntries(Object.keys(questions).map((id, index) => [id, byPosition ? `q${index + 1}` : id]));
	const wire = (id: string) => wireIds[id] ?? id;
	const user =
		filter !== null
			? `STATE:\n${renderState({ ...state, items: Object.fromEntries(Object.entries(filter.items).map(([id, item]) => [wire(id), item])) })}\n\nQUESTIONS:\nEvery id in STATE.items is one question, asked of that item alone: ${filter.rule}\n${filter.labels}`
			: `STATE:\n${renderState(state)}\n\nQUESTIONS:\n${Object.entries(questions)
					.map(([id, question]) => `${wire(id)}: ${question.instructions}\n${labelLines(question)}`)
					.join("\n")}`;
	return {
		prompt: { system: `${SYSTEM_INTRO} ${REPLY_LINE[shape]}`, user },
		schema: replySchema(questions, shape),
		maxTokens: replyMaxTokens(questions, wireIds, shape),
		read: (text) => readBatchReply(text, questions, wireIds),
	};
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

/** Labels per wire id from either shape. A route that did not hold the reply may answer in the other. */
function labelsByWireId(parsed: Record<string, unknown>): Record<string, unknown> {
	if (!Array.isArray(parsed.answers)) return parsed;
	const labels: Record<string, unknown> = {};
	for (const entry of parsed.answers as unknown[]) {
		const { id, label } = (typeof entry === "object" && entry !== null ? entry : {}) as { id?: unknown; label?: unknown };
		if (typeof id === "string" && !Object.hasOwn(labels, id)) labels[id] = label;
	}
	return labels;
}

/**
 * Answers per question id, or null when the reply holds no JSON object. A label
 * outside a question's list, or the abstention, leaves that question unanswered.
 */
function readBatchReply(
	text: string,
	questions: Readonly<Record<string, Question>>,
	wireIds: Readonly<Record<string, string>>,
): Record<string, RawAnswer> | null {
	const parsed = parseObject(text);
	if (parsed === null) return null;
	const labels = labelsByWireId(parsed);
	const answers: Record<string, RawAnswer> = {};
	for (const [id, question] of Object.entries(questions)) {
		const wire = wireIds[id] ?? id;
		const answer = Object.hasOwn(labels, wire) ? answerFrom(question, labels[wire]) : null;
		if (answer !== null) answers[id] = answer;
	}
	return answers;
}

/** The answer to a question with one option, which needs no request. */
export function decidedAnswer(question: Question): RawAnswer | null {
	const only = labelsOf(question)[0]?.[0];
	return only === undefined ? null : answerFrom(question, only);
}
