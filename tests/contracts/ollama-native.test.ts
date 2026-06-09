import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assistantToOllama } from "../../src/engine/apis/ollama-native.js";

describe("ollama-native thinking replay", () => {
	it("assistant message with a thinking block produces an OllamaMessage carrying thinking, and the answer text is unchanged", () => {
		const content: AssistantMessage["content"] = [
			{ type: "thinking", thinking: "I need to look for a solution." },
			{ type: "text", text: "Here is the final answer." },
		];
		const message = assistantToOllama(content);
		strictEqual(message.role, "assistant");
		strictEqual(message.content, "Here is the final answer.");
		strictEqual(message.thinking, "I need to look for a solution.");
	});

	it("assistant message without a thinking block produces an OllamaMessage with undefined thinking", () => {
		const content: AssistantMessage["content"] = [{ type: "text", text: "Here is the final answer." }];
		const message = assistantToOllama(content);
		strictEqual(message.role, "assistant");
		strictEqual(message.content, "Here is the final answer.");
		strictEqual(message.thinking, undefined);
	});
});
