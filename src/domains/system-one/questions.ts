/**
 * Question builders, validation and the spec hash.
 *
 * A site's wording is part of what a fitted cut was measured against, so the
 * hash of a question's spec is what a dataset row carries to say which wording
 * produced an answer.
 */

import { createHash } from "node:crypto";
import type { Question } from "./types.js";

export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

/** A yes/no judgment. Both branches are described so no engine guesses the scale. */
export function yesNo(instructions: string, whenTrue: string, whenFalse: string): Question {
	return { type: "noul", instructions, criteria: { true: whenTrue, false: whenFalse } };
}

/** A pick from named options, each with the situation in which it applies. */
export function pick(instructions: string, options: Readonly<Record<string, string>>): Question {
	return { type: "choice", instructions, criteria: options };
}

/** A rating on an ordered ladder, lowest level first. */
export function rate(instructions: string, levels: ReadonlyArray<string>): Question {
	return { type: "score", instructions, criteria: levels };
}

function blank(text: unknown): boolean {
	return typeof text !== "string" || text.trim().length === 0;
}

/**
 * The first problem with a question, or null when it is well-formed. Engines
 * and the runner both call it, because a malformed question sent to a
 * `/v1/systemone` server costs a 422 for every sibling in the same request.
 */
export function validateQuestion(question: Question): string | null {
	if (blank(question.instructions)) return "instructions are empty";
	if (question.type === "noul") {
		if (blank(question.criteria.true)) return "noul criteria.true is empty";
		if (blank(question.criteria.false)) return "noul criteria.false is empty";
		return null;
	}
	if (question.type === "choice") {
		const keys = Object.keys(question.criteria);
		if (keys.length < 1 || keys.length > MAX_CHOICE_OPTIONS) {
			return `a choice needs 1 to ${MAX_CHOICE_OPTIONS} options, got ${keys.length}`;
		}
		for (const key of keys) {
			if (key.trim().length === 0) return "a choice option key is empty";
			// Assigning this key onto the distribution map rewrites its prototype.
			if (key === "__proto__") return "a choice option key is reserved: __proto__";
			if (blank(question.criteria[key])) return `choice option '${key}' has no description`;
		}
		return null;
	}
	if (question.type === "score") {
		const levels = question.criteria;
		if (!Array.isArray(levels) || levels.length < MIN_SCORE_LEVELS || levels.length > MAX_SCORE_LEVELS) {
			return `a score needs ${MIN_SCORE_LEVELS} to ${MAX_SCORE_LEVELS} levels`;
		}
		for (const [index, level] of levels.entries()) {
			if (blank(level)) return `score level ${index} is empty`;
		}
		return null;
	}
	return "unknown question type";
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
		return out;
	}
	return value;
}

/** `q:` plus the sha256 of the question as canonical JSON with sorted keys. */
export function specHash(question: Question): string {
	return `q:${createHash("sha256")
		.update(JSON.stringify(canonical(question)) ?? "")
		.digest("hex")}`;
}
