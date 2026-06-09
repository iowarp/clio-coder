import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";

describe("chat-panel live thinking streaming", () => {
	it("folded render shows token count when pending, shows static label when settled", () => {
		const panel = createChatPanel();

		// Apply thinking_delta (pending = true)
		panel.applyEvent({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "Thinking step 1. Thinking step 2.",
			partialThinking: "Thinking step 1. Thinking step 2.",
		} as ChatLoopEvent);
		let rendered = panel.render(80).join("\n");
		ok(rendered.includes("Thinking ("));
		ok(rendered.includes("tokens)"));
		ok(!rendered.includes("Thinking step 1"));

		// Apply agent_end (pending = false)
		panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
		rendered = panel.render(80).join("\n");
		ok(rendered.includes("Thinking..."));
		ok(!rendered.includes("tokens"));
		ok(!rendered.includes("Thinking step 1"));
	});

	it("expanded render is tail-anchored when streaming and head-anchored when settled", () => {
		const panel = createChatPanel();
		// Set expanded state to true
		panel.toggleLastThinking();

		// Generate 15 lines of thinking
		let text = "";
		for (let i = 1; i <= 15; i++) {
			text += `thinking line ${i}\n`;
		}
		// Apply thinking_delta
		panel.applyEvent({
			type: "thinking_delta",
			contentIndex: 0,
			delta: text.trim(),
			partialThinking: text.trim(),
		} as ChatLoopEvent);

		let rendered = panel.render(80).join("\n");

		// When streaming: it should show the last 12 lines and a leading hidden lines note
		ok(rendered.includes("earlier lines hidden"));
		ok(rendered.includes("thinking line 15"));
		ok(!rendered.includes("thinking line 1\n"));
		ok(!rendered.includes("thinking line 2\n"));

		// Verify no double-printing of the thinking text
		const occurrences = rendered.split("thinking line 15").length - 1;
		strictEqual(occurrences, 1);

		// Now settle it by ending agent turn
		panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
		rendered = panel.render(80).join("\n");

		// When settled: it should show the first 12 lines and a trailing hidden lines note
		ok(rendered.includes("thinking line 1"));
		ok(rendered.includes("thinking line 12"));
		ok(rendered.includes("more lines hidden"));
		ok(!rendered.includes("thinking line 15"));
	});
});
