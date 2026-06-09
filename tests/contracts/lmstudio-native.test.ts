import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { assistantMessage } from "../../src/engine/apis/lmstudio-native.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

describe("lmstudio-native thinking replay", () => {
	it("assistant message with thinking yields a leading <think>...</think> text part", () => {
		const content: AssistantMessage["content"] = [
			{ type: "thinking", thinking: "Determining path..." },
			{ type: "text", text: "Done." }
		];
		const message = assistantMessage(content);
		strictEqual(message.role, "assistant");
		strictEqual(message.content.length, 2);
		deepStrictEqual(message.content[0], {
			type: "text",
			text: "<think>\nDetermining path...\n</think>"
		});
		deepStrictEqual(message.content[1], {
			type: "text",
			text: "Done."
		});
	});

	it("assistant message without thinking matches current behavior (no leading think block)", () => {
		const content: AssistantMessage["content"] = [
			{ type: "text", text: "Done." }
		];
		const message = assistantMessage(content);
		strictEqual(message.role, "assistant");
		strictEqual(message.content.length, 1);
		deepStrictEqual(message.content[0], {
			type: "text",
			text: "Done."
		});
	});
});
