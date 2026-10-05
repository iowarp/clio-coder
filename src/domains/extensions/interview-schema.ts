import type { Interview, InterviewQuestion, InterviewStep } from "./public-api-v2.js";
import { extensionPlainText } from "./runtime-schema.js";
import { SURFACE_LIMITS, VIEW_LIMITS } from "./view-limits.js";
import { validateView } from "./view-schema.js";

type Refusal = { ok: false; path: string; reason: string };
type Parser = (value: unknown, path: string) => unknown;
type Field = { parse: Parser; optional?: boolean };

class InvalidInterview extends Error {
	constructor(
		readonly path: string,
		reason: string,
	) {
		super(reason);
	}
}

function reject(path: string, reason: string): never {
	throw new InvalidInterview(path || "/", reason);
}

function at(path: string, key: string | number): string {
	return `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function shape(value: unknown, path: string, fields: Record<string, Field>): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) reject(path, "expected an object");
	const raw = value as Record<string, unknown>;
	for (const key of Reflect.ownKeys(raw)) {
		if (typeof key !== "string" || !Object.hasOwn(fields, key)) reject(at(path, String(key)), "unknown field");
	}
	const copy: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(fields)) {
		if (field.optional && !Object.hasOwn(raw, key)) continue;
		copy[key] = field.parse(Object.hasOwn(raw, key) ? raw[key] : undefined, at(path, key));
	}
	return copy;
}

const required = (parse: Parser): Field => ({ parse });
const optional = (parse: Parser): Field => ({ parse, optional: true });

function string(max: number, nonempty = false): Parser {
	return (value, path) => {
		if (typeof value !== "string") reject(path, "expected a string");
		if (value.length > max) reject(path, `exceeds ${max} characters`);
		const clean = extensionPlainText(value);
		if (nonempty && clean.trim().length === 0) reject(path, "expected non-empty text");
		return clean;
	};
}

const label = string(VIEW_LIMITS.labelChars, true);
const text = string(VIEW_LIMITS.textChars);
const identifier: Parser = (value, path) => {
	const id = string(64, true)(value, path) as string;
	if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(id)) reject(path, "expected an id matching ^[a-z][a-z0-9_.-]{0,63}$");
	return id;
};

function array(max: number, parse: Parser, min = 0): Parser {
	return (value, path) => {
		if (!Array.isArray(value)) reject(path, "expected an array");
		if (value.length < min) reject(path, `expected at least ${min} entries`);
		if (value.length > max) reject(at(path, max), `exceeds ${max} entries`);
		return Array.from(value, (item, index) => parse(item, at(path, index)));
	};
}

const total: Parser = (value, path) => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		reject(path, "expected a positive safe integer");
	return value;
};

function question(value: unknown, path: string): InterviewQuestion {
	const copy = shape(value, path, {
		id: required(identifier),
		label: required(label),
		help: optional(text),
		kind: required((value, path) => {
			if (value !== "single" && value !== "multi" && value !== "text") reject(path, "expected single | multi | text");
			return extensionPlainText(value);
		}),
		options: optional(
			array(SURFACE_LIMITS.interviewOptions, (value, path) =>
				shape(value, path, {
					value: required(label),
					label: required(label),
					detail: optional(text),
				}),
			),
		),
		initial: optional((value, path) =>
			Array.isArray(value) ? array(SURFACE_LIMITS.interviewOptions, label)(value, path) : text(value, path),
		),
	}) as unknown as InterviewQuestion;
	const options = copy.options ?? [];
	if (copy.kind === "text") {
		if (options.length > 0) reject(at(path, "options"), "text questions have no options");
		if (copy.initial !== undefined && typeof copy.initial !== "string")
			reject(at(path, "initial"), "text initial must be a string");
		return copy;
	}
	if (options.length === 0) reject(at(path, "options"), "choice questions need at least one option");
	const values = new Set<string>();
	const labels = new Set<string>();
	for (const [index, option] of options.entries()) {
		const optionPath = at(at(path, "options"), index);
		if (values.has(option.value)) reject(at(optionPath, "value"), "duplicate option value");
		// AskUserAnswer carries chosen labels, so duplicate labels cannot map
		// back to distinct extension option values (S4).
		if (labels.has(option.label)) reject(at(optionPath, "label"), "duplicate option label");
		values.add(option.value);
		labels.add(option.label);
	}
	if (copy.initial !== undefined) {
		if (copy.kind === "single" && typeof copy.initial !== "string")
			reject(at(path, "initial"), "single initial must be a string");
		if (copy.kind === "multi" && !Array.isArray(copy.initial))
			reject(at(path, "initial"), "multi initial must be a string array");
		const initial = typeof copy.initial === "string" ? [copy.initial] : copy.initial;
		const seen = new Set<string>();
		for (const [index, value] of initial.entries()) {
			const initialPath = typeof copy.initial === "string" ? at(path, "initial") : at(at(path, "initial"), index);
			if (!values.has(value)) reject(initialPath, "initial must name a declared option value");
			if (seen.has(value)) reject(initialPath, "duplicate initial value");
			seen.add(value);
		}
	}
	return copy;
}

function step(value: unknown, path: string): InterviewStep {
	const ids = new Set<string>();
	return shape(value, path, {
		key: required(identifier),
		title: optional(label),
		intro: optional((value, path) => {
			const result = validateView(value);
			if (!result.ok) reject(`${path}${result.path === "/" ? "" : result.path}`, result.reason);
			return result.view;
		}),
		questions: required(
			array(
				SURFACE_LIMITS.interviewQuestions,
				(value, path) => {
					const parsed = question(value, path);
					if (ids.has(parsed.id)) reject(at(path, "id"), "duplicate question id");
					ids.add(parsed.id);
					return parsed;
				},
				1,
			),
		),
	}) as unknown as InterviewStep;
}

function refusal(error: unknown): Refusal {
	return {
		ok: false,
		path: error instanceof InvalidInterview ? error.path : "/",
		reason: error instanceof Error ? error.message : String(error),
	};
}

export function validateInterview(value: unknown): { ok: true; interview: Interview } | Refusal {
	try {
		const interview = shape(value, "", {
			id: required(identifier),
			title: required(label),
			total: optional(total),
			step: required(step),
		}) as unknown as Interview;
		return { ok: true, interview };
	} catch (error) {
		return refusal(error);
	}
}

export function validateInterviewStep(value: unknown): { ok: true; step: InterviewStep } | Refusal {
	try {
		return { ok: true, step: step(value, "") };
	} catch (error) {
		return refusal(error);
	}
}
