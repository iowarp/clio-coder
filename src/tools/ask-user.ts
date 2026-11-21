import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { isPlanCloseQuestion } from "../core/plan-request.js";
import { safeResourceWriteAsync } from "../core/safe-resource-write.js";
import { stripSkillInstallOfferTag } from "../core/skill-activation.js";
import { ToolNames } from "../core/tool-names.js";
import { clioStateDir } from "../core/xdg.js";
import { type AutonomyExposure, DEFAULT_AUTONOMY_EXPOSURE } from "../domains/safety/autonomy.js";
import { classifyDecisionPresentation, decisionFactsForAnswer } from "../domains/safety/decision-presentation.js";
import { ESCAPE_SCOPE_OPTION_PREFIX } from "../domains/safety/escape-scope.js";
import { namesLeavingSandbox } from "../domains/safety/sandbox-escape.js";
import { StringEnum } from "../engine/ai.js";
import type {
	AskUserToolPolicy,
	AskUserTranscriptAnswer,
	AskUserTranscriptDecision,
	AskUserTranscriptQuestion,
	ScriptedAnswerSource,
	ToolInvokeOptions,
	ToolResult,
	ToolSpec,
} from "./registry.js";
import { effectiveToolCall } from "./surface.js";

const MAX_DECISIONS = 24;
const DEFAULT_MAX_ROUNDS = 6;
const MAX_ROUNDS = 24;

export type AskUserAction = "ask" | "complete";
export type AskUserMode = "round" | "single_question";

export interface AskUserOption {
	label: string;
	description?: string;
}

export interface AskUserQuestion {
	question: string;
	header?: string;
	options?: AskUserOption[];
	multi_select?: boolean;
	/**
	 * Index into `options` the list opens focused on. Set by harness callers
	 * only: the model's input is rebuilt field by field in `normalizeAskUserQuestions`,
	 * which does not carry it, so a model question always opens on its first option.
	 */
	defaultOption?: number;
	/**
	 * The options are the whole answer: no Other row, typed answer or note. Harness
	 * callers only, for a choice whose code reads the picked label and nothing else.
	 */
	fixedChoices?: boolean;
	/**
	 * A choice only the operator may make: which research question or hypothesis
	 * to pursue, or confirmation of a hazardous experiment. Asked alone; nobody
	 * answers it for an absent operator, and only the operator's own answer
	 * becomes a decision marked `operator_choice`.
	 */
	operator_only?: true;
	/**
	 * The checkpoint an extension's interview question settles, as the extension
	 * declared it. Harness callers only; a `run --answers` entry matches it by `id`.
	 */
	checkpoint?: string;
}

export interface AskUserAnswer {
	question: string;
	/** The whole answer on one line: the chosen labels, then the typed text. */
	answer: string;
	/**
	 * The option labels the operator chose, in list order. Absent when they only
	 * typed. Present with no {@link value} is a label-only answer, which is how a
	 * reader tells "they picked the option" from "they picked it and typed a
	 * figure" (issue #228).
	 */
	options?: string[];
	/** The operator's typed text, exactly as submitted. Absent when they only chose. */
	value?: string;
	/** Clio chose this answer because nobody answered within the unattended window (#421). */
	auto?: true;
	/** The operator's answer came from a `run --answers` file: which file, and which of its entries matched. */
	scripted?: ScriptedAnswerSource;
}

export interface AskUserDecision {
	key: string;
	value: string;
	label?: string;
	/** The chosen labels behind `value`; derived by the harness, not model-supplied. */
	options?: string[];
	/** The typed text behind `value`; derived by the harness, not model-supplied. */
	text?: string;
	/** Question that produced this decision; derived by the harness, not model-supplied. */
	source_question?: string;
	/** `agent` when Clio chose for an absent operator; derived by the harness, not model-supplied. */
	source?: "agent";
	/** The options Clio passed over for an absent operator; derived by the harness. */
	alternatives?: string[];
	/** Why Clio chose for the operator; derived by the harness. */
	rationale?: string;
	/** The operator's own answer to an `operator_only` question; derived by the harness, never model-supplied. */
	operator_choice?: true;
	/** The answer came from the operator's `run --answers` file; derived by the harness. */
	scripted?: ScriptedAnswerSource;
}

export interface AskUserResult {
	/** With `cancelled`, what the operator recorded before pressing Esc: never approval, always their words. */
	answers: AskUserAnswer[];
	cancelled?: true;
	/**
	 * Set with `cancelled` when the surface could not show the round because
	 * another overlay owns the screen, so nobody was asked. A harness caller
	 * retries on it; the operator's own Esc never sets it.
	 */
	unavailable?: true;
	/**
	 * Nobody answered within `safety.unattendedAfterSeconds` and nobody touched
	 * the round (#421). `answers` holds only what was committed before then; the
	 * ask_user tool chooses for every question left.
	 */
	timedOut?: { afterSeconds: number };
	/**
	 * Set with `cancelled` when a headless run's answers file scripted no answer
	 * for the round, so nobody answered it and the run ends (WTF-P 0.8.3 B1).
	 */
	unscripted?: true;
	/**
	 * Set with `cancelled` when no operator answers this round: a headless run's
	 * answers file answers only `operator_only` questions (WTF-P 0.8.3 B1). The
	 * tool records no round and refuses the call, as a run without the file has
	 * no ask_user to call.
	 */
	noOperator?: true;
}

/** The refusal of an ordinary round in a headless run whose answers file answers only the author's questions. */
const NO_OPERATOR_MESSAGE =
	"ask_user: this headless run has no operator to answer questions. Decide from the task prompt and the stated defaults, and continue without asking.";

/** The answer to a free-text question nobody answered in time. */
export const UNATTENDED_FREE_TEXT_ANSWER = "no answer: proceed with your best judgment";
/**
 * The answer to an outward question nobody answered in time. A timeout only
 * ever denies, so an unanswered question about publishing or sending
 * something is a no, whatever the model listed first.
 */
export const UNATTENDED_OUTWARD_ANSWER = "no answer: this outward step is not approved; do not take it";
/**
 * The answer to a question whose recommended option leaves the workspace or
 * its sandbox, when nobody answered in time (bt-21). A timeout never approves
 * an escape, whatever the model marked recommended.
 */
export const UNATTENDED_ESCAPE_ANSWER = "no answer: the step outside the workspace is not approved; do not take it";

export interface AskUserCall {
	action: AskUserAction;
	exposure?: AutonomyExposure;
	mode?: AskUserMode;
	questions?: AskUserQuestion[];
	decisions?: AskUserDecision[];
	summary?: string;
	max_rounds?: number;
}

export type AskUserHandler = (
	questions: ReadonlyArray<AskUserQuestion>,
	options?: ToolInvokeOptions,
) => Promise<AskUserResult>;

export interface AskUserToolDeps {
	askUser?: AskUserHandler;
}

export const askUserParameters: TSchema = Type.Object({
	action: Type.Optional(
		StringEnum(["ask", "complete"], {
			description: "ask presents a round of questions; complete records the decisions, once, before final prose.",
		}),
	),
	mode: Type.Optional(
		StringEnum(["round", "single_question"], {
			description:
				"round (default) accepts 1 to 4 tightly related interview questions; single_question accepts exactly one and can ask a standalone question after an interview has completed.",
		}),
	),
	questions: Type.Optional(
		Type.Array(
			Type.Object({
				question: Type.String({ description: "Question for the operator." }),
				header: Type.Optional(Type.String({ description: "Short header." })),
				options: Type.Optional(
					Type.Array(
						Type.Object({
							label: Type.String({ description: "Choice label." }),
							description: Type.Optional(Type.String({ description: "Short explanation." })),
						}),
						{ description: "Suggested choices, recommended first. The UI adds an implicit Other choice." },
					),
				),
				multi_select: Type.Optional(Type.Boolean({ description: "Allow multiple selections." })),
				operator_only: Type.Optional(
					Type.Boolean({
						description:
							"Operator's own choice (research question, hypothesis, hazard check): asked alone, never answered for them.",
					}),
				),
			}),
			{ description: "For action=ask: 1 to 4 questions, or exactly 1 when mode=single_question." },
		),
	),
	max_rounds: Type.Optional(Type.Integer({ description: "Round limit for this turn (default 6, max 24)." })),
	decisions: Type.Optional(
		Type.Array(
			Type.Object({
				key: Type.String({ description: "Stable snake_case key." }),
				value: Type.String({ description: "Decision value." }),
				label: Type.Optional(Type.String({ description: "Human-readable label." })),
			}),
			{ description: `For action=complete: compact decisions, at most ${MAX_DECISIONS}.` },
		),
	),
	summary: Type.Optional(Type.String({ description: "Short closeout summary for action=complete." })),
	exposure: Type.Optional(
		StringEnum(["local", "outward"], {
			description:
				"local (default) stays inside the workspace; outward publishes or sends something the operator cannot take back (issue, PR, comment, push, release) and parks for the operator in default mode.",
		}),
	),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAskUserMode(value: unknown): { mode?: AskUserMode; error?: string } {
	if (value === undefined) return {};
	const raw = trimOptionalString(value)
		?.toLowerCase()
		.replace(/[-\s]+/g, "_");
	if (!raw) return { error: "mode must be round or single_question" };
	if (raw === "round" || raw === "batch") return { mode: "round" };
	if (raw === "single" || raw === "single_question" || raw === "one_question") {
		return { mode: "single_question" };
	}
	return { error: "mode must be round or single_question" };
}

function normalizeExposure(value: unknown): { exposure?: AutonomyExposure; error?: string } {
	if (value === undefined) return { exposure: DEFAULT_AUTONOMY_EXPOSURE };
	const raw = trimOptionalString(value)?.toLowerCase();
	if (raw === "local" || raw === "outward") return { exposure: raw };
	return { error: "exposure must be local or outward" };
}

/**
 * Exposure tier of an ask_user call, read by registry admission from the raw
 * args before `run` validates them. A value the schema does not recognize
 * reads as `outward` so the two layers can never disagree in the unsafe
 * direction; `run` then rejects the call, so a misspelled tier costs one
 * approval prompt rather than an ungated answer.
 */
export function askUserExposure(args: Record<string, unknown> | undefined): AutonomyExposure {
	if (args?.exposure === undefined) return DEFAULT_AUTONOMY_EXPOSURE;
	return normalizeExposure(args.exposure).exposure === "local" ? "local" : "outward";
}

function normalizeMaxRounds(value: unknown): { maxRounds?: number; error?: string } {
	if (value === undefined) return {};
	if (typeof value !== "number" || !Number.isInteger(value)) {
		return { error: `max_rounds must be an integer from 1 to ${MAX_ROUNDS}` };
	}
	if (value < 1 || value > MAX_ROUNDS) {
		return { error: `max_rounds must be an integer from 1 to ${MAX_ROUNDS}` };
	}
	return { maxRounds: value };
}

function normalizeOptions(value: unknown, index: number): { options?: AskUserOption[]; error?: string } {
	if (value === undefined) return {};
	if (!Array.isArray(value)) return { error: `questions[${index}].options must be an array` };
	const options: AskUserOption[] = [];
	for (let optionIndex = 0; optionIndex < value.length; optionIndex += 1) {
		const raw = value[optionIndex];
		if (!isRecord(raw)) return { error: `questions[${index}].options[${optionIndex}] must be an object` };
		const label = trimOptionalString(raw.label);
		if (!label) return { error: `questions[${index}].options[${optionIndex}].label is required` };
		const option: AskUserOption = { label };
		const description = trimOptionalString(raw.description);
		if (description) option.description = description;
		options.push(option);
	}
	return options.length > 0 ? { options } : {};
}

export function normalizeAskUserQuestions(args: Record<string, unknown>): {
	questions?: AskUserQuestion[];
	error?: string;
} {
	const rawQuestions = args.questions;
	if (!Array.isArray(rawQuestions)) return { error: "questions must be an array" };
	if (rawQuestions.length < 1) return { error: "questions must contain at least 1 item" };
	if (rawQuestions.length > 4) return { error: "questions must contain at most 4 items" };
	const questions: AskUserQuestion[] = [];
	for (let index = 0; index < rawQuestions.length; index += 1) {
		const raw = rawQuestions[index];
		if (!isRecord(raw)) return { error: `questions[${index}] must be an object` };
		const questionText = trimOptionalString(raw.question);
		if (!questionText) return { error: `questions[${index}].question is required` };
		const normalized: AskUserQuestion = { question: questionText };
		const header = trimOptionalString(raw.header);
		if (header) normalized.header = header;
		const options = normalizeOptions(raw.options, index);
		if (options.error) return { error: options.error };
		if (options.options) normalized.options = options.options;
		if (raw.multi_select === true) normalized.multi_select = true;
		if (raw.operator_only === true) normalized.operator_only = true;
		questions.push(normalized);
	}
	return { questions };
}

function normalizeDecision(raw: unknown, index: number): { decision?: AskUserDecision; error?: string } {
	if (!isRecord(raw)) return { error: `decisions[${index}] must be an object` };
	const key = trimOptionalString(raw.key);
	if (!key) return { error: `decisions[${index}].key is required` };
	const value = trimOptionalString(raw.value);
	if (!value) return { error: `decisions[${index}].value is required` };
	const decision: AskUserDecision = { key: toDecisionKey(key), value };
	const label = trimOptionalString(raw.label);
	if (label) decision.label = label;
	return { decision };
}

function normalizeDecisions(value: unknown): { decisions?: AskUserDecision[]; error?: string } {
	if (value === undefined) return {};
	if (!Array.isArray(value)) return { error: "decisions must be an array" };
	if (value.length > MAX_DECISIONS) return { error: `decisions must contain at most ${MAX_DECISIONS} items` };
	const decisions: AskUserDecision[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const normalized = normalizeDecision(value[index], index);
		if (normalized.error) return { error: normalized.error };
		if (normalized.decision) decisions.push(normalized.decision);
	}
	return { decisions };
}

function normalizeAskUserCall(args: Record<string, unknown>): { call?: AskUserCall; error?: string } {
	const rawAction = trimOptionalString(args.action)?.toLowerCase() ?? "ask";
	if (rawAction !== "ask" && rawAction !== "complete") {
		return { error: "action must be ask or complete" };
	}
	const mode = normalizeAskUserMode(args.mode);
	if (mode.error) return { error: mode.error };
	// The tier itself is consumed at admission, not here. Validating it anyway
	// keeps a misspelled value from reading as the default `local` on the next
	// call the model makes.
	const exposure = normalizeExposure(args.exposure);
	if (exposure.error) return { error: exposure.error };
	const maxRounds = normalizeMaxRounds(args.max_rounds);
	if (maxRounds.error) return { error: maxRounds.error };
	const decisions = normalizeDecisions(args.decisions);
	if (decisions.error) return { error: decisions.error };
	const summary = trimOptionalString(args.summary);
	if (rawAction === "complete") {
		if (Array.isArray(args.questions) && args.questions.length > 0) {
			return { error: "action=complete must not include questions" };
		}
		return {
			call: {
				action: "complete",
				...(decisions.decisions ? { decisions: decisions.decisions } : {}),
				...(summary ? { summary } : {}),
			},
		};
	}
	const questions = normalizeAskUserQuestions(args);
	if (!questions.questions) return { error: questions.error ?? "invalid questions" };
	// One question per card keeps the operator's choice from riding on a round
	// whose other questions an absent operator would have answered for them.
	if (questions.questions.length > 1 && questions.questions.some((question) => question.operator_only === true)) {
		return { error: "an operator_only question is asked alone: send it as the only question of its call" };
	}
	if (mode.mode === "single_question" && questions.questions.length !== 1) {
		return {
			error: `mode=single_question carries exactly 1 question and this call carried ${questions.questions.length}; send them one call at a time, or use mode=round to ask up to 4 together`,
		};
	}
	return {
		call: {
			action: "ask",
			exposure: exposure.exposure ?? DEFAULT_AUTONOMY_EXPOSURE,
			...(mode.mode ? { mode: mode.mode } : {}),
			questions: questions.questions,
			...(summary ? { summary } : {}),
			...(maxRounds.maxRounds ? { max_rounds: maxRounds.maxRounds } : {}),
		},
	};
}

export function cancelledAskUserResult(): AskUserResult {
	return { answers: [], cancelled: true };
}

/** A round the surface could not put in front of the operator. */
export function unavailableAskUserResult(): AskUserResult {
	return { answers: [], cancelled: true, unavailable: true };
}

/** The chosen labels, dropped when the surface supplied nothing usable. */
function normalizeAnswerOptions(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const labels = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
	return labels.length > 0 ? labels : undefined;
}

/** A surface's timeout report, dropped when it carries no usable window. */
function normalizeTimedOut(value: unknown): { afterSeconds: number } | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const seconds = (value as { afterSeconds?: unknown }).afterSeconds;
	return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
		? { afterSeconds: Math.round(seconds) }
		: undefined;
}

/** Where a scripted answer came from, dropped unless it names both the file and the rule. */
function normalizeScripted(value: unknown): ScriptedAnswerSource | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { file, rule } = value as { file?: unknown; rule?: unknown };
	return typeof file === "string" && file.length > 0 && typeof rule === "string" && rule.length > 0
		? { file, rule }
		: undefined;
}

function normalizeAskUserResult(questions: ReadonlyArray<AskUserQuestion>, result: AskUserResult): AskUserResult {
	if (result.unavailable === true) return unavailableAskUserResult();
	const timedOut = normalizeTimedOut(result.timedOut);
	const answers: AskUserAnswer[] = [];
	for (let index = 0; index < questions.length; index += 1) {
		const fallbackQuestion = questions[index]?.question ?? "";
		const raw = result.answers[index];
		if (!raw) continue;
		const question = typeof raw.question === "string" && raw.question.trim().length > 0 ? raw.question : fallbackQuestion;
		const answer = typeof raw.answer === "string" ? raw.answer.trim() : "";
		if (question.length === 0 || answer.length === 0) continue;
		// The typed text keeps every byte the operator submitted. The one-line
		// `answer` is a rendering of the same decision and is trimmed like any
		// other display string; `value` is the record.
		const options = normalizeAnswerOptions(raw.options);
		const value = typeof raw.value === "string" && raw.value.length > 0 ? raw.value : undefined;
		const scripted = normalizeScripted(raw.scripted);
		answers.push({
			question,
			answer,
			...(options ? { options } : {}),
			...(value !== undefined ? { value } : {}),
			...(scripted ? { scripted } : {}),
		});
	}
	if (result.cancelled === true && result.unscripted === true) return { answers: [], cancelled: true, unscripted: true };
	// Esc ends the turn, but what the operator already recorded stays theirs.
	if (result.cancelled === true) return { answers, cancelled: true };
	return { answers, ...(timedOut !== undefined ? { timedOut } : {}) };
}

/**
 * The option an absent operator gets, and the one a surface tags as recommended:
 * the option whose label says so, else the first, which is where the prompt
 * contract puts it. -1 for a question with no options.
 */
export function recommendedOptionIndex(question: Pick<AskUserQuestion, "options">): number {
	const options = question.options ?? [];
	if (options.length === 0) return -1;
	return Math.max(
		0,
		options.findIndex((option) => /\brecommended\b/iu.test(option.label)),
	);
}

const ESCAPE_WORDS = /\boutside\b[^.;]*\b(workspace|sandbox|repo|repository|project)\b|\b(escape|unsandboxed)\b/iu;
/** A label that turns the step down or keeps it inside: "No, keep it inside", "Skip", "Run it myself instead". */
const DECLINING_LABEL =
	/\b(no|not|don'?t|never|skip|cancel|decline|deny|abort|stop|leave it|inside|instead|myself|my terminal)\b/iu;
/** A label that says yes to the step the question names: "Yes, run it", "Proceed", "Write the file". */
const AFFIRMING_LABEL =
	/^\W*(yes|yep|y|ok|okay|sure|go ahead|do it|proceed|continue|approve|allow|accept|confirm|run|execute|apply|write|create|append|touch|delete|remove|move|copy|install|overwrite|use)\b/iu;

/**
 * Whether a question's timeout pick would approve leaving the workspace or its
 * sandbox: the recommended option says so itself, or the question (header or
 * text) names a step outside the workspace and the option says yes to it.
 */
export function recommendedOptionEscapes(question: Pick<AskUserQuestion, "options" | "question" | "header">): boolean {
	const option = question.options?.[recommendedOptionIndex(question)];
	if (option === undefined) return false;
	if (ESCAPE_WORDS.test(`${option.label} ${option.description ?? ""}`)) return true;
	if (!ESCAPE_WORDS.test(`${question.header ?? ""} ${question.question ?? ""}`)) return false;
	const label = option.label.replace(/\(?\s*(?:·\s*)?recommended\s*\)?/giu, " ");
	return !DECLINING_LABEL.test(label) && AFFIRMING_LABEL.test(label);
}

/**
 * Answer, for an absent operator, every question the round left open (#421).
 * The prompt contract lists the recommended option first, so a question with
 * options takes that one; a free-text question proceeds on the model's
 * judgment; an outward question is answered no, because a timeout never
 * approves anything that leaves the workspace, and neither does a recommended
 * option that steps outside the workspace or sandbox. Answers the operator committed
 * before the window closed are kept as theirs.
 */
function resolveUnattendedAnswers(
	questions: ReadonlyArray<AskUserQuestion>,
	answered: ReadonlyArray<AskUserAnswer>,
	exposure: AutonomyExposure,
): AskUserAnswer[] {
	return questions.flatMap((question): AskUserAnswer[] => {
		const operator = answered.find((answer) => answer.question === question.question);
		if (operator !== undefined) return [operator];
		if (exposure === "outward") return [{ question: question.question, answer: UNATTENDED_OUTWARD_ANSWER, auto: true }];
		if (recommendedOptionEscapes(question))
			return [{ question: question.question, answer: UNATTENDED_ESCAPE_ANSWER, auto: true }];
		const first = question.options?.[recommendedOptionIndex(question)]?.label;
		if (first === undefined) return [{ question: question.question, answer: UNATTENDED_FREE_TEXT_ANSWER, auto: true }];
		return [{ question: question.question, answer: first, options: [first], auto: true }];
	});
}

/** Puts each answered question back to the text the model sent, where a surface echoed the displayed text. */
function restoreQuestions(
	result: AskUserResult,
	shown: ReadonlyArray<AskUserQuestion>,
	original: ReadonlyArray<AskUserQuestion>,
): AskUserResult {
	const originalByShown = new Map<string, string>();
	for (const [index, question] of shown.entries()) {
		const source = original[index]?.question;
		if (source !== undefined && source !== question.question) originalByShown.set(question.question, source);
	}
	if (originalByShown.size === 0) return result;
	return {
		...result,
		answers: result.answers.map((answer) => {
			const source = originalByShown.get(answer.question);
			return source === undefined ? answer : { ...answer, question: source };
		}),
	};
}

function createStandalonePolicy(options?: ToolInvokeOptions): AskUserToolPolicy {
	const now = new Date().toISOString();
	return {
		id: randomUUID(),
		status: "idle",
		startedAt: now,
		updatedAt: now,
		...(options?.sessionId ? { sessionId: options.sessionId } : {}),
		...(options?.turnId ? { turnId: options.turnId } : {}),
		exposure: DEFAULT_AUTONOMY_EXPOSURE,
		rounds: [],
		decisions: [],
		inFlight: false,
		cancelled: false,
		answerCount: 0,
		callCount: 0,
		maxCalls: DEFAULT_MAX_ROUNDS,
		askedQuestionKeys: new Set<string>(),
	};
}

function hydratePolicy(policy: AskUserToolPolicy, options?: ToolInvokeOptions): void {
	if (options?.sessionId && !policy.sessionId) policy.sessionId = options.sessionId;
	if (options?.turnId && !policy.turnId) policy.turnId = options.turnId;
}

/** Once an interview is outward, a later local round cannot lower its replay tier. */
function mergePolicyExposure(policy: AskUserToolPolicy, exposure: AutonomyExposure): AutonomyExposure {
	const merged = policy.exposure === "outward" || exposure === "outward" ? "outward" : "local";
	policy.exposure = merged;
	return merged;
}

function transcriptQuestions(questions: ReadonlyArray<AskUserQuestion>): AskUserTranscriptQuestion[] {
	return questions.map((question) => ({
		question: question.question,
		...(question.header ? { header: question.header } : {}),
		...(question.options
			? {
					options: question.options.map((option) => ({
						label: option.label,
						...(option.description ? { description: option.description } : {}),
					})),
				}
			: {}),
		...(question.multi_select === true ? { multi_select: true } : {}),
		...(question.operator_only === true ? { operator_only: true as const } : {}),
	}));
}

function transcriptAnswers(answers: ReadonlyArray<AskUserAnswer>): AskUserTranscriptAnswer[] {
	return answers.map((answer) => ({
		question: answer.question,
		answer: answer.answer,
		...(answer.options && answer.options.length > 0 ? { options: [...answer.options] } : {}),
		...(answer.value !== undefined ? { value: answer.value } : {}),
		...(answer.auto === true ? { auto: true as const } : {}),
		...(answer.scripted ? { scripted: { ...answer.scripted } } : {}),
	}));
}

function toDecisionKey(value: string): string {
	const key = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 56);
	return key.length > 0 ? key : "decision";
}

function uniqueDecisionKey(base: string, existing: ReadonlySet<string>): string {
	const key = toDecisionKey(base);
	if (!existing.has(key)) return key;
	for (let index = 2; index < 100; index += 1) {
		const candidate = `${key}_${index}`;
		if (!existing.has(candidate)) return candidate;
	}
	return `${key}_${Date.now()}`;
}

/** Why Clio chose an answer for the operator: who was absent, and for how long. */
function autoRationale(unattended: UnattendedRound | undefined): string {
	return `The operator did not answer within ${unattended?.afterSeconds ?? 0} s; Clio chose this for them.`;
}

function decisionFromAnswer(
	answer: AskUserAnswer,
	questions: ReadonlyArray<AskUserQuestion>,
	existing: ReadonlySet<string>,
	unattended?: UnattendedRound,
): AskUserDecision {
	const question = questions.find((candidate) => candidate.question === answer.question);
	const label = question?.header;
	const key = uniqueDecisionKey(label ?? answer.question, existing);
	// Clio's choice for an absent operator is recorded as Clio's, with what it
	// passed over, so the decision board never shows it as the operator's word.
	const passedOver = (question?.options ?? [])
		.map((option) => option.label)
		.filter((option) => option !== answer.answer);
	return {
		key,
		value: answer.answer,
		...(label ? { label } : {}),
		...(answer.options && answer.options.length > 0 ? { options: [...answer.options] } : {}),
		...(answer.value !== undefined ? { text: answer.value } : {}),
		source_question: answer.question,
		...(answer.auto === true
			? {
					source: "agent" as const,
					...(passedOver.length > 0 ? { alternatives: passedOver } : {}),
					rationale: autoRationale(unattended),
				}
			: question?.operator_only === true
				? { operator_choice: true as const }
				: {}),
		...(answer.auto !== true && answer.scripted ? { scripted: { ...answer.scripted } } : {}),
	};
}

function toTranscriptDecision(decision: AskUserDecision): AskUserTranscriptDecision {
	return {
		key: toDecisionKey(decision.key),
		value: decision.value,
		...(decision.label ? { label: decision.label } : {}),
		...(decision.options && decision.options.length > 0 ? { options: [...decision.options] } : {}),
		...(decision.text !== undefined ? { text: decision.text } : {}),
		...(decision.source_question ? { source_question: decision.source_question } : {}),
		...(decision.source === "agent" ? { source: "agent" as const } : {}),
		...(decision.alternatives && decision.alternatives.length > 0 ? { alternatives: [...decision.alternatives] } : {}),
		...(decision.rationale ? { rationale: decision.rationale } : {}),
		...(decision.operator_choice === true && decision.source !== "agent" ? { operator_choice: true as const } : {}),
		...(decision.scripted && decision.source !== "agent" ? { scripted: { ...decision.scripted } } : {}),
	};
}

/**
 * `fromModel` marks the decisions an `action=complete` call wrote. Those never
 * replace an operator's own choice: the operator's answer is the record, and a
 * model restating it under the same key, with any value, changes nothing.
 */
function upsertDecisions(
	policy: AskUserToolPolicy,
	decisions: ReadonlyArray<AskUserDecision>,
	fromModel = false,
): void {
	for (const decision of decisions) {
		const normalized = toTranscriptDecision(fromModel ? withoutOperatorChoice(decision) : decision);
		const existingIndex = policy.decisions.findIndex((item) => item.key === normalized.key);
		if (fromModel && existingIndex >= 0 && policy.decisions[existingIndex]?.operator_choice === true) continue;
		if (existingIndex >= 0) policy.decisions[existingIndex] = normalized;
		else policy.decisions.push(normalized);
	}
	if (policy.decisions.length > MAX_DECISIONS) {
		policy.decisions.splice(0, policy.decisions.length - MAX_DECISIONS);
	}
}

function withoutOperatorChoice(decision: AskUserDecision): AskUserDecision {
	if (decision.operator_choice === undefined) return decision;
	const { operator_choice: _dropped, ...rest } = decision;
	return rest;
}

function deriveAnswerDecisions(
	questions: ReadonlyArray<AskUserQuestion>,
	answers: ReadonlyArray<AskUserAnswer>,
	policy: AskUserToolPolicy,
	unattended?: UnattendedRound,
): AskUserDecision[] {
	const existing = new Set(policy.decisions.map((decision) => decision.key));
	const decisions: AskUserDecision[] = [];
	for (const answer of answers) {
		const decision = decisionFromAnswer(answer, questions, existing, unattended);
		existing.add(decision.key);
		decisions.push(decision);
	}
	return decisions;
}

function questionKey(questions: ReadonlyArray<AskUserQuestion>): string {
	return questions
		.map((question) => `${question.header ?? ""}\n${question.question}`.toLowerCase().replace(/\s+/g, " ").trim())
		.join("\n---\n");
}

function transcriptFileName(policy: AskUserToolPolicy): string {
	const stamp = policy.startedAt.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "");
	return `${stamp}-${policy.id}.json`;
}

async function persistAskUserTranscript(
	policy: AskUserToolPolicy,
	options?: ToolInvokeOptions,
): Promise<string | undefined> {
	hydratePolicy(policy, options);
	const dir = path.join(clioStateDir(), "interviews");
	try {
		await mkdir(dir, { recursive: true });
		if (!policy.transcriptPath) policy.transcriptPath = path.join(dir, transcriptFileName(policy));
		const transcript = {
			schema: "clio-coder.ask_user.interview.v1",
			id: policy.id,
			status: policy.status,
			startedAt: policy.startedAt,
			updatedAt: policy.updatedAt,
			...(policy.endedAt ? { endedAt: policy.endedAt } : {}),
			...(policy.sessionId ? { sessionId: policy.sessionId } : {}),
			...(policy.turnId ? { turnId: policy.turnId } : {}),
			exposure: policy.exposure ?? DEFAULT_AUTONOMY_EXPOSURE,
			...(policy.summary ? { summary: policy.summary } : {}),
			decisions: policy.decisions,
			rounds: policy.rounds,
		};
		// A transcript is rewritten each round; replace it whole so a reader never sees a torn round (#434).
		await safeResourceWriteAsync(policy.transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`);
		return policy.transcriptPath;
	} catch {
		return policy.transcriptPath;
	}
}

function compactInterview(
	policy: AskUserToolPolicy,
	event: string,
	latestAnswers: ReadonlyArray<AskUserAnswer> = [],
): Record<string, unknown> {
	return {
		id: policy.id,
		status: policy.status,
		event,
		rounds: policy.rounds.length,
		max_rounds: policy.maxCalls,
		transcript_path: policy.transcriptPath ?? null,
		exposure: policy.exposure ?? DEFAULT_AUTONOMY_EXPOSURE,
		latest_answers: latestAnswers,
		decisions: policy.decisions,
		...(policy.summary ? { summary: policy.summary } : {}),
		next:
			policy.status === "active"
				? "act on the recorded decisions or ask a new necessary follow-up round"
				: policy.status === "cancelled"
					? "the turn has ended; wait for the operator's next message and do not act on a guessed answer"
					: "continue the task using the decisions/defaults; do not call ask_user again for this interview",
	};
}

/** How an unattended round was settled, for the model and the session record. */
interface UnattendedRound {
	afterSeconds: number;
	autoResolved: number;
}

/**
 * What the model reads after Clio answered for an absent operator (#421): who
 * chose, what was chosen for each question, and that the choices are
 * assumptions its final reply must state.
 */
function unattendedGuidance(
	unattended: UnattendedRound,
	answers: ReadonlyArray<AskUserAnswer>,
	exposure: AutonomyExposure,
): string[] {
	const chosen = answers
		.filter((answer) => answer.auto === true)
		.map((answer) => `- ${answer.question.split("\n")[0]?.trim() ?? answer.question} -> ${answer.answer}`);
	return [
		`The operator did not answer within ${unattended.afterSeconds} s, so Clio answered for them and closed the interview. Clio chose:`,
		...chosen,
		exposure === "outward"
			? "An outward question nobody answered is a no: do not take that step. Continue with the rest of the task, and name each unanswered outward step as an open decision in your final reply."
			: "Each unanswered question took its recommended (first) option; a question without options means proceed on your best judgment. These are assumptions, not the operator's decisions: continue the task on them without asking again, and state each assumption in your final reply so the operator can revisit it.",
		...(exposure !== "outward" &&
		answers.some((answer) => answer.auto === true && answer.answer === UNATTENDED_ESCAPE_ANSWER)
			? [
					"A recommended option that leaves the workspace was declined, not picked: do not take that step, and name it as an open decision in your final reply.",
				]
			: []),
	];
}

function renderAskUserState(
	policy: AskUserToolPolicy,
	event: string,
	latestAnswers: ReadonlyArray<AskUserAnswer> = [],
	unattended?: UnattendedRound,
): string {
	const interview = compactInterview(policy, event, latestAnswers);
	const planAnswer = policy.rounds
		.flatMap((round) => round.answers)
		.reverse()
		.find((answer) => /^carry out this plan\?$/iu.test(answer.question.trim()));
	// A choice Clio made for an absent operator never authorizes a plan.
	const planApproved =
		policy.status !== "cancelled" &&
		planAnswer?.auto !== true &&
		planAnswer?.options?.length === 1 &&
		/^proceed\b/iu.test(planAnswer.options[0] ?? "") &&
		!planAnswer.value?.trim();
	if (unattended !== undefined) {
		return [
			`ask_user result: ${event}`,
			...unattendedGuidance(unattended, latestAnswers, policy.exposure ?? DEFAULT_AUTONOMY_EXPOSURE),
			"",
			JSON.stringify({ interview }, null, 2),
		].join("\n");
	}
	const guidance =
		event === "standalone_answered"
			? "The operator answered this standalone question. Act on the answer within the requested scope. The earlier completed interview and its decisions are unchanged."
			: policy.status === "active"
				? "Act on the answers now. Ask another round only if a new necessary question remains; otherwise continue directly and the interview closes automatically with the recorded decisions below."
				: event === "unscripted"
					? "No entry in this run's --answers file matches this question, so nobody answered it and the run ends here. Make no edits, run no commands and dispatch no workers on a guessed answer."
					: policy.status === "cancelled"
						? latestAnswers.length > 0
							? "The operator recorded latest_answers, then dismissed the interview before answering the rest. A dismissal is not approval: make no edits, run no commands and dispatch no workers on these answers or a guess. The turn ends here; wait for the operator's next message, and do not ask again what latest_answers already says."
							: "The operator dismissed the interview without answering. A dismissal is not approval: make no edits, run no commands and dispatch no workers on a guessed answer. The turn ends here; wait for the operator's next message."
						: "The interview is closed. Act on the answers now: approval means do the work. If the operator declines or says the work is enough, end in one sentence without restating earlier output. Use the compact decisions below; open the transcript only if its history is needed. End with the result, without a new question or offer.";
	return [
		`ask_user result: ${event}`,
		guidance,
		...(planApproved
			? [
					"The operator selected Proceed on the carry-out plan card. This authorizes implementation of the displayed plan, superseding an earlier plan-only request. Complete this interview if still open, then implement in this same turn. Do not stop at a plan-only acknowledgement or request another message. Existing safety and explicit host/tool restrictions still apply.",
				]
			: []),
		"",
		JSON.stringify({ interview }, null, 2),
	].join("\n");
}

function okInterviewResult(
	policy: AskUserToolPolicy,
	event: string,
	latestAnswers: ReadonlyArray<AskUserAnswer> = [],
	unattended?: UnattendedRound,
): ToolResult {
	const interview = compactInterview(policy, event, latestAnswers);
	return {
		kind: "ok",
		output: renderAskUserState(policy, event, latestAnswers, unattended),
		details: {
			interview,
			answers: latestAnswers,
			decisions: policy.decisions,
			...(policy.status === "cancelled" ? { cancelled: true } : {}),
			// Read by the session summary, which counts what Clio answered alone.
			...(unattended !== undefined ? { unattended } : {}),
		},
		// Esc on a clarification means stop, never "go ahead on a guess" (a
		// cancelled interview once let a YOLO turn dispatch an unrequested
		// refactor). Ending the loop here takes the decision away from the model;
		// the guidance text covers a batch where another call keeps the loop alive.
		...(policy.status === "cancelled" ? { terminate: true } : {}),
	};
}

async function completeInterview(
	policy: AskUserToolPolicy,
	event: string,
	options?: ToolInvokeOptions,
	summary?: string,
	decisions: ReadonlyArray<AskUserDecision> = [],
): Promise<ToolResult> {
	const now = new Date().toISOString();
	if (decisions.length > 0) upsertDecisions(policy, decisions, true);
	if (summary) policy.summary = summary;
	if (policy.status !== "cancelled") {
		policy.status = "complete";
		policy.cancelled = false;
	}
	policy.endedAt = policy.endedAt ?? now;
	policy.updatedAt = now;
	await persistAskUserTranscript(policy, options);
	return okInterviewResult(policy, event);
}

/** Whether an assistant message contains any ask_user tool call (direct, gateway call, or gateway chain). */
function assistantMessageCallsAskUser(message: { role?: unknown; content?: unknown }): boolean {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "toolCall" || typeof block.name !== "string") continue;
		if (effectiveToolCall(block.name, block.arguments).toolName === ToolNames.AskUser) return true;
		if (
			block.name === ToolNames.Gateway &&
			isRecord(block.arguments) &&
			block.arguments.op === "chain" &&
			Array.isArray(block.arguments.steps) &&
			block.arguments.steps.some((step) => isRecord(step) && step.capability === ToolNames.AskUser)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Close an active interview implicitly when the model's next settled assistant
 * message after a `round_answered` result contains no `ask_user` call. Writes
 * the same complete state and derived decisions that an explicit `complete`
 * call writes today without requiring a dedicated bookkeeping round (XR-5).
 */
export async function closeAskUserInterviewOnAssistantTurn(
	policy: AskUserToolPolicy,
	message: { role?: unknown; content?: unknown; stopReason?: unknown },
	options?: ToolInvokeOptions,
): Promise<boolean> {
	if (policy.status !== "active" || policy.inFlight === true || policy.rounds.length === 0) return false;
	if (message.role !== "assistant") return false;
	if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") {
		return false;
	}
	if (assistantMessageCallsAskUser(message)) return false;
	const now = new Date().toISOString();
	policy.status = "complete";
	policy.cancelled = false;
	policy.endedAt = policy.endedAt ?? now;
	policy.updatedAt = now;
	await persistAskUserTranscript(policy, options);
	return true;
}

/** Why the host closed an interview the model left open, as the decisions summary words it. */
type AskUserHostCloseReason = "turn_finished";

const HOST_CLOSE_SUMMARY: Record<AskUserHostCloseReason, string> = {
	turn_finished: "The interview ended with the turn before Clio closed it.",
};

async function finalizeAskUserInterview(
	policy: AskUserToolPolicy,
	reason: AskUserHostCloseReason,
	options?: ToolInvokeOptions,
): Promise<void> {
	if (policy.status === "idle" && policy.rounds.length === 0) return;
	if (policy.status !== "complete" && policy.status !== "cancelled") {
		const now = new Date().toISOString();
		policy.status = "complete";
		policy.updatedAt = now;
		policy.endedAt = now;
		policy.summary = policy.summary ?? HOST_CLOSE_SUMMARY[reason];
	}
	await persistAskUserTranscript(policy, options);
}

/** Settle a turn-owned interview, then hand its immutable policy to one durable producer. */
export async function finalizeAskUserInterviewForHost(
	policy: AskUserToolPolicy,
	reason: AskUserHostCloseReason,
	options?: ToolInvokeOptions,
	onFinalized?: (policy: AskUserToolPolicy) => void,
): Promise<void> {
	await finalizeAskUserInterview(policy, reason, options);
	onFinalized?.(policy);
}

/**
 * Close an interview Clio answered for the operator: a timed-out round (#421)
 * or a round at yolo nobody was asked (#407). The answers land on the
 * decision board as Clio's decisions, and the model reads them as assumptions.
 */
async function closeAutoResolved(
	policy: AskUserToolPolicy,
	questions: ReadonlyArray<AskUserQuestion>,
	answers: ReadonlyArray<AskUserAnswer>,
	unattended: UnattendedRound,
	answeredAt: string,
	standalone: boolean,
	options: ToolInvokeOptions | undefined,
): Promise<ToolResult> {
	policy.status = "complete";
	policy.endedAt = answeredAt;
	const note = `Answered by Clio: no operator answer within ${unattended.afterSeconds} s.`;
	policy.summary = policy.summary === undefined ? note : `${policy.summary} ${note}`;
	if (!standalone) {
		upsertDecisions(policy, deriveAnswerDecisions(questions, answers, policy, unattended));
		await persistAskUserTranscript(policy, options);
	}
	return okInterviewResult(policy, "round_auto_resolved", answers, unattended);
}

/**
 * Close an `operator_only` round nobody answered within the unattended window. Nothing is chosen and no decision
 * is recorded, and the turn ends, as it does when an ACP client's interview
 * request times out. The interview closes rather than cancels because the
 * operator dismissed nothing.
 */
async function closeOperatorChoiceUnanswered(
	policy: AskUserToolPolicy,
	questions: ReadonlyArray<AskUserQuestion>,
	requestedAt: string,
	reason: { afterSeconds: number },
	standalone: boolean,
	options: ToolInvokeOptions | undefined,
): Promise<ToolResult> {
	const answeredAt = new Date().toISOString();
	policy.callCount += 1;
	policy.askedQuestionKeys.add(questionKey(questions));
	policy.updatedAt = answeredAt;
	policy.rounds.push({
		round: policy.rounds.length + 1,
		requestedAt,
		answeredAt,
		questions: transcriptQuestions(questions),
		answers: [],
	});
	policy.status = "complete";
	policy.endedAt = answeredAt;
	const why = `The operator did not answer within ${reason.afterSeconds} s`;
	const note = `${why}; this question is the operator's own choice, so nothing was chosen.`;
	policy.summary = policy.summary === undefined ? note : `${policy.summary} ${note}`;
	if (!standalone) await persistAskUserTranscript(policy, options);
	const interview = compactInterview(policy, "operator_choice_unanswered");
	return {
		kind: "ok",
		output: [
			"ask_user result: operator_choice_unanswered",
			`${note} No decision was recorded and the choice stays open. The turn ends here: do not choose, and do not act as if anything was chosen.`,
			"",
			JSON.stringify({ interview }, null, 2),
		].join("\n"),
		details: { interview, answers: [], decisions: policy.decisions, operatorChoiceUnanswered: true },
		terminate: true,
	};
}

/** Clio answered a round of this interview for an absent operator. */
function closedUnattended(policy: AskUserToolPolicy): boolean {
	return policy.rounds.some((round) => round.answers.some((answer) => answer.auto === true));
}

/**
 * A plan card asked after Clio closed the interview for an absent operator. The
 * card is not shown, since another round would only wait out the window again,
 * but the generic closed-interview reply ("approval means do the work") read as
 * a go-ahead nobody gave: a local model was told to act on a plan whose card
 * the operator never saw. A choice Clio made never authorizes a plan, so the
 * turn ends on the plan.
 */
function planCloseAfterUnattendedResult(policy: AskUserToolPolicy): ToolResult {
	const interview = compactInterview(policy, "plan_not_approved");
	return {
		kind: "ok",
		output: [
			"ask_user result: plan_not_approved",
			"The interview already closed because the operator did not answer, so this plan card was not shown and nobody approved the plan. The turn ends here with the plan as written: make no edits, run no commands that change files and dispatch no workers on it. The plan waits for the operator's go-ahead in their next message.",
			"",
			JSON.stringify({ interview }, null, 2),
		].join("\n"),
		details: { interview, answers: [], decisions: policy.decisions },
		terminate: true,
	};
}

async function defaultAskUserHandler(): Promise<AskUserResult> {
	return cancelledAskUserResult();
}

/**
 * A bare string in questions[] is an unambiguous one-question intent that the
 * schema refuses as "expected object", costing the model a round. Pi runs this
 * before schema validation, so the string becomes `{ question }` there and the
 * attached schema stays as it is.
 */
function prepareAskUserArguments(args: Record<string, unknown>): Record<string, unknown> {
	const { questions } = args;
	if (!Array.isArray(questions) || !questions.some((entry) => typeof entry === "string")) return args;
	return { ...args, questions: questions.map((entry) => (typeof entry === "string" ? { question: entry } : entry)) };
}

/**
 * The questions with the host's session-scope option (M-7): an agent-written option that claims the option's
 * prefix is dropped from every question, and the offer, when there is one, joins the first single-choice
 * question that names leaving the sandbox, last, so it is never the recommended or default pick.
 */
function withEscapeScopeOption(
	questions: AskUserQuestion[],
	offer: { label: string; description: string } | undefined,
): AskUserQuestion[] {
	const claims = (option: AskUserOption): boolean => option.label.trim().startsWith(ESCAPE_SCOPE_OPTION_PREFIX);
	const cleaned = questions.map((question) =>
		question.options?.some(claims) === true
			? { ...question, options: question.options.filter((option) => !claims(option)) }
			: question,
	);
	if (offer === undefined) return cleaned;
	const index = cleaned.findIndex(
		(question) =>
			question.multi_select !== true && question.options !== undefined && namesLeavingSandbox(question.question),
	);
	const target = cleaned[index];
	if (target === undefined) return cleaned;
	const next = [...cleaned];
	next[index] = {
		...target,
		options: [...(target.options ?? []), { label: offer.label, description: offer.description }],
	};
	return next;
}

export function createAskUserTool(deps: AskUserToolDeps = {}): ToolSpec {
	return {
		name: ToolNames.AskUser,
		description:
			'Ask the operator what only they can answer: a decision the request leaves open, approval of a plan, a yes or no, or whether to go further. Facts a tool can check and answers already given are not questions; greetings, thanks, and questions you can answer get a plain reply. Give each question its context and 2-4 options, each described by what choosing it leads to, recommended first; a yes or no becomes options such as "Yes, proceed", "Yes, but change ..." and "No, instead ...", and multi_select suits choices that combine. action=ask presents questions; action=complete closes an interview that asked questions, recording the operator\'s decisions, before final prose. If the operator cancels, the turn ends: a dismissal is never approval to proceed on a guess.',
		parameters: askUserParameters,
		baseActionClass: "read",
		executionMode: "sequential",
		prepareArguments: prepareAskUserArguments,
		async run(args, options): Promise<ToolResult> {
			const normalized = normalizeAskUserCall(args);
			if (!normalized.call) return { kind: "error", message: `ask_user: ${normalized.error ?? "invalid input"}` };
			const call = normalized.call;
			const turnPolicy = options?.askUserPolicy;
			// Proceeding closes the interview and a revision is usually completed
			// first, so the ask that follows either hit already_complete on 5 of 9
			// real episodes. Only a kept plan refuses another card.
			const standalone =
				call.action === "ask" &&
				turnPolicy?.status === "complete" &&
				(call.mode === "single_question" || turnPolicy.asksAfterClose === true);
			const policy = standalone ? createStandalonePolicy(options) : (turnPolicy ?? createStandalonePolicy(options));
			if (standalone && turnPolicy?.planOnly !== undefined) policy.planOnly = turnPolicy.planOnly;
			hydratePolicy(policy, options);
			// A cold complete records no decision and its "act on the answers"
			// reply reads as approval; models used it to announce results (FW-2).
			// A continuation of the prompt that closed an interview is not cold: a
			// budget roll or yolo continuation starts a fresh turn policy, and its
			// complete answers already_complete with that interview's decisions (C-25).
			if (call.action === "complete" && policy.rounds.length === 0) {
				const closed = turnPolicy?.closedEarlier;
				if (closed?.status === "complete") return okInterviewResult(closed, "already_complete");
				return {
					kind: "error",
					message:
						"ask_user: action=complete closes an interview that asked questions, and none was asked. Give the answer or result as plain text.",
				};
			}
			if (policy.status === "complete") {
				if (call.action === "ask" && closedUnattended(policy) && (call.questions ?? []).some(isPlanCloseQuestion)) {
					return planCloseAfterUnattendedResult(policy);
				}
				return okInterviewResult(policy, "already_complete");
			}

			if (call.action === "complete") {
				return completeInterview(policy, "complete", options, call.summary, call.decisions ?? []);
			}
			const questions = withEscapeScopeOption(
				(call.questions ?? []).map((question) => {
					if (!policy.planOnly || !/^carry out this plan\?/iu.test(question.question.trim())) return question;
					return {
						...question,
						multi_select: false,
						options: [
							{ label: "Keep the plan (Recommended)", description: "Finish with the plan; make no edits." },
							...(question.options ?? [])
								.filter((option) => !/^(?:keep\b|revise\b)/iu.test(option.label))
								.map((option) => ({ ...option, label: option.label.replace(/\s*\(Recommended\)/giu, "") })),
							{ label: "Revise the plan first", description: "Adjust the plan before deciding." },
						],
					};
				}),
				options?.escapeScopeOffer,
			);
			const exposure = mergePolicyExposure(policy, call.exposure ?? DEFAULT_AUTONOMY_EXPOSURE);
			if (call.max_rounds !== undefined) {
				const nextLimit = policy.callCount === 0 ? call.max_rounds : Math.max(policy.maxCalls, call.max_rounds);
				policy.maxCalls = Math.max(nextLimit, policy.callCount + 1);
			}
			if (policy.inFlight === true) {
				return {
					kind: "error",
					message: "ask_user: an operator interview round is already in progress. Wait for that answer.",
				};
			}
			if (policy.status === "cancelled" || policy.cancelled === true) {
				policy.status = "cancelled";
				policy.cancelled = true;
				await persistAskUserTranscript(policy, options);
				return okInterviewResult(policy, "already_cancelled");
			}
			const key = questionKey(questions);
			if (policy.askedQuestionKeys.has(key)) {
				await persistAskUserTranscript(policy, options);
				return okInterviewResult(policy, "duplicate_round_ignored");
			}
			if (policy.callCount >= policy.maxCalls) {
				return completeInterview(
					policy,
					"round_limit_reached",
					options,
					`Interview closed after reaching the ${policy.maxCalls}-round limit.`,
				);
			}

			const operatorOnly = questions.some((question) => question.operator_only === true);
			const requestedAt = new Date().toISOString();
			const prior = { status: policy.status, updatedAt: policy.updatedAt, summary: policy.summary };
			policy.inFlight = true;
			policy.status = "active";
			policy.updatedAt = requestedAt;
			if (call.summary) policy.summary = call.summary;
			const handler = deps.askUser ?? defaultAskUserHandler;
			try {
				// The install-offer binding marker is plumbing for the observer, not
				// text for the operator: surfaces get the question without it and the
				// answer gets the original back.
				const shown = questions.map((question) => ({
					...question,
					question: stripSkillInstallOfferTag(question.question),
				}));
				const handled = await handler(shown, {
					...options,
					askUserPolicy: policy,
					decisionPresentation: classifyDecisionPresentation(decisionFactsForAnswer(exposure)),
					unattendedFallback: true,
				});
				if (handled.noOperator === true) {
					// Nobody was asked, so the interview stays as it was before the call.
					policy.status = prior.status;
					policy.updatedAt = prior.updatedAt;
					if (prior.summary === undefined) delete policy.summary;
					else policy.summary = prior.summary;
					return { kind: "error", message: NO_OPERATOR_MESSAGE };
				}
				const normalized = normalizeAskUserResult(questions, restoreQuestions(handled, shown, questions));
				const timedOut = normalized.timedOut;
				if (operatorOnly && timedOut !== undefined && normalized.answers.length === 0) {
					return closeOperatorChoiceUnanswered(policy, questions, requestedAt, timedOut, standalone, options);
				}
				const result =
					timedOut === undefined
						? normalized
						: { ...normalized, answers: resolveUnattendedAnswers(questions, normalized.answers, exposure) };
				// Only the operator's own pick of the host's option grants the escape scope (M-7): never Clio's pick for
				// an absent operator, a cancelled round, or anything typed.
				const offer = options?.escapeScopeOffer;
				if (
					offer !== undefined &&
					timedOut === undefined &&
					result.cancelled !== true &&
					result.answers.some((answer) => answer.auto !== true && answer.options?.includes(offer.label) === true)
				)
					offer.accept();
				const answeredAt = new Date().toISOString();
				policy.callCount += 1;
				policy.askedQuestionKeys.add(key);
				policy.answerCount += result.answers.length;
				policy.updatedAt = answeredAt;
				const round = {
					round: policy.rounds.length + 1,
					requestedAt,
					answeredAt,
					questions: transcriptQuestions(questions),
					answers: transcriptAnswers(result.answers),
					...(result.cancelled === true ? { cancelled: true } : {}),
				};
				policy.rounds.push(round);
				if (result.cancelled === true) {
					// The card promises that answers recorded before Esc are kept, so they
					// reach the decisions board as well as the model; questions left open stay off it.
					if (!standalone) {
						const recorded = result.answers.filter((answer) => answer.answer.trim().length > 0);
						if (recorded.length > 0) upsertDecisions(policy, deriveAnswerDecisions(questions, recorded, policy));
					}
					policy.status = "cancelled";
					policy.cancelled = true;
					policy.endedAt = answeredAt;
					if (!standalone) await persistAskUserTranscript(policy, options);
					return okInterviewResult(policy, result.unscripted === true ? "unscripted" : "cancelled", result.answers);
				}
				if (timedOut !== undefined) {
					// Clio answered for an absent operator, so the interview closes
					// here: another round would only wait out the window again.
					const unattended: UnattendedRound = {
						afterSeconds: timedOut.afterSeconds,
						autoResolved: result.answers.filter((answer) => answer.auto === true).length,
					};
					return closeAutoResolved(policy, questions, result.answers, unattended, answeredAt, standalone, options);
				}
				if (standalone) {
					policy.status = "complete";
					policy.endedAt = answeredAt;
					// A standalone round has no board record of its own. The operator's
					// own choice still has to reach the board, so it joins the turn's
					// interview, which the host finalizes when the turn ends.
					if (operatorOnly && turnPolicy !== undefined) {
						const chosen = deriveAnswerDecisions(questions, result.answers, turnPolicy);
						upsertDecisions(turnPolicy, chosen);
						await persistAskUserTranscript(turnPolicy, options);
					}
					return okInterviewResult(policy, "standalone_answered", result.answers);
				}
				const derived = deriveAnswerDecisions(questions, result.answers, policy);
				upsertDecisions(policy, derived);
				// The answered close is the interview's last act, so requiring
				// action=complete after it only cost a round. A revision or a typed
				// qualification keeps it open, because another card follows.
				const planCard = questions.length === 1 && isPlanCloseQuestion(questions[0]);
				const closesPlan =
					planCard &&
					result.answers[0]?.options?.length === 1 &&
					!result.answers[0].value?.trim() &&
					!/^revise\b/iu.test(result.answers[0].options[0] ?? "");
				if (closesPlan) {
					policy.status = "complete";
					policy.endedAt = answeredAt;
				}
				if (planCard && !/^keep\b/iu.test(result.answers[0]?.options?.[0] ?? "")) policy.asksAfterClose = true;
				await persistAskUserTranscript(policy, options);
				return okInterviewResult(policy, closesPlan ? "complete" : "round_answered", result.answers);
			} finally {
				policy.inFlight = false;
			}
		},
	};
}
