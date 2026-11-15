import { markHostAuthored } from "../core/message-accounting.js";
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

export function repetitionAbortReason(assessment: Extract<RepetitionAssessment, { kind: "repeating" }>): string {
	const unit = assessment.unit.length > 80 ? `${assessment.unit.slice(0, 79)}…` : assessment.unit;
	return `[Clio Coder] stopped a model response that kept repeating itself ("${unit}" ${assessment.repeats} times in its last stretch).`;
}

export const REPETITION_REPROMPT_TOOL = "clio_repetition_reprompt";
export const REPETITION_REPROMPT_NOTICE_KEY = "turn.repetition-reprompt";

/**
 * The one nudge after a stopped repetition. A paired synthetic tool exchange,
 * never a user turn, as the locked-synthesis repair is: a late user message
 * re-renders earlier turns on templates keyed off the last user message and
 * invalidates the prompt cache (#55).
 */
export function repetitionRepromptMessages(origin: {
	provider: string;
	api: string;
	model: string;
}): ReadonlyArray<AgentMessage> {
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
			content: [
				{
					type: "text",
					text:
						"Your last response was stopped because it kept repeating the same sentences without acting or answering. " +
						"Do not repeat it. Make the next tool call the task needs, or answer now from what you already have.",
				},
			],
			isError: true,
			timestamp,
		},
	] as unknown as ReadonlyArray<AgentMessage>;
}
