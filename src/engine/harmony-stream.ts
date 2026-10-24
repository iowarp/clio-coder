/**
 * Harmony recovery for the OpenAI-compatible stream of a gpt-oss model (#435).
 *
 * pi parses `content`, the reasoning fields and `tool_calls` into blocks. A
 * server without Harmony parsers leaves the analysis channel and the tool call
 * inside `content`, so this wrapper runs `HarmonyResponseParser` over pi's text
 * blocks and projects the result into its own message: the final channel stays
 * text, analysis becomes thinking blocks with live `thinking_*` events, and a
 * `to=functions.<name>` body becomes a synthesized tool call once the text
 * block ends and no structured `tool_calls` arrived. Structured calls win; a
 * recovered duplicate, a provider-artifact name and an unparsable incomplete
 * call are dropped into thinking and recorded on `message.harmonyRecovery`.
 *
 * The projection never shares pi's block array: pi finalizes every block it
 * owns at stream end, and a foreign toolCall block there would have its
 * arguments re-parsed from an absent scratch buffer. Each forwarded event
 * carries a partial whose content is the projection, which is what
 * pi-agent-core stores for the message in flight.
 */

import { randomUUID } from "node:crypto";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type StopReason,
	type ThinkingContent,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	HARMONY_SERVER_ERROR_PATTERN,
	type HarmonyRecoveryObservation,
	harmonyIncompleteMessage,
	harmonyServerErrorMessage,
} from "./harmony-failure.js";
import { HarmonyResponseParser, type HarmonySegment, normalizeHarmonyToolName } from "./harmony-response.js";

declare module "@earendil-works/pi-ai" {
	interface AssistantMessage {
		/** What the Harmony recovery layer saw and changed on this response (#435). */
		harmonyRecovery?: HarmonyRecoveryObservation;
	}
}

export interface HarmonyStreamOptions {
	/**
	 * Replay field for thinking recovered from raw markers, from the resolved
	 * runtime capability (`response.recoveredReasoningField`). It applies only
	 * to a response whose reasoning came back inside `content`; a thinking block
	 * the server streamed in a reasoning field keeps pi's own signature.
	 */
	recoveredThinkingSignature: string;
}

type ContentBlock = AssistantMessage["content"][number];
type PartialEvent = Extract<AssistantMessageEvent, { partial: AssistantMessage }>;
type ToolSegment = Extract<HarmonySegment, { kind: "tool" }>;

interface TextState {
	parser: HarmonyResponseParser;
	/** pi's text block; adopted into the projection on the first text segment, so thinking precedes it. */
	block: ContentBlock;
	index: number | null;
	text: string;
	openThinking: { block: ThinkingContent; index: number } | null;
	pendingTools: ToolSegment[];
}

type DoneReason = Extract<AssistantMessageEvent, { type: "done" }>["reason"];

/** A projected stop reason is `stop` or `toolUse`; anything else keeps pi's reason. */
function doneReason(stopReason: StopReason, fallback: DoneReason): DoneReason {
	return stopReason === "stop" || stopReason === "toolUse" ? stopReason : fallback;
}

function emptyObservation(): HarmonyRecoveryObservation {
	return {
		rawMarkers: false,
		recoveredThinking: false,
		recoveredAnalysis: false,
		synthesizedToolCalls: 0,
		structuredToolCalls: 0,
		structuredReasoning: false,
		droppedToolCalls: [],
		notes: [],
	};
}

function hasEvidence(observation: HarmonyRecoveryObservation): boolean {
	return (
		observation.rawMarkers ||
		observation.structuredToolCalls > 0 ||
		observation.structuredReasoning ||
		observation.droppedToolCalls.length > 0 ||
		observation.retry !== undefined
	);
}

type ToolArguments = ToolCall["arguments"];

function parseArguments(argsText: string): ToolArguments | null {
	try {
		const parsed: unknown = JSON.parse(argsText);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ToolArguments) : null;
	} catch {
		// The caller keeps the raw text so the tool layer can report it.
		return null;
	}
}

export function routeHarmonyStream(
	source: AssistantMessageEventStream,
	options: HarmonyStreamOptions,
	fail: (stream: AssistantMessageEventStream, cause: unknown) => void,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	(async () => {
		try {
			const projected: ContentBlock[] = [];
			/** pi content index to projected index; null when the block was dropped. */
			const indexMap = new Map<number, number | null>();
			const texts = new Map<number, TextState>();
			/** Finished text states whose raw tool segments wait for `done`, when every structured call is known. */
			const finishedTexts: TextState[] = [];
			/**
			 * A structured tool call is classified as soon as its name is known:
			 * at `toolcall_start` in the normal case, so its arguments still stream
			 * live. A gateway may stream the name in a later delta, and pi then
			 * opens the block with an empty name; only such a block has its start
			 * and delta events held until the first event that supplies the name.
			 */
			const heldToolEvents = new Map<number, PartialEvent[]>();
			const artifacts: ToolCall[] = [];
			const observation = emptyObservation();

			const partialOf = (event: PartialEvent): AssistantMessage => ({ ...event.partial, content: projected });
			const adopt = (event: PartialEvent & { contentIndex: number }): number => {
				const existing = indexMap.get(event.contentIndex);
				if (existing !== undefined) return existing ?? -1;
				const block = event.partial.content[event.contentIndex];
				if (block === undefined) return -1;
				projected.push(block);
				const index = projected.length - 1;
				indexMap.set(event.contentIndex, index);
				return index;
			};
			const ensureText = (state: TextState, piIndex: number, partial: AssistantMessage): number => {
				if (state.index !== null) return state.index;
				projected.push(state.block);
				state.index = projected.length - 1;
				indexMap.set(piIndex, state.index);
				output.push({ type: "text_start", contentIndex: state.index, partial });
				return state.index;
			};
			const closeThinking = (state: TextState, partial: AssistantMessage): void => {
				if (state.openThinking === null) return;
				const { block, index } = state.openThinking;
				state.openThinking = null;
				output.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial });
			};
			const appendThinking = (state: TextState, text: string, partial: AssistantMessage): void => {
				if (text.length === 0) return;
				if (state.openThinking === null) {
					const block: ThinkingContent = {
						type: "thinking",
						thinking: "",
						thinkingSignature: options.recoveredThinkingSignature,
					};
					projected.push(block);
					state.openThinking = { block, index: projected.length - 1 };
					output.push({ type: "thinking_start", contentIndex: state.openThinking.index, partial });
				}
				state.openThinking.block.thinking += text;
				output.push({ type: "thinking_delta", contentIndex: state.openThinking.index, delta: text, partial });
			};
			const applySegments = (
				state: TextState,
				segments: HarmonySegment[],
				piIndex: number,
				partial: AssistantMessage,
			): void => {
				for (const segment of segments) {
					if (segment.kind === "text") {
						closeThinking(state, partial);
						const index = ensureText(state, piIndex, partial);
						state.text += segment.text;
						if (state.block.type === "text") state.block.text = state.text;
						output.push({ type: "text_delta", contentIndex: index, delta: segment.text, partial });
						continue;
					}
					if (segment.kind === "thinking") {
						observation.recoveredThinking = true;
						if (segment.channel === "analysis") observation.recoveredAnalysis = true;
						if (segment.note !== undefined && !observation.notes.includes(segment.note)) {
							observation.notes.push(segment.note);
						}
						appendThinking(state, segment.text, partial);
						continue;
					}
					closeThinking(state, partial);
					state.pendingTools.push(segment);
				}
				if (state.parser.markersSeen) observation.rawMarkers = true;
			};
			const materializeTools = (state: TextState, partial: AssistantMessage): void => {
				for (const segment of state.pendingTools) {
					const normalized = normalizeHarmonyToolName(segment.name);
					const args = parseArguments(segment.argsText);
					if ("artifact" in normalized) {
						observation.droppedToolCalls.push({ name: segment.name, reason: "artifact" });
						observation.notes.push(normalized.artifact);
						appendThinking(state, segment.argsText, partial);
						continue;
					}
					if (observation.structuredToolCalls > 0) {
						observation.droppedToolCalls.push({ name: normalized.name, reason: "duplicate" });
						continue;
					}
					if (segment.incomplete && args === null) {
						observation.droppedToolCalls.push({ name: normalized.name, reason: "incomplete" });
						appendThinking(state, segment.argsText, partial);
						continue;
					}
					closeThinking(state, partial);
					const block: ToolCall = {
						type: "toolCall",
						id: `harmony_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
						name: normalized.name,
						arguments: args ?? { raw: segment.argsText },
					};
					projected.push(block);
					const index = projected.length - 1;
					observation.synthesizedToolCalls += 1;
					output.push({ type: "toolcall_start", contentIndex: index, partial });
					output.push({ type: "toolcall_delta", contentIndex: index, delta: segment.argsText, partial });
					output.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial });
				}
				state.pendingTools = [];
				closeThinking(state, partial);
			};
			const finalize = (message: AssistantMessage, synthesize: boolean): AssistantMessage => {
				const partial: AssistantMessage = { ...message, content: projected };
				if (synthesize) for (const state of finishedTexts) materializeTools(state, partial);
				for (const artifact of artifacts) {
					const text = Object.keys(artifact.arguments).length > 0 ? JSON.stringify(artifact.arguments) : "";
					if (text.length === 0) continue;
					projected.push({ type: "thinking", thinking: text, thinkingSignature: options.recoveredThinkingSignature });
				}
				const content = [...projected];
				const hasToolCall = content.some((block) => block.type === "toolCall");
				let stopReason = message.stopReason;
				if (stopReason === "toolUse" && !hasToolCall) stopReason = "stop";
				if (stopReason === "stop" && hasToolCall) stopReason = "toolUse";
				const final: AssistantMessage = { ...message, content, stopReason };
				if (hasEvidence(observation)) final.harmonyRecovery = observation;
				return final;
			};

			for await (const event of source) {
				switch (event.type) {
					case "start":
						output.push({ ...event, partial: partialOf(event) });
						break;
					case "text_start": {
						const block = event.partial.content[event.contentIndex];
						if (block === undefined) break;
						texts.set(event.contentIndex, {
							parser: new HarmonyResponseParser(),
							block,
							index: null,
							text: "",
							openThinking: null,
							pendingTools: [],
						});
						break;
					}
					case "text_delta": {
						const state = texts.get(event.contentIndex);
						if (state === undefined) break;
						applySegments(state, state.parser.push(event.delta), event.contentIndex, partialOf(event));
						// pi appended the raw delta to its block; a delta that yielded no
						// text segment (a held or consumed marker) must not leave it there.
						if (state.block.type === "text") state.block.text = state.text;
						break;
					}
					case "text_end": {
						const state = texts.get(event.contentIndex);
						if (state === undefined) break;
						const partial = partialOf(event);
						applySegments(state, state.parser.flush(), event.contentIndex, partial);
						closeThinking(state, partial);
						if (state.index !== null) {
							if (state.block.type === "text") state.block.text = state.text;
							output.push({ ...event, contentIndex: state.index, content: state.text, partial });
						}
						if (state.pendingTools.length > 0) finishedTexts.push(state);
						texts.delete(event.contentIndex);
						break;
					}
					case "thinking_start":
					case "thinking_delta":
					case "thinking_end": {
						observation.structuredReasoning = true;
						const index = event.type === "thinking_start" ? adopt(event) : (indexMap.get(event.contentIndex) ?? -1);
						if (index === -1) break;
						output.push({ ...event, contentIndex: index, partial: partialOf(event) });
						break;
					}
					case "toolcall_start":
					case "toolcall_delta":
					case "toolcall_end": {
						const known = indexMap.get(event.contentIndex);
						if (known === null) break;
						if (known !== undefined) {
							if (event.type === "toolcall_end") {
								const normalized = normalizeHarmonyToolName(event.toolCall.name);
								if ("name" in normalized) event.toolCall.name = normalized.name;
							}
							output.push({ ...event, contentIndex: known, partial: partialOf(event) });
							break;
						}
						const block = event.type === "toolcall_end" ? event.toolCall : event.partial.content[event.contentIndex];
						if (block?.type !== "toolCall") break;
						if (block.name.length === 0 && event.type !== "toolcall_end") {
							const held = heldToolEvents.get(event.contentIndex) ?? [];
							held.push(event);
							heldToolEvents.set(event.contentIndex, held);
							break;
						}
						const held = heldToolEvents.get(event.contentIndex) ?? [];
						heldToolEvents.delete(event.contentIndex);
						const normalized = normalizeHarmonyToolName(block.name);
						if ("artifact" in normalized) {
							indexMap.set(event.contentIndex, null);
							artifacts.push(block);
							observation.droppedToolCalls.push({ name: block.name, reason: "artifact" });
							observation.notes.push(normalized.artifact);
							break;
						}
						block.name = normalized.name;
						observation.structuredToolCalls += 1;
						const index = adopt(event);
						const partial = partialOf(event);
						for (const pending of held) output.push({ ...pending, contentIndex: index, partial } as AssistantMessageEvent);
						output.push({ ...event, contentIndex: index, partial });
						break;
					}
					case "done": {
						const message = finalize(event.message, true);
						output.push({ type: "done", reason: doneReason(message.stopReason, event.reason), message });
						break;
					}
					case "error": {
						const error = finalize(event.error, false);
						output.push({ type: "error", reason: event.reason, error });
						break;
					}
				}
			}
			output.end();
		} catch (err) {
			fail(output, err);
		}
	})();
	return output;
}

function sumUsage(first: Usage, second: Usage): Usage {
	return {
		...second,
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

function isVisibleContent(event: AssistantMessageEvent): boolean {
	return (
		(event.type === "text_delta" && event.delta.length > 0) ||
		event.type === "toolcall_start" ||
		event.type === "toolcall_delta" ||
		event.type === "toolcall_end"
	);
}

/** A Harmony stop that answered nothing: no text, no tool call (vllm#45736). */
function isHarmonyIncompleteStop(message: AssistantMessage): boolean {
	if (message.stopReason !== "stop") return false;
	return !message.content.some(
		(block) => (block.type === "text" && block.text.trim().length > 0) || block.type === "toolCall",
	);
}

export interface HarmonyRetryOptions {
	modelId: string;
	/** Wire reasoning effort of the request, so the terminal message can name the low-effort defect. */
	effort?: string;
}

/**
 * Give a Harmony model one more attempt on two deterministic vLLM failures,
 * then end with a terminal message that retry paths recognize by its code:
 * a `HarmonyError` 500 before any content (vllm#51977) and a stop that carried
 * neither text nor a tool call (vllm#45736). The first attempt's `start` is the
 * only one forwarded, so pi-agent-core keeps a single message in flight; its
 * streamed thinking, if any, was shown once and is not persisted, and its usage
 * is summed into the final message so both provider calls are accounted (#435).
 * `result()` settles on every path: `fail` ends the output with an error
 * message when a wrapped stream ends without a terminal event or throws.
 */
export function retryHarmonyFailureOnce(
	first: AssistantMessageEventStream,
	restart: () => AssistantMessageEventStream,
	options: HarmonyRetryOptions,
	fail: (stream: AssistantMessageEventStream, cause: unknown) => void,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	(async () => {
		let source = first;
		let attempt = 1;
		let startForwarded = false;
		let contentSeen = false;
		let firstAttempt: { reason: "server-error" | "incomplete"; usage: Usage } | null = null;
		const retry = (reason: "server-error" | "incomplete", usage: Usage): void => {
			firstAttempt = { reason, usage };
			attempt += 1;
			contentSeen = false;
			source = restart();
		};
		const annotate = (message: AssistantMessage): AssistantMessage => {
			if (firstAttempt === null) return message;
			const recovery = message.harmonyRecovery ?? emptyObservation();
			return {
				...message,
				usage: sumUsage(firstAttempt.usage, message.usage),
				harmonyRecovery: { ...recovery, retry: { reason: firstAttempt.reason, firstAttemptUsage: firstAttempt.usage } },
			};
		};
		try {
			for (;;) {
				let restarted = false;
				for await (const event of source) {
					if (event.type === "start") {
						if (startForwarded) continue;
						startForwarded = true;
						output.push(event);
						continue;
					}
					if (event.type === "error" && !contentSeen && HARMONY_SERVER_ERROR_PATTERN.test(event.error.errorMessage ?? "")) {
						if (attempt === 1) {
							retry("server-error", event.error.usage);
							restarted = true;
							break;
						}
						const error = annotate({
							...event.error,
							errorMessage: harmonyServerErrorMessage(options.modelId, event.error.errorMessage ?? "", options.effort),
						});
						output.push({ type: "error", reason: "error", error });
						output.end(error);
						return;
					}
					if (event.type === "done" && isHarmonyIncompleteStop(event.message)) {
						if (attempt === 1) {
							retry("incomplete", event.message.usage);
							restarted = true;
							break;
						}
						const error = annotate({
							...event.message,
							stopReason: "error",
							errorMessage: harmonyIncompleteMessage(options.modelId),
						});
						output.push({ type: "error", reason: "error", error });
						output.end(error);
						return;
					}
					if (isVisibleContent(event)) contentSeen = true;
					if (event.type === "done") {
						const message = annotate(event.message);
						output.push({ type: "done", reason: doneReason(message.stopReason, event.reason), message });
						output.end(message);
						return;
					}
					if (event.type === "error") {
						const error = annotate(event.error);
						output.push({ type: "error", reason: event.reason, error });
						output.end(error);
						return;
					}
					output.push(event);
				}
				if (!restarted) {
					// Every terminal event returns above, so the wrapped stream closed
					// without one; waiting on its result() could hang forever.
					fail(output, new Error("Harmony stream ended without a done or error event"));
					return;
				}
			}
		} catch (err) {
			fail(output, err);
		}
	})();
	return output;
}
