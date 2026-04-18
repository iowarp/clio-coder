import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { createCoalescingChatRenderer } from "../../src/interactive/chat-renderer.js";

// Strip ANSI sequences. Biome bans literal control chars in regex source,
// so build the pattern from a constructor with the ESC byte injected.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
function strip(s: string): string {
	return s.replace(ANSI, "");
}

describe("chat-panel active entry update", () => {
	// Streaming should accumulate into the same active assistant entry until
	// the next non-delta finalizer or a fresh user turn rotates it. The
	// rendered transcript must reflect the running text without rebuilding
	// prior turns from scratch each delta.
	it("accumulates text_delta events into the active assistant entry", () => {
		const panel = createChatPanel();
		panel.appendUser("hi");
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "he", partialText: "he" });
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "llo", partialText: "hello" });
		const text = strip(panel.render(80).join("\n"));
		ok(text.includes("you: hi"), `expected user line, got: ${text}`);
		ok(text.includes("clio: hello"), `expected accumulated assistant line, got: ${text}`);
	});

	it("accumulates thinking_delta separately from text", () => {
		const panel = createChatPanel();
		panel.applyEvent({ type: "thinking_delta", contentIndex: 0, delta: "ponder", partialThinking: "ponder" });
		panel.applyEvent({ type: "thinking_delta", contentIndex: 0, delta: "ing", partialThinking: "pondering" });
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "answer", partialText: "answer" });
		const text = strip(panel.render(80).join("\n"));
		ok(text.includes("pondering"), `expected accumulated thinking, got: ${text}`);
		ok(text.includes("clio: answer"), `expected assistant text, got: ${text}`);
	});

	it("renders prior user + assistant entries unchanged after a new user turn", () => {
		const panel = createChatPanel();
		panel.appendUser("first");
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "reply-1", partialText: "reply-1" });
		panel.applyEvent({
			type: "message_end",
			// AgentMessage's full assistant shape (api/provider/model/usage etc.)
			// is irrelevant to the panel; cast keeps the test free of pi-ai imports.
			message: { role: "assistant", content: [{ type: "text", text: "reply-1" }] } as never,
		});
		panel.appendUser("second");
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "reply-2", partialText: "reply-2" });
		const text = strip(panel.render(80).join("\n"));
		ok(text.includes("you: first"), text);
		ok(text.includes("clio: reply-1"), text);
		ok(text.includes("you: second"), text);
		ok(text.includes("clio: reply-2"), text);
	});

	it("reset() clears the transcript", () => {
		const panel = createChatPanel();
		panel.appendUser("dropme");
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "alsodrop", partialText: "alsodrop" });
		panel.reset();
		strictEqual(strip(panel.render(80).join("\n")).trim(), "");
	});
});

describe("createCoalescingChatRenderer", () => {
	function setup(coalesceMs = 5): {
		renderer: ReturnType<typeof createCoalescingChatRenderer>;
		applied: ChatLoopEvent[];
		count: () => number;
	} {
		let renderCount = 0;
		const applied: ChatLoopEvent[] = [];
		const fakePanel = {
			appendUser: () => {},
			reset: () => {},
			applyEvent: (event: ChatLoopEvent) => {
				applied.push(event);
			},
			render: () => [],
			invalidate: () => {},
		};
		const renderer = createCoalescingChatRenderer({
			chatPanel: fakePanel,
			requestRender: () => {
				renderCount += 1;
			},
			coalesceMs,
		});
		return {
			renderer,
			applied,
			count: () => renderCount,
		};
	}

	it("coalesces 100 text_delta events into at most two requestRender calls", async () => {
		const { renderer, applied, count } = setup(5);
		for (let i = 0; i < 100; i += 1) {
			renderer.applyEvent({ type: "text_delta", contentIndex: 0, delta: "x", partialText: "x".repeat(i + 1) });
		}
		// All deltas applied to the panel synchronously so the in-memory state
		// is consistent even before the timer fires.
		strictEqual(applied.length, 100);
		// Inside the same microtask the coalesce timer has not fired yet.
		strictEqual(count(), 0, "no synchronous render under coalescing");
		// Wait past the coalesce window. One render covers all 100 deltas.
		await new Promise((r) => setTimeout(r, 25));
		ok(count() <= 2, `expected at most 2 renders, got ${count()}`);
		ok(count() >= 1, `expected at least 1 render, got ${count()}`);
	});

	it("message_end after deltas renders synchronously and drops the pending timer", async () => {
		const { renderer, count } = setup(5);
		renderer.applyEvent({ type: "text_delta", contentIndex: 0, delta: "hello", partialText: "hello" });
		// Pending timer scheduled, no synchronous render yet.
		strictEqual(count(), 0);
		renderer.applyEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "hello" }] } as never,
		});
		// message_end forces a synchronous render and cancels the pending timer.
		strictEqual(count(), 1);
		// Coalesce window passes; no extra render fires since the timer was cancelled.
		await new Promise((r) => setTimeout(r, 25));
		strictEqual(count(), 1, "pending timer must have been cancelled by message_end");
	});

	it("agent_end renders synchronously even with no pending deltas", async () => {
		const { renderer, count } = setup(5);
		renderer.applyEvent({ type: "agent_end", messages: [] });
		strictEqual(count(), 1);
		await new Promise((r) => setTimeout(r, 25));
		strictEqual(count(), 1);
	});

	it("flush() drains a pending coalesce timer and renders once", async () => {
		const { renderer, count } = setup(50);
		renderer.applyEvent({ type: "text_delta", contentIndex: 0, delta: "x", partialText: "x" });
		strictEqual(count(), 0);
		renderer.flush();
		strictEqual(count(), 1);
		await new Promise((r) => setTimeout(r, 75));
		strictEqual(count(), 1, "no double-render after explicit flush");
	});

	it("flush() is a no-op when no timer is pending", () => {
		const { renderer, count } = setup(5);
		renderer.flush();
		strictEqual(count(), 0);
	});
});
