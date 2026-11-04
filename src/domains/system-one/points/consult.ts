/**
 * `consult`: the main agent asks the bound engine a typed question.
 *
 * The questions come from the agent, per call, so this is a factory rather than
 * a fixed definition. The value is the distribution the engine returned and
 * never a chosen option: a `pick` comes back as mass per option, not as a
 * winner, because the agent decides. There is no cut and no policy.
 */

import type { Abstention, Answer, DecisionPoint, PointQuestion, Question } from "../types.js";
import { isAnswered } from "../types.js";

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
			for (const [id, item] of Object.entries(questions)) {
				const value = reading(item.question, answers[id]);
				if (!("abstained" in value)) answered += 1;
				readings[id] = value;
			}
			return answered > 0 ? { answers: readings } : null;
		},
	};
}
