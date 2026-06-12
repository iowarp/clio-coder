import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import { clioStateDir } from "../core/xdg.js";
import type {
	AskUserToolPolicy,
	AskUserTranscriptAnswer,
	AskUserTranscriptDecision,
	AskUserTranscriptQuestion,
	ToolInvokeOptions,
	ToolResult,
	ToolSpec,
} from "./registry.js";
import { stringEnum } from "./string-enum.js";

export const ASK_USER_OTHER_LABEL = "Other (type your answer)";

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
}

export interface AskUserAnswer {
	question: string;
	answer: string;
}

export interface AskUserDecision {
	key: string;
	value: string;
	label?: string;
	/** Question that produced this decision; derived by the harness, not model-supplied. */
	source_question?: string;
}

export interface AskUserResult {
	answers: AskUserAnswer[];
	cancelled?: true;
}

export interface AskUserCall {
	action: AskUserAction;
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

export const askUserParameters = Type.Object({
	action: Type.Optional(
		stringEnum(
			["ask", "complete"],
			"ask presents a round of questions; complete (exactly once) records decisions before final prose.",
		),
	),
	mode: Type.Optional(
		stringEnum(
			["round", "single_question"],
			"single_question: exactly one question per round (interviews); round: up to four tightly related confirmations.",
		),
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
			}),
			{ description: "For action=ask: one to four questions." },
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
			{ description: "For action=complete: compact decisions." },
		),
	),
	summary: Type.Optional(Type.String({ description: "Short closeout summary for action=complete." })),
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

export function normalizeAskUserCall(args: Record<string, unknown>): { call?: AskUserCall; error?: string } {
	const rawAction = trimOptionalString(args.action)?.toLowerCase() ?? "ask";
	if (rawAction !== "ask" && rawAction !== "complete") {
		return { error: "action must be ask or complete" };
	}
	const mode = normalizeAskUserMode(args.mode);
	if (mode.error) return { error: mode.error };
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
	if (mode.mode === "single_question" && questions.questions.length !== 1) {
		return { error: "mode=single_question requires exactly 1 question" };
	}
	return {
		call: {
			action: "ask",
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

function normalizeAskUserResult(questions: ReadonlyArray<AskUserQuestion>, result: AskUserResult): AskUserResult {
	if (result.cancelled === true) return cancelledAskUserResult();
	const answers: AskUserAnswer[] = [];
	for (let index = 0; index < questions.length; index += 1) {
		const fallbackQuestion = questions[index]?.question ?? "";
		const raw = result.answers[index];
		if (!raw) continue;
		const question = typeof raw.question === "string" && raw.question.trim().length > 0 ? raw.question : fallbackQuestion;
		const answer = typeof raw.answer === "string" ? raw.answer.trim() : "";
		if (question.length > 0 && answer.length > 0) answers.push({ question, answer });
	}
	return { answers };
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
	}));
}

function transcriptAnswers(answers: ReadonlyArray<AskUserAnswer>): AskUserTranscriptAnswer[] {
	return answers.map((answer) => ({ question: answer.question, answer: answer.answer }));
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

function decisionFromAnswer(
	answer: AskUserAnswer,
	questions: ReadonlyArray<AskUserQuestion>,
	existing: ReadonlySet<string>,
): AskUserDecision {
	const question = questions.find((candidate) => candidate.question === answer.question);
	const label = question?.header;
	const key = uniqueDecisionKey(label ?? answer.question, existing);
	return {
		key,
		value: answer.answer,
		...(label ? { label } : {}),
		source_question: answer.question,
	};
}

function toTranscriptDecision(decision: AskUserDecision): AskUserTranscriptDecision {
	return {
		key: toDecisionKey(decision.key),
		value: decision.value,
		...(decision.label ? { label: decision.label } : {}),
		...(decision.source_question ? { source_question: decision.source_question } : {}),
	};
}

function upsertDecisions(policy: AskUserToolPolicy, decisions: ReadonlyArray<AskUserDecision>): void {
	for (const decision of decisions) {
		const normalized = toTranscriptDecision(decision);
		const existingIndex = policy.decisions.findIndex((item) => item.key === normalized.key);
		if (existingIndex >= 0) policy.decisions[existingIndex] = normalized;
		else policy.decisions.push(normalized);
	}
	if (policy.decisions.length > MAX_DECISIONS) {
		policy.decisions.splice(0, policy.decisions.length - MAX_DECISIONS);
	}
}

function deriveAnswerDecisions(
	questions: ReadonlyArray<AskUserQuestion>,
	answers: ReadonlyArray<AskUserAnswer>,
	policy: AskUserToolPolicy,
): AskUserDecision[] {
	const existing = new Set(policy.decisions.map((decision) => decision.key));
	const decisions: AskUserDecision[] = [];
	for (const answer of answers) {
		const decision = decisionFromAnswer(answer, questions, existing);
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
			schema: "clio.ask_user.interview.v1",
			id: policy.id,
			status: policy.status,
			startedAt: policy.startedAt,
			updatedAt: policy.updatedAt,
			...(policy.endedAt ? { endedAt: policy.endedAt } : {}),
			...(policy.sessionId ? { sessionId: policy.sessionId } : {}),
			...(policy.turnId ? { turnId: policy.turnId } : {}),
			...(policy.summary ? { summary: policy.summary } : {}),
			decisions: policy.decisions,
			rounds: policy.rounds,
		};
		await writeFile(policy.transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
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
		latest_answers: latestAnswers,
		decisions: policy.decisions,
		...(policy.summary ? { summary: policy.summary } : {}),
		next:
			policy.status === "active"
				? "ask a new necessary follow-up round or call ask_user with action=complete before final prose"
				: "continue the task using the decisions/defaults; do not call ask_user again for this interview",
	};
}

function renderAskUserState(
	policy: AskUserToolPolicy,
	event: string,
	latestAnswers: ReadonlyArray<AskUserAnswer> = [],
): string {
	const interview = compactInterview(policy, event, latestAnswers);
	const guidance =
		policy.status === "active"
			? "The interview modal remains open. Ask only new necessary follow-up rounds. When enough information is collected, call ask_user with action=complete before final prose."
			: policy.status === "cancelled"
				? "The operator cancelled the interview. Proceed with defaults or existing answers; do not ask_user again for this interview."
				: "The interview is closed. Continue with the compact decisions below; use the transcript path only if the full history is needed later.";
	return [`ask_user result: ${event}`, guidance, "", JSON.stringify({ interview }, null, 2)].join("\n");
}

function okInterviewResult(
	policy: AskUserToolPolicy,
	event: string,
	latestAnswers: ReadonlyArray<AskUserAnswer> = [],
): ToolResult {
	const interview = compactInterview(policy, event, latestAnswers);
	return {
		kind: "ok",
		output: renderAskUserState(policy, event, latestAnswers),
		details: {
			interview,
			answers: latestAnswers,
			decisions: policy.decisions,
			...(policy.status === "cancelled" ? { cancelled: true } : {}),
		},
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
	if (decisions.length > 0) upsertDecisions(policy, decisions);
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

export async function finalizeAskUserInterview(
	policy: AskUserToolPolicy,
	reason: string,
	options?: ToolInvokeOptions,
): Promise<void> {
	if (policy.status === "idle" && policy.rounds.length === 0) return;
	if (policy.status !== "complete" && policy.status !== "cancelled") {
		const now = new Date().toISOString();
		policy.status = "complete";
		policy.updatedAt = now;
		policy.endedAt = now;
		policy.summary = policy.summary ?? `Interview closed by host: ${reason}.`;
	}
	await persistAskUserTranscript(policy, options);
}

async function defaultAskUserHandler(): Promise<AskUserResult> {
	return cancelledAskUserResult();
}

export function createAskUserTool(deps: AskUserToolDeps = {}): ToolSpec {
	return {
		name: ToolNames.AskUser,
		description:
			"Run a host-owned operator interview: action=ask presents questions, action=complete records compact decisions before final prose. If cancelled, proceed with defaults and do not ask again.",
		parameters: askUserParameters,
		baseActionClass: "read",
		executionMode: "sequential",
		async run(args, options): Promise<ToolResult> {
			const normalized = normalizeAskUserCall(args);
			if (!normalized.call) return { kind: "error", message: `ask_user: ${normalized.error ?? "invalid input"}` };
			const policy = options?.askUserPolicy ?? createStandalonePolicy(options);
			hydratePolicy(policy, options);
			const call = normalized.call;

			if (call.action === "complete") {
				return completeInterview(policy, "complete", options, call.summary, call.decisions ?? []);
			}
			const questions = call.questions ?? [];
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
			if (policy.status === "complete") {
				await persistAskUserTranscript(policy, options);
				return okInterviewResult(policy, "already_complete");
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

			const requestedAt = new Date().toISOString();
			policy.inFlight = true;
			policy.status = "active";
			policy.updatedAt = requestedAt;
			if (call.summary) policy.summary = call.summary;
			const handler = deps.askUser ?? defaultAskUserHandler;
			try {
				const result = normalizeAskUserResult(questions, await handler(questions, options));
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
					policy.status = "cancelled";
					policy.cancelled = true;
					policy.endedAt = answeredAt;
					await persistAskUserTranscript(policy, options);
					return okInterviewResult(policy, "cancelled", []);
				}
				const derived = deriveAnswerDecisions(questions, result.answers, policy);
				upsertDecisions(policy, derived);
				await persistAskUserTranscript(policy, options);
				return okInterviewResult(policy, "round_answered", result.answers);
			} finally {
				policy.inFlight = false;
			}
		},
	};
}
