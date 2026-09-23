/**
 * `consult`: the main agent asks the bound System One model a typed question.
 *
 * It sits behind the gateway and is registered only on the session registry,
 * only when the `consult` decision site is bound at startup. Unbound, the
 * registry, the gateway listing, the tool signature and the prompt are exactly
 * what they were before the tool existed. Workers never get it: a worker runs
 * one assigned task under a result contract, and the main agent is the one
 * responsible for choices.
 *
 * The result is a hint. It carries the distribution the model returned, which
 * model answered and how long it took, and never a chosen option: a `pick`
 * comes back as mass per option, not as a winner. The agent decides.
 */

import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { pick, rate, yesNo } from "../domains/providers/decisions.js";
import type { SiteReply } from "../domains/providers/site-ask.js";
import type { DecisionAnswer, DecisionQuestion } from "../domains/providers/types/inference.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolResult, ToolSpec } from "./registry.js";

export const CONSULT_LIMITS = {
	callsPerTurn: 3,
	questionsPerCall: 4,
	/** Bytes of `state` serialized as JSON. */
	stateBytes: 2048,
	/** Code points of one question's text. */
	questionChars: 400,
	/** Code points of one option, rung or yes/no description. */
	criterionChars: 200,
	/** Options in a pick and rungs on a rate ladder. */
	criteria: 8,
} as const;

export interface ConsultDeps {
	/** Ask the bound site. Null means no usable answer for any reason. */
	ask(
		state: Record<string, unknown>,
		questions: Readonly<Record<string, DecisionQuestion>>,
		signal?: AbortSignal,
	): Promise<SiteReply | null>;
}

const KINDS = ["yesNo", "pick", "rate"] as const;
type ConsultKind = (typeof KINDS)[number];

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

export const consultParameters = Type.Object({
	questions: Type.Array(
		Type.Object({
			id: Type.String({ description: "Short identifier for this question, e.g. risky." }),
			kind: StringEnum(KINDS, {
				description: "yesNo: probability a statement holds. pick: mass over named options. rate: position on a ladder.",
			}),
			question: Type.String({ description: "The question, answerable from state alone." }),
			whenTrue: Type.Optional(Type.String({ description: "yesNo: what a true answer means." })),
			whenFalse: Type.Optional(Type.String({ description: "yesNo: what a false answer means." })),
			options: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "pick: option name to the description that defines it; 2 to 8 options.",
				}),
			),
			ladder: Type.Optional(
				Type.Array(Type.String(), { description: "rate: 2 to 8 rungs, lowest first, each saying what it means." }),
			),
		}),
		{ description: "1 to 4 independent questions over the same state." },
	),
	state: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "The evidence the questions are about, at most 2 KB as JSON. The model sees nothing else.",
		}),
	),
});

const DESCRIPTION =
	"Ask the configured decision model up to four typed questions (yesNo, pick, rate) about evidence you supply, and get back its probability distribution, the answering model and the latency. The answer is advice: it never makes the choice, and you stay responsible for what you do. A few hundred milliseconds per call; at most 3 calls per turn.";

function codePoints(value: string): number {
	return [...value].length;
}

function refuse(message: string): ToolResult {
	return { kind: "error", message: `consult: ${message}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ParsedQuestion {
	id: string;
	kind: ConsultKind;
	question: DecisionQuestion;
	/** Rate ladders, so a position can be read back against the rungs. */
	ladder?: string[];
}

function criterionError(id: string, what: string, text: unknown): string | null {
	if (typeof text !== "string" || text.trim().length === 0) return `question ${id}: ${what} must be non-empty text`;
	if (codePoints(text) > CONSULT_LIMITS.criterionChars) {
		return `question ${id}: ${what} is over the ${CONSULT_LIMITS.criterionChars}-character limit`;
	}
	return null;
}

function parseQuestion(raw: unknown): ParsedQuestion | string {
	if (!isRecord(raw)) return "each question must be an object with id, kind and question";
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!ID_PATTERN.test(id)) return "question id must start with a letter and use letters, digits, _ or -, up to 40";
	const kind = raw.kind;
	if (typeof kind !== "string" || !(KINDS as ReadonlyArray<string>).includes(kind)) {
		return `question ${id}: kind must be yesNo, pick or rate`;
	}
	const text = typeof raw.question === "string" ? raw.question.trim() : "";
	if (text.length === 0) return `question ${id}: question text is required`;
	if (codePoints(text) > CONSULT_LIMITS.questionChars) {
		return `question ${id}: question text is over the ${CONSULT_LIMITS.questionChars}-character limit`;
	}
	if (kind === "yesNo") {
		const whenTrue = raw.whenTrue ?? "The statement holds";
		const whenFalse = raw.whenFalse ?? "The statement does not hold";
		const error = criterionError(id, "whenTrue", whenTrue) ?? criterionError(id, "whenFalse", whenFalse);
		if (error !== null) return error;
		return { id, kind: "yesNo", question: yesNo(text, whenTrue as string, whenFalse as string) };
	}
	if (kind === "pick") {
		if (!isRecord(raw.options)) return `question ${id}: pick needs options, a map of name to description`;
		const entries = Object.entries(raw.options);
		if (entries.length < 2 || entries.length > CONSULT_LIMITS.criteria) {
			return `question ${id}: pick needs 2 to ${CONSULT_LIMITS.criteria} options`;
		}
		const options: Record<string, string> = {};
		for (const [name, description] of entries) {
			const error = criterionError(id, `option ${name}`, description);
			if (error !== null) return error;
			options[name] = (description as string).trim();
		}
		return { id, kind: "pick", question: pick(text, options) };
	}
	if (!Array.isArray(raw.ladder)) return `question ${id}: rate needs ladder, a list of rungs lowest first`;
	if (raw.ladder.length < 2 || raw.ladder.length > CONSULT_LIMITS.criteria) {
		return `question ${id}: rate needs 2 to ${CONSULT_LIMITS.criteria} rungs`;
	}
	const ladder: string[] = [];
	for (const [index, rung] of raw.ladder.entries()) {
		const error = criterionError(id, `rung ${index}`, rung);
		if (error !== null) return error;
		ladder.push((rung as string).trim());
	}
	return { id, kind: "rate", question: rate(text, ladder), ladder };
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

/** The distribution only. A pick's winning key is left out on purpose: the agent picks. */
function hintFor(parsed: ParsedQuestion, answer: DecisionAnswer, certainty: number): Record<string, unknown> {
	if (parsed.kind === "yesNo") return { kind: "yesNo", pTrue: rounded(answer.noul ?? 0), certainty: rounded(certainty) };
	if (parsed.kind === "pick") {
		return { kind: "pick", distribution: roundedMap(answer.probabilities), certainty: rounded(certainty) };
	}
	const byRung: Record<string, number> = {};
	for (const [index, mass] of Object.entries(answer.probabilities ?? {})) {
		const rung = parsed.ladder?.[Number(index)];
		if (rung !== undefined && Number.isFinite(mass)) byRung[rung] = rounded(mass);
	}
	return {
		kind: "rate",
		...(answer.score !== undefined ? { position: rounded(answer.score) } : {}),
		distribution: byRung,
		certainty: rounded(certainty),
	};
}

export function createConsultTool(deps: ConsultDeps): ToolSpec {
	let turn: { id: string; calls: number } = { id: "", calls: 0 };
	return {
		name: ToolNames.Consult,
		description: DESCRIPTION,
		parameters: consultParameters,
		baseActionClass: "read",
		executionMode: "parallel",
		async run(args, options): Promise<ToolResult> {
			const turnId = options?.turnId ?? options?.runId ?? "";
			if (turn.id !== turnId) turn = { id: turnId, calls: 0 };
			if (turn.calls >= CONSULT_LIMITS.callsPerTurn) {
				return refuse(
					`the limit of ${CONSULT_LIMITS.callsPerTurn} calls per turn is spent; decide from what you already have`,
				);
			}
			const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
			if (rawQuestions.length === 0) return refuse("questions must hold at least one question");
			if (rawQuestions.length > CONSULT_LIMITS.questionsPerCall) {
				return refuse(`${rawQuestions.length} questions is over the limit of ${CONSULT_LIMITS.questionsPerCall} per call`);
			}
			const state = isRecord(args.state) ? args.state : {};
			const stateBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
			if (stateBytes > CONSULT_LIMITS.stateBytes) {
				return refuse(
					`state is ${stateBytes} bytes as JSON, over the limit of ${CONSULT_LIMITS.stateBytes}; send only the evidence the questions need`,
				);
			}
			const parsed: ParsedQuestion[] = [];
			for (const raw of rawQuestions) {
				const question = parseQuestion(raw);
				if (typeof question === "string") return refuse(question);
				if (parsed.some((entry) => entry.id === question.id)) return refuse(`question id ${question.id} is repeated`);
				parsed.push(question);
			}
			turn.calls += 1;
			const remaining = CONSULT_LIMITS.callsPerTurn - turn.calls;
			const reply = await deps.ask(
				state,
				Object.fromEntries(parsed.map((entry) => [entry.id, entry.question])),
				options?.signal,
			);
			if (reply === null) {
				const output = {
					answered: false,
					note: "The decision model gave no usable answer. Proceed on your own judgment.",
					remainingCalls: remaining,
				};
				return { kind: "ok", output: JSON.stringify(output), details: { consult: output } };
			}
			const answers: Record<string, unknown> = {};
			for (const entry of parsed) {
				const answered = reply.answers[entry.id];
				answers[entry.id] =
					answered === null || answered === undefined
						? { kind: entry.kind, abstained: true }
						: hintFor(entry, answered.answer, answered.certainty);
			}
			const output = {
				answered: true,
				note: "Advice from a decision model, not a decision. You choose what to do.",
				answers,
				model: reply.model,
				source: reply.source,
				latencyMs: reply.latencyMs,
				remainingCalls: remaining,
			};
			return { kind: "ok", output: JSON.stringify(output), details: { consult: output } };
		},
	};
}
