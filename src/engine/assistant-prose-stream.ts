import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import { createAssistantProseFilter, sanitizeAssistantProse } from "../core/assistant-prose.js";
import { readDiffusionFrame } from "./apis/diffusion-frames.js";

const projectedStreams = new WeakSet<AssistantMessageEventStream>();

/** All provider families share this authored-text policy, outside wire parsing. */
export function filterAssistantProseStream(
	source: AssistantMessageEventStream,
	model: Model<Api>,
): AssistantMessageEventStream {
	if (projectedStreams.has(source)) return source;
	const output = createAssistantMessageEventStream();
	projectedStreams.add(output);
	const filters = new Map<number, ReturnType<typeof createAssistantProseFilter>>();
	const text = new Map<number, string>();
	let lastPartial: AssistantMessage | undefined;
	const partial = (message: AssistantMessage): AssistantMessage => ({
		...message,
		// Tool arguments and signed thinking blocks are never rewritten.
		content: message.content.map((block, index) =>
			block.type === "text" ? { ...block, text: text.get(index) ?? sanitizeAssistantProse(block.text) } : block,
		),
	});
	const final = (message: AssistantMessage): AssistantMessage => ({
		...message,
		content: message.content.map((block) =>
			block.type === "text" ? { ...block, text: sanitizeAssistantProse(block.text) } : block,
		),
	});
	void (async () => {
		try {
			for await (const event of source) {
				if ("partial" in event) lastPartial = event.partial;
				if (event.type === "text_start") {
					filters.set(event.contentIndex, createAssistantProseFilter());
					text.set(event.contentIndex, "");
				}
				if (event.type === "text_delta") {
					const frame = readDiffusionFrame(event);
					if (frame) {
						const projected = sanitizeAssistantProse(frame.text);
						text.set(event.contentIndex, projected);
						filters.delete(event.contentIndex);
						const projectedEvent = {
							...event,
							partial: partial(event.partial),
							diffusionFrame: { ...frame, text: projected },
						};
						output.push(projectedEvent);
						continue;
					}
					const filter = filters.get(event.contentIndex) ?? createAssistantProseFilter();
					filters.set(event.contentIndex, filter);
					const delta = filter.push(event.delta);
					text.set(event.contentIndex, (text.get(event.contentIndex) ?? "") + delta);
					if (delta) output.push({ ...event, delta, partial: partial(event.partial) });
					continue;
				}
				if (event.type === "text_end") {
					const tail = filters.get(event.contentIndex)?.flush() ?? "";
					const content = text.has(event.contentIndex)
						? (text.get(event.contentIndex) ?? "") + tail
						: sanitizeAssistantProse(event.content);
					text.set(event.contentIndex, content);
					const projected = partial(event.partial);
					if (tail) output.push({ type: "text_delta", contentIndex: event.contentIndex, delta: tail, partial: projected });
					output.push({ ...event, content, partial: projected });
					filters.delete(event.contentIndex);
					continue;
				}
				if (event.type === "done" || event.type === "error") {
					const message = final(event.type === "done" ? event.message : event.error);
					// Some adapters terminate without text_end, including aborted streams.
					for (const [index, filter] of filters) {
						const tail = filter.flush();
						if (tail) output.push({ type: "text_delta", contentIndex: index, delta: tail, partial: message });
					}
					filters.clear();
					if (event.type === "done") output.push({ ...event, message });
					else output.push({ ...event, error: message });
				} else if ("partial" in event) output.push({ ...event, partial: partial(event.partial) });
				else output.push(event);
			}
			output.end(final(await source.result()));
		} catch (cause) {
			const reason = cause instanceof Error && cause.name === "AbortError" ? "aborted" : "error";
			const message: AssistantMessage = {
				...(lastPartial
					? final(lastPartial)
					: {
							role: "assistant" as const,
							content: [],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							timestamp: Date.now(),
						}),
				stopReason: reason,
				errorMessage: cause instanceof Error ? cause.message : String(cause),
			};
			output.push({ type: "error", reason, error: message });
			output.end(message);
		}
	})();
	return output;
}
