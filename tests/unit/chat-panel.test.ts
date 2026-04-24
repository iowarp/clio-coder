import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
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

	it("filters thinking_delta out of the visible chat stream", () => {
		// pi-agent-core emits thinking_delta for the model's chain-of-thought.
		// Clio captures it (so downstream surfaces like /think can inspect it)
		// but MUST NOT inline it into the user-visible turn: leaking raw model
		// reasoning (e.g. "We need to summarize the file.") alongside the real
		// assistant response is disorienting and is what Row 47 of the TUI
		// rubric flagged as a bug.
		const panel = createChatPanel();
		panel.applyEvent({ type: "thinking_delta", contentIndex: 0, delta: "ponder", partialThinking: "ponder" });
		panel.applyEvent({ type: "thinking_delta", contentIndex: 0, delta: "ing", partialThinking: "pondering" });
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "answer", partialText: "answer" });
		const text = strip(panel.render(80).join("\n"));
		ok(!text.includes("pondering"), `thinking leaked into visible stream: ${text}`);
		ok(!text.includes("ponder"), `thinking leaked into visible stream: ${text}`);
		ok(text.includes("clio: answer"), `expected assistant text, got: ${text}`);
	});

	it("renders tool calls in turn order relative to assistant text", () => {
		// pi-agent-core emits: message_start → text_delta(A) → message_end(A)
		// → tool_execution_start/end → new message_start → text_delta(B) →
		// message_end(B). The chat panel must interleave these so the tool
		// call appears BETWEEN the pre-tool text and the post-tool summary,
		// not appended after the full response.
		const panel = createChatPanel();
		panel.appendUser("summarize src/engine/tui.ts");
		panel.applyEvent({
			type: "message_start",
			message: { role: "assistant", content: [] } as never,
		});
		panel.applyEvent({
			type: "text_delta",
			contentIndex: 0,
			delta: "I'll read the file.",
			partialText: "I'll read the file.",
		});
		panel.applyEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "I'll read the file." }] } as never,
		});
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "src/engine/tui.ts" },
		});
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: "/** Tiny terminal helpers. */",
			isError: false,
		});
		panel.applyEvent({
			type: "message_start",
			message: { role: "assistant", content: [] } as never,
		});
		panel.applyEvent({
			type: "text_delta",
			contentIndex: 0,
			delta: "The file is a small TUI helper module.",
			partialText: "The file is a small TUI helper module.",
		});
		panel.applyEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "The file is a small TUI helper module." }],
			} as never,
		});
		panel.applyEvent({ type: "agent_end", messages: [] });

		const text = strip(panel.render(80).join("\n"));
		const preToolIdx = text.indexOf("I'll read the file.");
		const toolIdx = text.indexOf("tool: read");
		const postToolIdx = text.indexOf("The file is a small TUI helper module.");
		ok(preToolIdx >= 0, `missing pre-tool text: ${text}`);
		ok(toolIdx > preToolIdx, `tool call must follow pre-tool text: ${text}`);
		ok(
			postToolIdx > toolIdx,
			`post-tool summary must follow tool call, got order pre=${preToolIdx} tool=${toolIdx} post=${postToolIdx}: ${text}`,
		);
	});

	it("renders tool call inline even when only post-tool text is emitted", () => {
		// Some models skip the pre-tool narration. In that case the tool
		// block is the first rendered segment and the post-tool summary
		// follows it; there must be no stray placeholder or `clio:` prefix
		// duplicated between them.
		const panel = createChatPanel();
		panel.appendUser("read it");
		panel.applyEvent({
			type: "message_start",
			message: { role: "assistant", content: [] } as never,
		});
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "call-2",
			toolName: "read",
			args: { path: "x" },
		});
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "call-2",
			toolName: "read",
			result: "file body",
			isError: false,
		});
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "Summary here.", partialText: "Summary here." });
		panel.applyEvent({ type: "agent_end", messages: [] });

		const text = strip(panel.render(80).join("\n"));
		const toolIdx = text.indexOf("tool: read");
		const summaryIdx = text.indexOf("Summary here.");
		ok(toolIdx >= 0, `missing tool line: ${text}`);
		ok(summaryIdx > toolIdx, `post-tool summary must follow tool call: ${text}`);
		ok(!text.includes("clio: [working]"), `placeholder must not appear once output exists: ${text}`);
	});

	it("shows a working placeholder after assistant message_start before first token", () => {
		const panel = createChatPanel();
		panel.applyEvent({
			type: "message_start",
			message: { role: "assistant", content: [] } as never,
		});
		const text = strip(panel.render(80).join("\n"));
		ok(text.includes("clio: [working]"), `expected working placeholder, got: ${text}`);
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

	// Row 43 of the TUI rubric flagged that fenced code blocks, bulleted
	// lists, and inline backticks arrived as raw markdown in the chat pane.
	// After slice H1, finalized assistant text (the common post-streaming
	// state on `message_end`) is piped through pi-tui's Markdown renderer.
	// Tests assert structural markers instead of exact ANSI so they stay
	// resilient to theme tweaks and terminal-width wrapping.
	it("renders fenced code blocks with indented body on finalized assistant text", () => {
		const panel = createChatPanel();
		panel.appendUser("show me code");
		const source = "Here's the code:\n\n```js\nfoo();\nbar();\n```\n\nDone.";
		panel.applyEvent({
			type: "message_start",
			message: { role: "assistant", content: [] } as never,
		});
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: source, partialText: source });
		panel.applyEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: source }] } as never,
		});
		const lines = panel.render(80).map(strip);
		const joined = lines.join("\n");
		ok(joined.includes("clio: Here's the code:"), `missing pre-fence narration: ${joined}`);
		ok(
			lines.some((line) => line.trimEnd() === "```js"),
			`fence open missing or malformed: ${JSON.stringify(lines)}`,
		);
		ok(
			lines.some((line) => line.startsWith("  foo();")),
			`code body must be indented with 2 spaces: ${JSON.stringify(lines)}`,
		);
		ok(
			lines.some((line) => line.startsWith("  bar();")),
			`second code line must be indented: ${JSON.stringify(lines)}`,
		);
		ok(
			lines.some((line) => line.trimEnd() === "```"),
			`fence close missing: ${JSON.stringify(lines)}`,
		);
		ok(joined.includes("Done."), `trailing narration missing: ${joined}`);
	});

	it("renders bulleted lists with bullet glyphs, not the raw `*` source", () => {
		// Models frequently emit `*` for bullets; pi-tui normalizes both `-`
		// and `*` to `- ` in the rendered output. The visible transcript must
		// therefore NOT contain the literal `* alpha` source line.
		const panel = createChatPanel();
		panel.appendUser("list items");
		const source = "Items:\n\n* alpha\n* beta\n* gamma";
		panel.applyEvent({
			type: "message_start",
			message: { role: "assistant", content: [] } as never,
		});
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: source, partialText: source });
		panel.applyEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: source }] } as never,
		});
		const lines = panel.render(80).map(strip);
		const joined = lines.join("\n");
		ok(joined.includes("clio: Items:"), `missing list preamble: ${joined}`);
		ok(
			lines.some((line) => line.startsWith("- alpha")),
			`alpha bullet missing or un-normalized: ${JSON.stringify(lines)}`,
		);
		ok(
			lines.some((line) => line.startsWith("- beta")),
			`beta bullet missing: ${JSON.stringify(lines)}`,
		);
		ok(
			lines.some((line) => line.startsWith("- gamma")),
			`gamma bullet missing: ${JSON.stringify(lines)}`,
		);
		ok(!joined.includes("* alpha"), `raw asterisk bullet leaked into rendered output: ${joined}`);
	});

	it("renders inline code without literal backticks", () => {
		const panel = createChatPanel();
		panel.appendUser("talk about foo");
		const source = "use `foo` and `bar` here";
		panel.applyEvent({
			type: "message_start",
			message: { role: "assistant", content: [] } as never,
		});
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: source, partialText: source });
		panel.applyEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: source }] } as never,
		});
		const joined = strip(panel.render(80).join("\n"));
		ok(joined.includes("use foo and bar here"), `inline code must render without backticks: ${joined}`);
		ok(!joined.includes("`foo`"), `literal inline-code delimiters leaked: ${joined}`);
		ok(!joined.includes("`bar`"), `literal inline-code delimiters leaked: ${joined}`);
	});

	it("never emits a line wider than the requested render width, even with the clio: prefix", () => {
		// Regression guard. pi-tui's Markdown renderer right-pads every line to
		// the requested width so background colors extend edge-to-edge. Before
		// this fix, renderEntryLines prepended the 6-char "clio: " tag to the
		// already-padded first line, producing a visible width of `width + 6`.
		// TUI.doRender asserts every rendered line fits `width` and throws
		// `Rendered line N exceeds terminal width (W > width)`, which killed
		// the TUI before /compact's no-session notice could surface (observed
		// on tests/e2e/interactive.test.ts at width=120; reproduced here at
		// width=40 with a notice-length string that markdown pads to full
		// width).
		const panel = createChatPanel();
		const width = 40;
		const notice = "[/compact] no current session to compact";
		strictEqual(notice.length, width, "precondition: notice must equal width before prefixing");
		panel.applyEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: notice }] } as never,
		});
		const lines = panel.render(width);
		for (const line of lines) {
			ok(visibleWidth(line) <= width, `line exceeds width (${visibleWidth(line)} > ${width}): ${JSON.stringify(line)}`);
		}
		ok(
			strip(lines.join("\n")).includes("clio: [/compact] no current session"),
			`expected clio-labeled notice, got: ${JSON.stringify(lines.map(strip))}`,
		);
	});

	it("leaves streaming text (pre-message_end) as plain lines to avoid partial-markdown garbage", () => {
		// Streaming deltas arrive char-by-char; half-typed fences and bullets
		// would render as broken markdown if we piped deltas through the
		// Markdown renderer. Until `message_end` canonicalizes the segment,
		// text is rendered literally so users see exactly what the model is
		// emitting. The visible literal markers below confirm the plain path.
		const panel = createChatPanel();
		panel.appendUser("stream me");
		panel.applyEvent({
			type: "message_start",
			message: { role: "assistant", content: [] } as never,
		});
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "```j", partialText: "```j" });
		const joined = strip(panel.render(80).join("\n"));
		ok(joined.includes("```j"), `streaming text must surface the raw prefix: ${joined}`);
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
