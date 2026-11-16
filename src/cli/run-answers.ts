import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AskUserAnswer, AskUserHandler, AskUserQuestion, AskUserResult } from "../tools/ask-user.js";

/**
 * `clio-coder run --answers <file.yaml>`: the author's answers, written ahead,
 * to the questions a headless run puts to them (WTF-P 0.8.3 B1). The file is
 *
 *   answers:
 *     - id: plan-introduction        # an extension question's checkpoint id
 *       choice: Approve this plan as shown
 *     - header: Which config?        # the question's header, exactly
 *       choice: [Project file]
 *       note: keep the user file as it is
 *     - match: "^Carry out this plan"  # a regex over the question text
 *       choice: Keep the plan (Recommended)
 *
 * Each entry names exactly one rule and gives a `choice` (option labels, one
 * or a list), a `note` (typed text: beside the choice, or the whole answer to
 * a question without options), or both. The first entry in file order whose
 * rule matches answers the question. A question no entry matches is never
 * answered for the author: the round is cancelled as unscripted and the run
 * ends, naming the question so the script can be extended.
 */

const RULE_KINDS = ["id", "header", "match"] as const;
type RuleKind = (typeof RULE_KINDS)[number];
const ENTRY_KEYS = new Set<string>([...RULE_KINDS, "choice", "note"]);

interface AnswerRule {
	kind: RuleKind;
	value: string;
	pattern?: RegExp;
	choice?: string[];
	note?: string;
	/** How the journal names this rule: `answers[2] header "Which config?"`. */
	label: string;
}

/** The question an answers file could not answer, as the run's closing message names it. */
export interface UnscriptedQuestion {
	question: string;
	header?: string;
	checkpoint?: string;
	/** Why it went unanswered: no rule matched, or the matching rule's choice is not on offer. */
	reason: string;
}

export interface ScriptedAnswers {
	/** The answers file as the operator named it, resolved to an absolute path. */
	readonly file: string;
	/** Answers ask_user rounds and extension interview steps from the file. */
	readonly ask: AskUserHandler;
	/** The first question the file could not answer; null while every question matched. */
	unscripted(): UnscriptedQuestion | null;
	/** Told once, synchronously, when the first unscripted question cancels its round. */
	onUnscripted(listener: (question: UnscriptedQuestion) => void): () => void;
}

/** Exit status of a run that ended on a question its answers file did not script. */
export const UNSCRIPTED_EXIT_CODE = 5;

class AnswersFileError extends Error {}

function fail(where: string, reason: string): never {
	throw new AnswersFileError(`${where}: ${reason}`);
}

function nonEmptyString(value: unknown, where: string): string {
	if (typeof value !== "string" || value.trim().length === 0) fail(where, "expected a non-empty string");
	return value;
}

function parseEntry(raw: unknown, index: number): AnswerRule {
	const where = `answers[${index}]`;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(where, "expected a mapping");
	const entry = raw as Record<string, unknown>;
	for (const key of Object.keys(entry)) {
		if (!ENTRY_KEYS.has(key)) fail(`${where}.${key}`, "unknown key; an entry takes id, header or match, choice and note");
	}
	const kinds = RULE_KINDS.filter((kind) => Object.hasOwn(entry, kind));
	const kind = kinds[0];
	if (kinds.length !== 1 || kind === undefined) fail(where, "needs exactly one of id, header or match");
	const value = nonEmptyString(entry[kind], `${where}.${kind}`).trim();
	let pattern: RegExp | undefined;
	if (kind === "match") {
		try {
			pattern = new RegExp(value, "u");
		} catch (error) {
			fail(`${where}.match`, `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	let choice: string[] | undefined;
	if (Object.hasOwn(entry, "choice")) {
		const given = entry.choice;
		const labels = Array.isArray(given) ? given : [given];
		if (labels.length === 0) fail(`${where}.choice`, "expected an option label or a non-empty list of labels");
		choice = labels.map((label, at) =>
			nonEmptyString(label, Array.isArray(given) ? `${where}.choice[${at}]` : `${where}.choice`).trim(),
		);
		if (new Set(choice).size !== choice.length) fail(`${where}.choice`, "lists a label twice");
	}
	let note: string | undefined;
	if (Object.hasOwn(entry, "note")) note = nonEmptyString(entry.note, `${where}.note`);
	if (choice === undefined && note === undefined) fail(where, "needs a choice, a note, or both");
	return {
		kind,
		value,
		...(pattern ? { pattern } : {}),
		...(choice ? { choice } : {}),
		...(note !== undefined ? { note } : {}),
		label: `${where} ${kind} ${JSON.stringify(value)}`,
	};
}

function parseAnswersFile(text: string): AnswerRule[] {
	let document: unknown;
	try {
		document = parseYaml(text);
	} catch (error) {
		fail("file", `not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (document === null || typeof document !== "object" || Array.isArray(document))
		fail("file", "expected a mapping with an answers list");
	const top = document as Record<string, unknown>;
	for (const key of Object.keys(top)) if (key !== "answers") fail(key, "unknown key; the file takes only answers");
	if (!Array.isArray(top.answers) || top.answers.length === 0) fail("answers", "expected a non-empty list");
	return top.answers.map((entry, index) => parseEntry(entry, index));
}

function matches(rule: AnswerRule, question: AskUserQuestion): boolean {
	switch (rule.kind) {
		case "id":
			return question.checkpoint === rule.value;
		case "header":
			return question.header?.trim() === rule.value;
		case "match":
			return rule.pattern?.test(question.question) === true;
	}
}

/** The rule's answer to one question, or why that answer is not on offer. */
function answerFor(
	rule: AnswerRule,
	question: AskUserQuestion,
	file: string,
): { answer: AskUserAnswer } | { refusal: string } {
	const offered = (question.options ?? []).map((option) => option.label);
	const scripted = { file, rule: rule.label };
	if (offered.length === 0 || rule.choice === undefined) {
		// A question without options, or an "Other" answer to one with them: the note is the typed answer.
		const text = rule.note ?? rule.choice?.join("; ") ?? "";
		return { answer: { question: question.question, answer: text, value: text, scripted } };
	}
	const missing = rule.choice.find((label) => !offered.includes(label));
	if (missing !== undefined)
		return { refusal: `${rule.label} chooses ${JSON.stringify(missing)}, which the question does not offer` };
	if (rule.choice.length > 1 && question.multi_select !== true)
		return { refusal: `${rule.label} chooses ${rule.choice.length} options for a single-choice question` };
	const labels = offered.filter((label) => rule.choice?.includes(label));
	return {
		answer: {
			question: question.question,
			answer: [...labels, ...(rule.note !== undefined ? [rule.note] : [])].join("; "),
			options: labels,
			...(rule.note !== undefined ? { value: rule.note } : {}),
			scripted,
		},
	};
}

function describeQuestion(question: UnscriptedQuestion): string {
	const named = [
		...(question.header !== undefined ? [`header ${JSON.stringify(question.header)}`] : []),
		...(question.checkpoint !== undefined ? [`id ${JSON.stringify(question.checkpoint)}`] : []),
	];
	const first = question.question.split("\n")[0]?.trim() ?? "";
	return named.length > 0 ? named.join(", ") : `question ${JSON.stringify(first)}`;
}

/** The run's closing line for a question the file did not script. */
export function unscriptedRunMessage(answers: ScriptedAnswers, question: UnscriptedQuestion): string {
	return `clio-coder run: unscripted question (${describeQuestion(question)}): ${question.reason}; add an entry for it to ${answers.file} and run again`;
}

function createScriptedAnswers(file: string, rules: ReadonlyArray<AnswerRule>): ScriptedAnswers {
	let first: UnscriptedQuestion | null = null;
	const listeners = new Set<(question: UnscriptedQuestion) => void>();
	const unscripted = (question: AskUserQuestion, reason: string): AskUserResult => {
		if (first === null) {
			first = {
				question: question.question,
				...(question.header !== undefined ? { header: question.header } : {}),
				...(question.checkpoint !== undefined ? { checkpoint: question.checkpoint } : {}),
				reason,
			};
			const settled = first;
			for (const listener of [...listeners]) listener(settled);
		}
		return { answers: [], cancelled: true, unscripted: true };
	};
	const ask: AskUserHandler = async (questions) => {
		// Once one question went unanswered the run is ending; nothing later is answered either.
		const ended = first;
		if (ended !== null) return { answers: [], cancelled: true, unscripted: true };
		const answers: AskUserAnswer[] = [];
		for (const question of questions) {
			const rule = rules.find((candidate) => matches(candidate, question));
			if (rule === undefined) return unscripted(question, `no entry in ${path.basename(file)} matches it`);
			const resolved = answerFor(rule, question, file);
			if ("refusal" in resolved) return unscripted(question, resolved.refusal);
			answers.push(resolved.answer);
		}
		return { answers };
	};
	return {
		file,
		ask,
		unscripted: () => first,
		onUnscripted(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** Read and validate an answers file before boot; a bad file is a usage error naming the offending entry. */
export function loadScriptedAnswers(file: string): ScriptedAnswers | { error: string } {
	const resolved = path.resolve(file);
	let text: string;
	try {
		text = readFileSync(resolved, "utf8");
	} catch (error) {
		return {
			error: `--answers ${resolved}: cannot read the file: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	try {
		return createScriptedAnswers(resolved, parseAnswersFile(text));
	} catch (error) {
		if (error instanceof AnswersFileError) return { error: `--answers ${resolved}: ${error.message}` };
		throw error;
	}
}
