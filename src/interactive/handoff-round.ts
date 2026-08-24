/**
 * The `/handoff` extraction round: one model call beside the session, no tools.
 *
 * It rides the same out-of-turn seam `/btw` uses, for the same reason: the
 * input is the compiled message history the next turn would see, and the round
 * must not enter the turn state machine, the transcript, or the ledger. The
 * only difference is the instruction and the output contract, which is JSON
 * validated against `HANDOFF_RESPONSE_SCHEMA` on the way back.
 */

import { HANDOFF_RESPONSE_SCHEMA } from "../domains/session/handoff.js";
import type { AgentMessage, EngineModel } from "../engine/types.js";
import { runOutOfTurnRound, type SideQuestionResult } from "./side-question.js";

/**
 * The whole system prompt for the round. The session's own compiled prompt is
 * not reused: it carries the working agreement for a turn that edits files and
 * calls tools, and this round does neither.
 */
export const HANDOFF_SYSTEM_PROMPT = [
	"You are extracting a handoff record from a coding session that is about to end.",
	"The conversation above is read-only context.",
	"Answer with one JSON object and nothing else: no prose, no code fence, no explanation.",
	"decisions are choices this session settled, each with a summary and an optional rationale.",
	"facts are durable statements about the work that the next session needs.",
	"files name paths this session actually opened, edited, or searched, each with why it matters.",
	"commands are shell invocations worth repeating, each with why.",
	"openQuestions are what is still unresolved.",
	"Never invent a file path. Every path must be one this conversation shows a tool call touching.",
	"Leave a list empty rather than filling it with guesses.",
	`The object must match this JSON schema exactly: ${JSON.stringify(HANDOFF_RESPONSE_SCHEMA)}`,
].join(" ");

/** A handoff record is a list of short entries, so the budget is modest. */
export const HANDOFF_MAX_TOKENS = 4096;

export interface HandoffRoundInput {
	model: EngineModel;
	/** Read-only. The round copies before appending its own message. */
	messages: ReadonlyArray<AgentMessage>;
	goal: string;
	apiKey?: string;
	signal?: AbortSignal;
	maxTokens?: number;
}

/** Run the round. Provider failures reject; the caller renders the reason. */
export async function runHandoffRound(input: HandoffRoundInput): Promise<SideQuestionResult> {
	const { goal, ...rest } = input;
	return runOutOfTurnRound({
		...rest,
		maxTokens: input.maxTokens ?? HANDOFF_MAX_TOKENS,
		systemPrompt: HANDOFF_SYSTEM_PROMPT,
		userText: `The next session's goal is: ${goal}\n\nExtract the handoff record for that goal now.`,
	});
}
