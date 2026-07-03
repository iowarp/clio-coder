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

describe("chat-panel tool-body export rendering", () => {
	function feedLargeGrep(panel: ReturnType<typeof createChatPanel>): void {
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "grep-1",
			toolName: "grep",
			args: { pattern: "e", path: "src" },
		} as ChatLoopEvent);
		const lines: string[] = [];
		for (let i = 1; i <= 300; i += 1) lines.push(`many.txt:${i}: e match line ${String(i).padStart(4, "0")}`);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "grep-1",
			toolName: "grep",
			result: lines.join("\n"),
			isError: false,
		} as ChatLoopEvent);
	}

	it("bounded panel middle-elides a large expanded tool body (live-view default)", () => {
		const panel = createChatPanel();
		feedLargeGrep(panel);
		const rendered = panel.render(100).join("\n");
		// Middle-elision keeps the head and the tail and drops the middle, so a
		// central row disappears while the first and last survive.
		ok(rendered.includes("lines hidden"), "live view should middle-elide a >120-row body");
		ok(rendered.includes("many.txt:1:"), "the head survives the elision");
		ok(rendered.includes("many.txt:300:"), "the tail survives the elision");
		ok(!rendered.includes("many.txt:150:"), "a central row is hidden by the middle-elision");
	});

	it("unboundedToolBodies renders the full expanded tool body with no middle-elision (for /export)", () => {
		const panel = createChatPanel({ unboundedToolBodies: true });
		feedLargeGrep(panel);
		const rendered = panel.render(100).join("\n");
		ok(!rendered.includes("lines hidden"), "export must not carry the UI middle-elision placeholder");
		ok(rendered.includes("many.txt:1:"), "export must keep the head of the body");
		ok(rendered.includes("many.txt:150:"), "export must keep the middle rows the live view elides");
		ok(rendered.includes("many.txt:300:"), "export must keep the tail of the body");
	});
});

describe("chat-panel settles blocked and orphaned tool calls", () => {
	it("settles a tool call whose end never arrives to an error line with its own duration", () => {
		let clock = 1000;
		const panel = createChatPanel({ now: () => clock });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "grep",
			args: { pattern: "x" },
		} as ChatLoopEvent);
		clock = 1500;
		// While running: no outcome glyph yet, just a live counting elapsed.
		let rendered = panel.render(100).join("\n");
		ok(!rendered.includes("✗"), "a running call carries no error glyph yet");
		// The run ends with NO tool_execution_end for c1 (admission block / abort).
		clock = 2200;
		panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
		rendered = panel.render(100).join("\n");
		ok(rendered.includes("✗"), "the orphaned call settles to an error line, not a counting running line");
		ok(/\b\d+ms\b|\b\d+(?:\.\d+)?s\b/.test(rendered), `the settled line shows its own duration, got: ${rendered}`);
	});

	it("settles a prior same-id segment when the model reuses a tool-call id", () => {
		let clock = 1000;
		const panel = createChatPanel({ now: () => clock });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "dup",
			toolName: "grep",
			args: { pattern: "a" },
		} as ChatLoopEvent);
		clock = 1400;
		// Same id reused for a fresh call: the earlier segment must settle instead
		// of lingering as a second running line.
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "dup",
			toolName: "grep",
			args: { pattern: "b" },
		} as ChatLoopEvent);
		clock = 1600;
		const rendered = panel.render(100).join("\n");
		const errorGlyphs = (rendered.match(/✗/g) ?? []).length;
		strictEqual(errorGlyphs, 1, "exactly the reused-id orphan settled to an error line");
	});
});
