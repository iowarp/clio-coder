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

/** The name the wire dialect gives the schema, where it takes one. */
export const HANDOFF_SCHEMA_NAME = "handoff_record";

/** Characters of the refused answer quoted back to the model in the repair round. */
export const HANDOFF_REPAIR_QUOTE_CHARS = 600;

/**
 * What the first round returned and why the parser refused it. The repair round
 * shows the model both, because "return one JSON object" repeated verbatim is
 * the instruction it already failed (issue #223).
 */
export interface HandoffRepairInput {
	complaint: string;
	previous: string;
}

export interface HandoffRoundInput {
	model: EngineModel;
	/** Read-only. The round copies before appending its own message. */
	messages: ReadonlyArray<AgentMessage>;
	goal: string;
	apiKey?: string;
	signal?: AbortSignal;
	maxTokens?: number;
	/** Resolved runtime id, which decides whether the schema can be bound on the wire. */
	runtimeId?: string;
	/** Set on the second and last round, after the parser refused the first. */
	repair?: HandoffRepairInput;
}

function repairText(goal: string, repair: HandoffRepairInput): string {
	const quoted = repair.previous.slice(0, HANDOFF_REPAIR_QUOTE_CHARS);
	return [
		`The next session's goal is: ${goal}`,
		"",
		"Your previous answer could not be read as a handoff record.",
		`The parser said: ${repair.complaint}`,
		"This is what you returned, verbatim:",
		"---",
		quoted.length > 0 ? quoted : "(nothing)",
		"---",
		"Answer again with one JSON object matching the schema and nothing else.",
		"No prose before it, no prose after it, no code fence.",
	].join("\n");
}

/** Run the round. Provider failures reject; the caller renders the reason. */
export async function runHandoffRound(input: HandoffRoundInput): Promise<SideQuestionResult> {
	const { goal, repair, ...rest } = input;
	return runOutOfTurnRound({
		...rest,
		maxTokens: input.maxTokens ?? HANDOFF_MAX_TOKENS,
		systemPrompt: HANDOFF_SYSTEM_PROMPT,
		responseSchema: { name: HANDOFF_SCHEMA_NAME, schema: HANDOFF_RESPONSE_SCHEMA },
		userText: repair
			? repairText(goal, repair)
			: `The next session's goal is: ${goal}\n\nExtract the handoff record for that goal now.`,
	});
}
