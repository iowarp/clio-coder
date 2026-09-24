import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "./types.js";

export const IMAGE_OMITTED_NOTE = "[Image omitted from this request: the current model does not accept image input.]";

/** Count image blocks in the live transcript without changing durable session data. */
export function countImageBlocks(messages: ReadonlyArray<AgentMessage>): number {
	return messages.reduce((count, message) => {
		if (!("content" in message) || !Array.isArray(message.content)) return count;
		return count + message.content.filter((block) => block?.type === "image").length;
	}, 0);
}

/** Project an image-bearing transcript for a text-only model at the provider boundary. */
export function omitImageBlocks(messages: ReadonlyArray<Message>): Message[] {
	return messages.map((message) => {
		if (
			(message.role !== "user" && message.role !== "toolResult") ||
			typeof message.content === "string" ||
			!message.content.some((block) => block.type === "image")
		) {
			return message;
		}
		return {
			...message,
			content: message.content.map((block) =>
				block.type === "image" ? { type: "text" as const, text: IMAGE_OMITTED_NOTE } : block,
			),
		};
	});
}
