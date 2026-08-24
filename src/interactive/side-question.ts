/**
 * `/btw`: one model round beside the session, never inside it.
 *
 * A fleet run briefs its workers from the transcript, so every question the
 * operator asks mid-run to orient themselves ("which file did that land in
 * again?") becomes context the workers inherit. This round reads the compiled
 * history the next turn would send and answers into an overlay; nothing it
 * produces reaches the session JSONL, the transcript panel, the context ledger,
 * or the task board, and it never becomes a turn.
 *
 * The call goes through the same `src/engine/ai.ts` stream seam compaction uses
 * for its summarization call, which is what keeps this outside the turn state
 * machine without adding an engine seam of its own. Tools are never sent.
 */

import { stream } from "../engine/ai.js";
import type { AgentMessage, EngineModel, Usage } from "../engine/types.js";

/**
 * The whole system prompt for the round. The session's own compiled prompt is
 * deliberately not reused: it carries the working agreement for a turn that
 * edits files and calls tools, and this round does neither.
 */
export const SIDE_QUESTION_SYSTEM_PROMPT = [
	"You are answering a side question from the operator of a coding session.",
	"The conversation above is read-only context. Answer the question directly and briefly.",
	"Do not continue the conversation, do not propose edits, and do not call tools.",
].join(" ");

/** Default output budget for the round. A side question wants an answer, not an essay. */
export const SIDE_QUESTION_MAX_TOKENS = 2048;

export interface SideQuestionUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	costUsd: number;
}

export interface SideQuestionInput {
	/** Live model the next turn would use, taken from the session's active runtime. */
	model: EngineModel;
	/**
	 * The compiled message history the next turn would send. Treated as
	 * read-only: the round copies it and appends its own user message to the
	 * copy, so the live agent's message list is never mutated.
	 */
	messages: ReadonlyArray<AgentMessage>;
	question: string;
	apiKey?: string;
	signal?: AbortSignal;
	maxTokens?: number;
	/** Streamed answer text, delivered as the provider produces it. */
	onDelta?: (partialText: string) => void;
}

export interface SideQuestionResult {
	text: string;
	usage: SideQuestionUsage | null;
	/** True when the operator cancelled the round with Esc or Ctrl+C. */
	aborted: boolean;
}

function positive(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function sideQuestionUsage(raw: unknown): SideQuestionUsage | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const usage = raw as Partial<Usage> & { reasoning?: number };
	const input = positive(usage.input);
	const output = positive(usage.output);
	const cacheRead = positive(usage.cacheRead);
	const cacheWrite = positive(usage.cacheWrite);
	const totalTokens = positive(usage.totalTokens) || input + output + cacheRead + cacheWrite;
	if (totalTokens === 0) return null;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning: positive(usage.reasoning),
		totalTokens,
		costUsd: positive(usage.cost?.total),
	};
}

function textFromMessage(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				!!block &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("");
}

/**
 * Run the side-question round. Resolves with the answer, the provider usage
 * (which is still real money and is reported to `/cost`), and whether the
 * operator aborted it. Provider failures reject; the caller renders the reason
 * in the overlay.
 */
export async function runSideQuestion(input: SideQuestionInput): Promise<SideQuestionResult> {
	const options: Record<string, unknown> = { maxTokens: input.maxTokens ?? SIDE_QUESTION_MAX_TOKENS };
	if (input.apiKey !== undefined) options.apiKey = input.apiKey;
	if (input.signal !== undefined) options.signal = input.signal;

	const context = {
		systemPrompt: SIDE_QUESTION_SYSTEM_PROMPT,
		messages: [
			...input.messages,
			{ role: "user", content: [{ type: "text", text: input.question }], timestamp: Date.now() },
		],
	};

	const events = stream(
		input.model,
		context as unknown as Parameters<typeof stream>[1],
		options as unknown as Parameters<typeof stream>[2],
	);

	let text = "";
	for await (const event of events) {
		if (event.type === "text_delta") {
			text = textFromMessage(event.partial);
			input.onDelta?.(text);
			continue;
		}
		if (event.type === "done") {
			const answer = textFromMessage(event.message).trim();
			return { text: answer, usage: sideQuestionUsage((event.message as { usage?: unknown }).usage), aborted: false };
		}
		if (event.type === "error") {
			const failed = event.error as { stopReason?: unknown; usage?: unknown; errorMessage?: unknown };
			if (event.reason === "aborted" || failed.stopReason === "aborted" || input.signal?.aborted === true) {
				return { text: text.trim(), usage: sideQuestionUsage(failed.usage), aborted: true };
			}
			throw new Error(typeof failed.errorMessage === "string" ? failed.errorMessage : "side question failed");
		}
	}
	return { text: text.trim(), usage: null, aborted: input.signal?.aborted === true };
}
