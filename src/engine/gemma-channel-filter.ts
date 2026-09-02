import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	TextContent,
	ThinkingContent,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { inferLocalModelFamily } from "../domains/providers/model-family.js";

/**
 * Whether a model id names a Gemma 4 checkpoint, whose chat template writes its
 * private channel with the markers below when llama-server leaves the thought
 * inline in `content` instead of extracting it to `reasoning_content`.
 *
 * Keyed on the wire model id rather than on the resolved family, because
 * `capabilityFamily` returns the knowledge-base family whenever the catalog
 * matches an id and every Gemma entry there names a build (`gemma4-26b-a4b`,
 * `gemma-4-31b-it-qat-mtp`, `gemopus-4-31b-it`), never the literal `gemma-4`
 * that `inferLocalModelFamily` produces for an id the catalog does not match.
 * Gating on the family therefore ran the filter only for Gemma ids the catalog
 * did not know, so naming `gemma4-26b-moe` and `gemma4-31b-dense` in it (issue
 * #263) turned the filter off for the two ids the router actually serves.
 */
export function usesGemmaChannelMarkers(modelId: string): boolean {
	return inferLocalModelFamily(modelId) === "gemma-4";
}

const THOUGHT_START = /<\|channel>[^\n]*\n/;
const BARE_THOUGHT_START = /^\s*(?:thought|own[- ]?(?:thought|think))\s*\n/i;
const BARE_THOUGHT_ONLY = /^\s*(?:thought|own[- ]?(?:thought|think))\s*$/i;
const THOUGHT_END = "<channel|>";
const TOOL_CALL_START = "<tool_call|>";
const TOOL_CALL_END = "<|tool_call|>";
const LOOKAHEAD_BYTES = 64;

export interface GemmaChannelSegment {
	kind: "text" | "thinking";
	content: string;
}

export interface GemmaChannelFilter {
	push(chunk: string): GemmaChannelSegment[];
	flush(): GemmaChannelSegment[];
}

function boundedPrefix(value: string): { prefix: string; tail: string } {
	let tailStart = value.length;
	while (tailStart > 0) {
		const candidate = tailStart - 1;
		if (Buffer.byteLength(value.slice(candidate), "utf8") > LOOKAHEAD_BYTES) break;
		tailStart = candidate;
	}
	return { prefix: value.slice(0, tailStart), tail: value.slice(tailStart) };
}

export function createGemmaChannelFilter(): GemmaChannelFilter {
	let pending = "";
	let state: "idle" | "thought" | "toolcall" = "idle";
	const route = (chunk: string): GemmaChannelSegment[] => {
		const output: GemmaChannelSegment[] = [];
		const emit = (kind: GemmaChannelSegment["kind"], content: string) => {
			if (!content) return;
			const previous = output.at(-1);
			if (previous?.kind === kind) previous.content += content;
			else output.push({ kind, content });
		};
		pending += chunk;
		while (true) {
			if (state === "thought") {
				const end = pending.indexOf(THOUGHT_END);
				const toolCall = pending.indexOf(TOOL_CALL_START);
				if (toolCall >= 0 && (end < 0 || toolCall < end)) {
					emit("thinking", pending.slice(0, toolCall));
					pending = pending.slice(toolCall + TOOL_CALL_START.length);
					state = "toolcall";
					continue;
				}
				if (end >= 0) {
					emit("thinking", pending.slice(0, end));
					pending = pending.slice(end + THOUGHT_END.length);
					state = "idle";
					continue;
				}
				const bounded = boundedPrefix(pending);
				emit("thinking", bounded.prefix);
				pending = bounded.tail;
				return output;
			}
			if (state === "toolcall") {
				const end = pending.indexOf(TOOL_CALL_END);
				if (end >= 0) {
					pending = pending.slice(end + TOOL_CALL_END.length);
					state = "idle";
					continue;
				}
				pending = boundedPrefix(pending).tail;
				return output;
			}
			const thought = THOUGHT_START.exec(pending);
			const bare = BARE_THOUGHT_START.exec(pending);
			const candidates = [
				{ index: thought?.index ?? -1, kind: "thought" as const, length: thought?.[0].length ?? 0 },
				{ index: bare ? 0 : -1, kind: "thought" as const, length: bare?.[0].length ?? 0 },
				{ index: pending.indexOf(TOOL_CALL_START), kind: "toolcall" as const, length: TOOL_CALL_START.length },
				{ index: pending.indexOf(THOUGHT_END), kind: "orphan" as const, length: THOUGHT_END.length },
			]
				.filter((candidate) => candidate.index >= 0)
				.sort((left, right) => left.index - right.index);
			const next = candidates[0];
			if (!next) {
				const bounded = boundedPrefix(pending);
				emit("text", bounded.prefix);
				pending = bounded.tail;
				return output;
			}
			emit("text", pending.slice(0, next.index));
			pending = pending.slice(next.index + next.length);
			if (next.kind === "thought") state = "thought";
			else if (next.kind === "toolcall") state = "toolcall";
		}
	};
	return {
		push: route,
		flush() {
			const output: GemmaChannelSegment[] = [];
			if (state === "thought" && pending) output.push({ kind: "thinking", content: pending });
			else if (state === "idle" && pending && !BARE_THOUGHT_ONLY.test(pending)) {
				output.push({ kind: "text", content: pending });
			}
			pending = "";
			state = "idle";
			return output;
		},
	};
}

type ReplacementBlock = TextContent | ThinkingContent;

export function filterGemmaChannelStream(
	source: AssistantMessageEventStream,
	enabled: boolean,
): AssistantMessageEventStream {
	if (!enabled) return source;
	const filtered = createAssistantMessageEventStream();
	const replacements = new Map<number, ReplacementBlock[]>();
	const filters = new Map<number, GemmaChannelFilter>();
	const activeKinds = new Map<number, GemmaChannelSegment["kind"]>();

	const projectContent = (content: AssistantMessage["content"]): AssistantMessage["content"] =>
		content.flatMap((block, index) => replacements.get(index) ?? [block]);
	const projectMessage = (message: AssistantMessage): AssistantMessage => ({
		...message,
		content: projectContent(message.content),
	});
	const projectedIndex = (originalIndex: number, localIndex = 0): number => {
		let offset = 0;
		for (let index = 0; index < originalIndex; index += 1) offset += (replacements.get(index)?.length ?? 1) - 1;
		return originalIndex + offset + localIndex;
	};
	const projectedPartial = (event: { partial: AssistantMessage }): AssistantMessage => projectMessage(event.partial);

	(async () => {
		try {
			const closeActive = (originalIndex: number, partial: AssistantMessage) => {
				const kind = activeKinds.get(originalIndex);
				const blocks = replacements.get(originalIndex) ?? [];
				const localIndex = blocks.length - 1;
				const block = blocks[localIndex];
				if (!kind || !block) return;
				const contentIndex = projectedIndex(originalIndex, localIndex);
				if (kind === "text" && block.type === "text") {
					filtered.push({ type: "text_end", contentIndex, content: block.text, partial: projectMessage(partial) });
				} else if (kind === "thinking" && block.type === "thinking") {
					filtered.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: projectMessage(partial) });
				}
				activeKinds.delete(originalIndex);
			};
			const emitSegments = (originalIndex: number, partial: AssistantMessage, segments: GemmaChannelSegment[]) => {
				for (const segment of segments) {
					if (activeKinds.get(originalIndex) !== segment.kind) {
						closeActive(originalIndex, partial);
						const blocks = replacements.get(originalIndex) ?? [];
						blocks.push(segment.kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
						replacements.set(originalIndex, blocks);
						activeKinds.set(originalIndex, segment.kind);
						const contentIndex = projectedIndex(originalIndex, blocks.length - 1);
						filtered.push({
							type: segment.kind === "text" ? "text_start" : "thinking_start",
							contentIndex,
							partial: projectMessage(partial),
						});
					}
					const blocks = replacements.get(originalIndex) ?? [];
					const localIndex = blocks.length - 1;
					const block = blocks[localIndex];
					if (!block) continue;
					if (segment.kind === "text" && block.type === "text") block.text += segment.content;
					if (segment.kind === "thinking" && block.type === "thinking") block.thinking += segment.content;
					filtered.push({
						type: segment.kind === "text" ? "text_delta" : "thinking_delta",
						contentIndex: projectedIndex(originalIndex, localIndex),
						delta: segment.content,
						partial: projectMessage(partial),
					});
				}
			};

			for await (const event of source) {
				if (event.type === "text_start") {
					replacements.set(event.contentIndex, []);
					filters.set(event.contentIndex, createGemmaChannelFilter());
					continue;
				}
				if (event.type === "text_delta") {
					emitSegments(event.contentIndex, event.partial, filters.get(event.contentIndex)?.push(event.delta) ?? []);
					continue;
				}
				if (event.type === "text_end") {
					emitSegments(event.contentIndex, event.partial, filters.get(event.contentIndex)?.flush() ?? []);
					closeActive(event.contentIndex, event.partial);
					filters.delete(event.contentIndex);
					continue;
				}
				if (event.type === "done") filtered.push({ ...event, message: projectMessage(event.message) });
				else if (event.type === "error") filtered.push({ ...event, error: projectMessage(event.error) });
				else if ("partial" in event) {
					const contentIndex = "contentIndex" in event ? projectedIndex(event.contentIndex as number) : undefined;
					filtered.push({
						...event,
						...(contentIndex === undefined ? {} : { contentIndex }),
						partial: projectedPartial(event),
					} as AssistantMessageEvent);
				} else filtered.push(event as AssistantMessageEvent);
			}
			filtered.end();
		} catch {
			filtered.end();
		}
	})();
	return filtered;
}
