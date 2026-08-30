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

import {
	isResponseSchemaRejection,
	type ResponseSchemaDialect,
	responseSchemaDialectFor,
} from "../core/response-schema.js";
import { stream } from "../engine/ai.js";
import { patchResponseSchemaPayloadForDialect } from "../engine/provider-payload.js";
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

/**
 * One out-of-turn round against the session's live runtime. `/btw` and
 * `/handoff` are both this: read the compiled history the next turn would see,
 * append one instruction, send no tools, and never touch the turn state
 * machine. Only the system prompt and the appended message differ.
 */
export interface OutOfTurnRoundInput extends Omit<SideQuestionInput, "question"> {
	systemPrompt: string;
	/** The one message appended to the read-only copy of the history. */
	userText: string;
	/**
	 * Bind the answer to a JSON schema on the wire, where the runtime takes one.
	 *
	 * A round that asked for a schema in prose and bound nothing is what made
	 * `/handoff` refuse on local targets: the model answered with prose around
	 * the object, or with no object at all, and the parser had nothing to work
	 * with (issue #223). Absent, or on a runtime with no dialect, the request
	 * goes out exactly as before and the prompt-level instruction carries it.
	 */
	responseSchema?: { name: string; schema: Record<string, unknown> };
	/** Resolved runtime id, which is what decides the wire dialect. */
	runtimeId?: string;
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

/**
 * Normalize one provider usage object into the shape `/cost` and the
 * out-of-turn usage store take. Shared with the session pre-warm, which is
 * another call billed beside the session rather than inside it.
 */
export function sideQuestionUsage(raw: unknown): SideQuestionUsage | null {
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
	const { question, ...rest } = input;
	return runOutOfTurnRound({ ...rest, systemPrompt: SIDE_QUESTION_SYSTEM_PROMPT, userText: question });
}

interface SchemaBinding {
	dialect: ResponseSchemaDialect;
	name: string;
	schema: Record<string, unknown>;
}

/** The schema binding for this round, or null when nothing can be bound on the wire. */
function schemaBindingFor(input: OutOfTurnRoundInput): SchemaBinding | null {
	if (input.responseSchema === undefined || input.runtimeId === undefined) return null;
	const dialect = responseSchemaDialectFor(input.runtimeId);
	return dialect === null ? null : { dialect, ...input.responseSchema };
}

/** The shared round. See {@link OutOfTurnRoundInput}. */
export async function runOutOfTurnRound(input: OutOfTurnRoundInput): Promise<SideQuestionResult> {
	const binding = schemaBindingFor(input);
	if (binding === null) return runRound(input, null);
	try {
		return await runRound(input, binding);
	} catch (error) {
		// Native enforcement is an optimization here, never a precondition. A
		// server that refuses the constrained request answers with the same 400
		// the worker seam already recognizes, and the round is worth more
		// unconstrained than not at all. Anything else is a real failure and
		// rejects, so a broken target still costs exactly one round.
		if (input.signal?.aborted === true) throw error;
		if (!isResponseSchemaRejection(error instanceof Error ? error.message : String(error))) throw error;
		return runRound(input, null);
	}
}

async function runRound(input: OutOfTurnRoundInput, binding: SchemaBinding | null): Promise<SideQuestionResult> {
	const options: Record<string, unknown> = { maxTokens: input.maxTokens ?? SIDE_QUESTION_MAX_TOKENS };
	if (input.apiKey !== undefined) options.apiKey = input.apiKey;
	if (input.signal !== undefined) options.signal = input.signal;
	if (binding !== null) {
		options.onPayload = (payload: unknown): unknown | undefined =>
			patchResponseSchemaPayloadForDialect(payload, binding.dialect, binding.schema, binding.name);
	}

	const context = {
		systemPrompt: input.systemPrompt,
		messages: [
			...input.messages,
			{ role: "user", content: [{ type: "text", text: input.userText }], timestamp: Date.now() },
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
