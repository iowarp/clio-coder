import type { CallObservation } from "../core/call-failure.js";
import { trackCallFetch } from "../core/call-failure.js";
import type { SideCallAuth } from "../core/oauth-retry.js";
import { rememberOAuthCallFailure, withOAuthRefresh } from "../core/oauth-retry.js";
import type { AdmissionHold, CallJournalOptions, CallScope } from "../domains/observability/call-scope.js";
import { openCallScope } from "../domains/observability/call-scope.js";
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
 * The call goes through the same `src/engine/ai.ts` simple-stream seam compaction
 * uses for its summarization call, which is what keeps this outside the turn state
 * machine without adding an engine seam of its own. Tools are never sent.
 */

import type { ThinkingLevel } from "../core/defaults.js";
import {
	isResponseSchemaRejection,
	type ResponseSchemaDialect,
	responseFormatFor,
	responseSchemaDialectFor,
} from "../core/response-schema.js";
import { normalizeTokenUsage } from "../core/token-split.js";
import { streamSimple } from "../engine/ai.js";
import { readDiffusionFrame } from "../engine/apis/diffusion-frames.js";
import { stripDeadToolCallMarkup } from "../engine/loop-guard.js";
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
	cacheWrite1h?: number;
	reasoning: number;
	totalTokens: number;
	costUsd: number;
}

export interface SideQuestionInput extends SideCallAuth {
	telemetry?: CallJournalOptions;
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
	/**
	 * The reasoning level this round asks for. The engine's bare `stream` infers
	 * "medium" for any reasoning model, so a round that named no level reasoned
	 * at full length on reasoning-by-default models and could spend its whole
	 * output budget before it answered.
	 */
	thinkingLevel: ThinkingLevel;
	/** Streamed answer text, delivered as the provider produces it. */
	onDelta?: (partialText: string) => void;
	onUsage?: (usage: SideQuestionUsage | null, observation?: CallObservation) => void;
	/**
	 * Information-flow admission of this send: the block reason, or null. The
	 * round sends the session's history, so it is judged like a turn would be.
	 * Asked before `beforeRequest`, and again for a schema-free retry.
	 */
	admitFlow?: () => string | null;
	/**
	 * A turn was in flight when the round was prepared, so a trailing tool call
	 * may still be running. Only then does the round close it with a synthetic
	 * result (#415).
	 */
	midTurn?: boolean;
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
	/** Sampling temperature; absent leaves the provider's default. `/draft` spreads it across candidates. */
	temperature?: number;
	/**
	 * Optional host admission and accounting apply to each attempt, including a schema retry. Its time is the
	 * attempt's admission stage; it sets `hold.waitedOn` when a ceiling or capacity held the request (#434).
	 */
	// biome-ignore lint/suspicious/noConfusingVoidType: an admission that mints no call of its own returns nothing.
	beforeRequest?: (hold: AdmissionHold) => Promise<void | RequestCallContext>;
}

/** A caller that minted its own journal call for the request runs the stream inside it (#429, #434). */
export interface RequestCallContext {
	withContext?: <T>(work: () => T) => T;
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
 * Normalize one provider usage object into the shape `/usage` and the
 * out-of-turn usage store take. Shared with the session pre-warm, which is
 * another call billed beside the session rather than inside it.
 */
export function sideQuestionUsage(raw: unknown): SideQuestionUsage | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const usage = raw as Partial<Usage> & { reasoning?: number };
	const { input, output, cacheRead, cacheWrite, reasoning, totalTokens, observed } = normalizeTokenUsage(
		raw as Record<string, unknown>,
	);
	if (!observed) return null;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: positive(usage.cacheWrite1h) }),
		reasoning,
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
 * (which is still real money and is reported to `/usage`), and whether the
 * operator aborted it. Provider failures reject; the caller renders the reason
 * in the overlay.
 */
export async function runSideQuestion(input: SideQuestionInput): Promise<SideQuestionResult> {
	const { question, ...rest } = input;
	const result = await runOutOfTurnRound({ ...rest, systemPrompt: SIDE_QUESTION_SYSTEM_PROMPT, userText: question });
	// History that used tools, sent with none declared, can make a model imitate
	// a call as text; the operator gets the reason, not the markup (#415). An
	// aborted partial was never a finished call, so it keeps only its prose.
	if (result.aborted) return { ...result, text: stripDeadToolCallMarkup(result.text) };
	if (result.text.length > 0 && stripDeadToolCallMarkup(result.text).length === 0)
		return { ...result, text: SIDE_QUESTION_TOOL_CALL_NOTE };
	return result;
}

export const SIDE_QUESTION_TOOL_CALL_NOTE = "The model answered with a tool call, which a side question cannot run.";

const PENDING_TOOL_RESULT_TEXT = "No result yet: this tool call was still running when the operator asked this.";

/**
 * A round taken while a turn is in flight can snapshot history that ends in an
 * assistant message whose calls have not returned. Pi would fill those with
 * "No result provided"; the side model is told the truth instead (#415).
 *
 * Idle history is left alone: nothing there is still running. An errored or
 * aborted assistant is never closed either, because Pi's transform drops that
 * message but keeps the results after it, and an orphan result is a 400.
 */
export function closePendingToolCalls(messages: ReadonlyArray<AgentMessage>, midTurn: boolean): AgentMessage[] {
	const out = [...messages];
	if (!midTurn) return out;
	const answered = new Set<unknown>();
	let index = out.length - 1;
	for (; index >= 0 && out[index]?.role === "toolResult"; index--)
		answered.add((out[index] as { toolCallId?: unknown }).toolCallId);
	const assistant = out[index] as { role?: unknown; content?: unknown; stopReason?: unknown } | undefined;
	if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) return out;
	if (assistant.stopReason === "error" || assistant.stopReason === "aborted") return out;
	const timestamp = Date.now();
	for (const block of assistant.content as Array<{ type?: unknown; id?: unknown; name?: unknown }>) {
		if (block?.type !== "toolCall" || answered.has(block.id)) continue;
		out.push({
			role: "toolResult",
			toolCallId: block.id,
			toolName: block.name,
			content: [{ type: "text", text: PENDING_TOOL_RESULT_TEXT }],
			isError: false,
			timestamp,
		} as unknown as AgentMessage);
	}
	return out;
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
	const scope = await openCallScope(input.telemetry, input.model);
	try {
		return await withOAuthRefresh(input, (auth) => runOutOfTurnAttempt({ ...input, ...auth }, scope));
	} finally {
		await scope.close();
	}
}

async function runOutOfTurnAttempt(input: OutOfTurnRoundInput, scope: CallScope): Promise<SideQuestionResult> {
	const binding = schemaBindingFor(input);
	if (binding === null) return runRound(input, null, scope);
	try {
		return await runRound(input, binding, scope);
	} catch (error) {
		// Native enforcement is an optimization here, never a precondition. A
		// server that refuses the constrained request answers with the same 400
		// the worker seam already recognizes, and the round is worth more
		// unconstrained than not at all. Anything else is a real failure and
		// rejects, so a broken target still costs exactly one round.
		if (input.signal?.aborted === true) throw error;
		if (!isResponseSchemaRejection(error instanceof Error ? error.message : String(error))) throw error;
		return runRound(input, null, scope);
	}
}

async function runRound(
	input: OutOfTurnRoundInput,
	binding: SchemaBinding | null,
	scope: CallScope,
): Promise<SideQuestionResult> {
	scope.startAttempt();
	const tracking = trackCallFetch();
	let observed = false;
	let terminalError: unknown;
	let text = "";
	try {
		let requestCall: RequestCallContext | undefined;
		await scope.admit(async (hold) => {
			const flowRefusal = input.admitFlow?.() ?? null;
			if (flowRefusal !== null) throw new Error(flowRefusal);
			requestCall = (await input.beforeRequest?.(hold)) ?? undefined;
		});
		input.signal?.throwIfAborted();
		const options: Record<string, unknown> = {
			maxTokens: input.maxTokens ?? SIDE_QUESTION_MAX_TOKENS,
			fetch: tracking.fetch,
		};
		if (input.apiKey !== undefined) options.apiKey = input.apiKey;
		if (input.signal !== undefined) options.signal = input.signal;
		if (input.temperature !== undefined) options.temperature = input.temperature;
		// The agent loop's convention: "off" sends no reasoning option, which the
		// simple-stream seam resolves to thinking off for every provider.
		if (input.thinkingLevel !== "off") options.reasoning = input.thinkingLevel;
		if (binding !== null) {
			options.samplingParams = { response_format: responseFormatFor(binding.dialect, binding.schema, binding.name) };
		}

		const context = {
			systemPrompt: input.systemPrompt,
			messages: [
				// Pi 0.86 stores prompt/tool declarations in history. This tool-free
				// round has its own prompt and must not inherit those declarations.
				...closePendingToolCalls(
					input.messages.filter((message) => message.role !== "system"),
					input.midTurn === true,
				),
				{ role: "user", content: [{ type: "text", text: input.userText }], timestamp: Date.now() },
			],
		};

		tracking.start(input.model.api);
		const stream = () =>
			scope.withContext(() =>
				streamSimple(
					input.model,
					context as unknown as Parameters<typeof streamSimple>[1],
					options as unknown as Parameters<typeof streamSimple>[2],
				),
			);
		// The round's own scope stays innermost, so a journaled round keeps its call either way.
		const events = requestCall?.withContext ? requestCall.withContext(stream) : stream();

		for await (const event of events) {
			if (event.type === "text_delta") {
				// A diffusion frame carries the whole answer so far; the shared partial
				// can already hold the next frame appended to it.
				text = readDiffusionFrame(event)?.text ?? textFromMessage(event.partial);
				// Imitated call markup never flashes in the overlay before the
				// final answer replaces or rejects it (#415).
				const shown = stripDeadToolCallMarkup(text);
				if (shown.length > 0) input.onDelta?.(shown);
				continue;
			}
			if (event.type === "done") {
				const facts = scope.settle(event.message);
				const answer = textFromMessage(event.message).trim();
				const usage = sideQuestionUsage((event.message as { usage?: unknown }).usage);
				observed = true;
				input.onUsage?.(usage, {
					callOutcome: "success",
					...(facts ? { callId: facts.callId, attemptId: facts.attemptId } : {}),
				});
				return { text: answer, usage, aborted: false };
			}
			if (event.type === "error") {
				const failed = event.error as { stopReason?: unknown; usage?: unknown; errorMessage?: unknown };
				const usage = sideQuestionUsage(failed.usage);
				observed = true;
				const aborted = event.reason === "aborted" || failed.stopReason === "aborted" || input.signal?.aborted === true;
				const facts = scope.settle({ ...failed, failure: tracking.failure(failed, aborted, usage !== null) });
				input.onUsage?.(usage, {
					...(facts ? { callId: facts.callId, attemptId: facts.attemptId } : {}),
					callOutcome: aborted ? "aborted" : "error",
					failure: tracking.failure(failed, aborted, usage !== null),
				});
				if (event.reason === "aborted" || failed.stopReason === "aborted" || input.signal?.aborted === true) {
					return { text: text.trim(), usage, aborted: true };
				}
				throw new Error(typeof failed.errorMessage === "string" ? failed.errorMessage : "side question failed");
			}
		}
		throw new Error("side question stream ended without a terminal response");
	} catch (error) {
		terminalError = error;
		rememberOAuthCallFailure(error, tracking.failure(error, input.signal?.aborted));
		throw error;
	} finally {
		if (!observed) {
			const facts = scope.settle({
				stopReason: input.signal?.aborted ? "aborted" : "error",
				failure: tracking.failure(terminalError, input.signal?.aborted),
			});
			input.onUsage?.(null, {
				...(facts ? { callId: facts.callId, attemptId: facts.attemptId } : {}),
				callOutcome: input.signal?.aborted ? "aborted" : "error",
				failure: tracking.failure(terminalError, input.signal?.aborted),
			});
		}
	}
}
