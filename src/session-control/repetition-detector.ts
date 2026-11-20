import { markHostAuthored } from "../core/message-accounting.js";
import { ToolNames } from "../core/tool-names.js";
import type { AgentMessage } from "../engine/types.js";

/**
 * Degenerate generation: a stream that repeats the same sentences instead of
 * acting or answering. The silence watchdog never fires on it because tokens
 * keep arriving (WTF-P campaign, 2026-11-15: 147K characters of thinking
 * cycling three sentences for seven minutes; 18K output tokens of three
 * paragraphs repeated 44 times, ending with no text).
 *
 * The check is lexical and bounded: the trailing window of one streamed block
 * (thinking or text) split into sentences and lines, long units only. A
 * stream repeats when one unit occurs at least `MIN_REPEATS` times in the
 * window and units seen three or more times cover most of it. Legitimate
 * output rarely does either: table rows and log lines differ, and short
 * repeated lines (`}`, `---`) are below the unit floor.
 */
const WINDOW_CHARS = 12_000;
const MIN_STREAM_CHARS = 4_000;
const CHECK_EVERY_CHARS = 1_024;
const MIN_UNIT_CHARS = 30;
const MIN_REPEATS = 5;
const MIN_COVERAGE = 0.6;

export type RepetitionAssessment = { kind: "ok" } | { kind: "repeating"; unit: string; repeats: number };

/** Assess only a stream long enough to loop, and only after it grew a step since the last check. */
export function shouldAssessRepetition(length: number, assessedChars: number): boolean {
	return length >= MIN_STREAM_CHARS && length - assessedChars >= CHECK_EVERY_CHARS;
}

export function assessRepetition(text: string): RepetitionAssessment {
	const units = text
		.slice(-WINDOW_CHARS)
		.split(/(?<=[.!?])\s+|\n+/u)
		.map((unit) => unit.toLowerCase().replace(/\s+/gu, " ").trim())
		.filter((unit) => unit.length >= MIN_UNIT_CHARS);
	if (units.length < MIN_REPEATS) return { kind: "ok" };
	const counts = new Map<string, number>();
	for (const unit of units) counts.set(unit, (counts.get(unit) ?? 0) + 1);
	let top = "";
	let topCount = 0;
	let total = 0;
	let repeated = 0;
	for (const unit of units) {
		const count = counts.get(unit) ?? 0;
		total += unit.length;
		if (count >= 3) repeated += unit.length;
		if (count > topCount) {
			top = unit;
			topCount = count;
		}
	}
	return topCount >= MIN_REPEATS && repeated / total >= MIN_COVERAGE
		? { kind: "repeating", unit: top, repeats: topCount }
		: { kind: "ok" };
}

/**
 * A deliberation loop the sentence check misses (bt-25): reasoning that keeps re-drafting the same code, where each
 * repeated unit is a short line (`class Clock:` 28 times in 68K characters) and most lines still differ. Only long
 * reasoning is judged, and only several distinct lines that each recur many times count, which a single draft or a
 * table of varied rows never reaches.
 */
const DRAFT_MIN_CHARS = 24_000;
const DRAFT_WINDOW_CHARS = 48_000;
const DRAFT_MIN_LINE_CHARS = 12;
const DRAFT_MIN_REPEATS = 10;
const DRAFT_MIN_LINES = 3;

export function assessDraftLoop(thinking: string): RepetitionAssessment {
	if (thinking.length < DRAFT_MIN_CHARS) return { kind: "ok" };
	const counts = new Map<string, number>();
	for (const raw of thinking.slice(-DRAFT_WINDOW_CHARS).split("\n")) {
		const line = raw.replace(/\s+/gu, " ").trim();
		if (line.length >= DRAFT_MIN_LINE_CHARS) counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	const looped = [...counts].filter(([, count]) => count >= DRAFT_MIN_REPEATS).sort((a, b) => b[1] - a[1]);
	const [top] = looped;
	return looped.length >= DRAFT_MIN_LINES && top !== undefined
		? { kind: "repeating", unit: top[0], repeats: top[1] }
		: { kind: "ok" };
}

/**
 * Reasoning with no budget the server enforces can spend the whole output cap before an answer or a call (bt-25:
 * 16384 tokens over 200 seconds, then a length stop). Past this share of the cap, a response that is still only
 * reasoning is stopped and re-prompted once, as a repeating one is, instead of running into the cap.
 */
const THINKING_OVERRUN_SHARE = 0.75;
const THINKING_OVERRUN_REASON_PREFIX = "[CLIO Coder] stopped a model response whose reasoning";

/** The stop reason once `thinkingChars` of reasoning (about four characters a token) reach the share of `outputCap`. */
export function thinkingOverrunReason(thinkingChars: number, outputCap: number | undefined): string | null {
	if (outputCap === undefined || !Number.isFinite(outputCap) || outputCap <= 0) return null;
	const tokens = Math.round(thinkingChars / 4);
	if (tokens < outputCap * THINKING_OVERRUN_SHARE) return null;
	return `${THINKING_OVERRUN_REASON_PREFIX} reached about ${tokens} tokens of its ${outputCap}-token output limit with no answer or tool call yet.`;
}

export function repetitionAbortReason(assessment: Extract<RepetitionAssessment, { kind: "repeating" }>): string {
	const unit = assessment.unit.length > 80 ? `${assessment.unit.slice(0, 79)}…` : assessment.unit;
	return `[CLIO Coder] stopped a model response that kept repeating itself ("${unit}" ${assessment.repeats} times in its last stretch).`;
}

/**
 * The same loop in tool calls: one response that streams the same call again
 * and again (bt-39: 99 `write` calls rewriting one file, run to the output cap,
 * where each then failed as truncated). Parallel calls in one response differ
 * in their arguments, so only a call repeated with the same arguments counts;
 * the leading characters of its arguments stand for them, as a rewrite with a
 * drifting tail is still the same call. A whole-file `write` repeated to one
 * path is the same loop whatever its content says, since each write replaces
 * the last; edits to one path are not, as parallel hunks differ (bt-39 b).
 */
const FLOOD_MIN_REPEATS = 5;
const FLOOD_ARGUMENT_CHARS = 200;
const TOOL_CALL_FLOOD_REASON_PREFIX = "[CLIO Coder] stopped a model response that kept repeating one tool call";

export type ToolCallFloodAssessment =
	| { kind: "ok" }
	| { kind: "flooding"; toolName: string; repeats: number; path?: string };

/** Judge the first `completeBlocks` content blocks of a streamed message, the ones whose arguments are final. */
export function assessToolCallFlood(message: unknown, completeBlocks: number): ToolCallFloodAssessment {
	const content = (message as { content?: unknown } | null | undefined)?.content;
	if (!Array.isArray(content)) return { kind: "ok" };
	const counts = new Map<string, number>();
	for (const block of content.slice(0, completeBlocks) as Array<{
		type?: unknown;
		name?: unknown;
		arguments?: unknown;
	}>) {
		if (block?.type !== "toolCall" || typeof block.name !== "string") continue;
		const args = (JSON.stringify(block.arguments ?? {}) ?? "").replace(/\s+/gu, " ").slice(0, FLOOD_ARGUMENT_CHARS);
		const key = `${block.name}\n${args}`;
		const repeats = (counts.get(key) ?? 0) + 1;
		counts.set(key, repeats);
		if (repeats >= FLOOD_MIN_REPEATS) return { kind: "flooding", toolName: block.name, repeats };
		const path = (block.arguments as { path?: unknown } | null | undefined)?.path;
		if (block.name !== ToolNames.Write || typeof path !== "string") continue;
		const pathKey = `${block.name}\npath\n${path}`;
		const writes = (counts.get(pathKey) ?? 0) + 1;
		counts.set(pathKey, writes);
		if (writes >= FLOOD_MIN_REPEATS) return { kind: "flooding", toolName: block.name, repeats: writes, path };
	}
	return { kind: "ok" };
}

export function toolCallFloodAbortReason(assessment: Extract<ToolCallFloodAssessment, { kind: "flooding" }>): string {
	const basis =
		assessment.path === undefined
			? "with the same arguments"
			: `to ${assessment.path.length > 80 ? `${assessment.path.slice(0, 79)}…` : assessment.path}`;
	return `${TOOL_CALL_FLOOD_REASON_PREFIX} ("${assessment.toolName}" ${assessment.repeats} times ${basis} in one response).`;
}

export const REPETITION_REPROMPT_TOOL = "clio_repetition_reprompt";
export const REPETITION_REPROMPT_NOTICE_KEY = "turn.repetition-reprompt";

/**
 * Recoveries one operator turn may spend on stopped repetition. The first is a plain nudge that keeps the request
 * and its cached prefix. A plain nudge does not break every model's loop (nemotron loops again, SC-5), so when its
 * run is stopped too the second changes the request: a firmer instruction, sent with thinking one step lower. A
 * stop after that ends the turn on its reason.
 */
const REPETITION_RECOVERY_STAGES = 2;

export type RepetitionRecoveryStage = 1 | 2;

/** The recovery a stopped repetition gets next in this operator turn, or null when there is none to run. */
export function repetitionRecoveryStage(state: {
	readonly repetitionAbortReason: string | null;
	readonly activeInterruptReason: string | null;
	readonly activeUserTurnId: string | null;
	readonly repetitionRepromptTurnId: string | null;
	readonly repetitionRepromptStages: number;
}): RepetitionRecoveryStage | null {
	if (state.repetitionAbortReason === null || state.activeInterruptReason !== null || state.activeUserTurnId === null)
		return null;
	const spent = state.repetitionRepromptTurnId === state.activeUserTurnId ? state.repetitionRepromptStages : 0;
	return spent === 0 ? 1 : spent < REPETITION_RECOVERY_STAGES ? 2 : null;
}

/**
 * What the stopped attempt's `message_end` and `agent_end` carry when a recovery follows: the attempt closes, the
 * turn goes on, so it has no outcome of its own (bt-48-1). The shape is the retry ladder's forecast, which every
 * reader already takes to mean exactly that.
 */
export function repetitionRecoveryForecast(stage: RepetitionRecoveryStage): {
	attempt: number;
	maxAttempts: number;
	recovery: true;
} {
	return { attempt: stage, maxAttempts: REPETITION_RECOVERY_STAGES, recovery: true };
}

function repetitionRepromptText(stoppedFor: string, stage: RepetitionRecoveryStage): string {
	const flood = stoppedFor.startsWith(TOOL_CALL_FLOOD_REASON_PREFIX);
	const overrun = stoppedFor.startsWith(THINKING_OVERRUN_REASON_PREFIX);
	if (stage === 2)
		return flood
			? "Your response was stopped again for issuing the same tool call over and over, so none of those calls ran. " +
					"Make exactly ONE tool call with complete arguments and stop there, or answer in plain text if no call is needed."
			: overrun
				? "Your reasoning was stopped again after using most of the output limit with no answer or tool call. " +
					"Keep your reasoning to a few lines, then make one tool call or give your answer in a few sentences."
				: "Your response was stopped again for repeating the same sentences, so it was discarded. " +
					"Do not restate your plan. Begin with the one tool call the task needs, or give your answer now in a few sentences.";
	return flood
		? "Your last response was stopped because it issued the same tool call again and again, so none of those calls ran. " +
				"Do not repeat it. Make ONE tool call with complete arguments, read its result, then decide the next step."
		: overrun
			? "Your last response was stopped because its reasoning used most of the output limit without an answer or tool call, so it was discarded. " +
				"Do not re-derive it. Make the next tool call the task needs, or answer now from what you already have."
			: "Your last response was stopped because it kept repeating the same sentences without acting or answering. " +
				"Do not repeat it. Make the next tool call the task needs, or answer now from what you already have.";
}

/**
 * The nudge after a stopped repetition. A paired synthetic tool exchange,
 * never a user turn, as the locked-synthesis repair is: a late user message
 * re-renders earlier turns on templates keyed off the last user message and
 * invalidates the prompt cache (#55). `stoppedFor` is the stop's reason, which
 * says whether sentences or tool calls repeated; `stage` 2 is the firmer
 * wording of the changed second recovery.
 */
export function repetitionRepromptMessages(
	origin: {
		provider: string;
		api: string;
		model: string;
	},
	stoppedFor: string,
	stage: RepetitionRecoveryStage = 1,
): ReadonlyArray<AgentMessage> {
	const id = `clio-repetition-reprompt-${Date.now()}`;
	const timestamp = Date.now();
	return [
		markHostAuthored({
			role: "assistant",
			content: [{ type: "toolCall", id, name: REPETITION_REPROMPT_TOOL, arguments: {} }],
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				// Clio wrote this message; no provider was called for it.
				callInvoked: false,
			},
			...origin,
			timestamp,
		} as AgentMessage),
		{
			role: "toolResult",
			toolCallId: id,
			toolName: REPETITION_REPROMPT_TOOL,
			content: [{ type: "text", text: repetitionRepromptText(stoppedFor, stage) }],
			isError: true,
			timestamp,
		},
	] as unknown as ReadonlyArray<AgentMessage>;
}
