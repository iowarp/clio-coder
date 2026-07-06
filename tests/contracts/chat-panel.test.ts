import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { fgSequence, GLYPH } from "../../src/interactive/theme/index.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const strip = (s: string): string => s.replace(ANSI, "");

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

	it("finishes a blocked tool whose end arrives after a mid-turn notice split the transcript", () => {
		let clock = 1000;
		const panel = createChatPanel({ now: () => clock });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "b1",
			toolName: "read",
			args: { path: ".env" },
		} as ChatLoopEvent);
		clock = 1250;
		// A safety-net bus notice lands mid-turn: the replay block splits the
		// transcript, so the running segment no longer lives in the tail entry.
		panel.appendReplayBlock(() => ["safety-net: read blocked"]);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "b1",
			toolName: "read",
			result: "read blocked: read",
			isError: true,
			durationMs: 250,
		} as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
		const atEnd = strip(panel.render(100).join("\n"));
		ok(atEnd.includes("✗"), `the blocked call settles to an error line, got: ${atEnd}`);
		ok(atEnd.includes("250ms"), `the line carries the fixed event duration, got: ${atEnd}`);
		// An hour later the settled transcript must render byte-identical: a
		// leaked running line would keep counting now-relative elapsed.
		clock = 3_601_000;
		strictEqual(strip(panel.render(100).join("\n")), atEnd, "a settled transcript renders time-invariant");
	});

	it("settles an orphaned tool segment stranded in an earlier entry at agent_end", () => {
		let clock = 1000;
		const panel = createChatPanel({ now: () => clock });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "o1",
			toolName: "grep",
			args: { pattern: "x" },
		} as ChatLoopEvent);
		clock = 1400;
		panel.appendReplayBlock(() => ["approval parked"]);
		// The run ends with NO tool_execution_end for o1 (hard abort mid-batch).
		clock = 2000;
		panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
		const atEnd = strip(panel.render(100).join("\n"));
		ok(atEnd.includes("✗"), `the stranded orphan settles to an error line, got: ${atEnd}`);
		clock = 100_000;
		strictEqual(strip(panel.render(100).join("\n")), atEnd, "the settled line does not keep counting");
	});

	it("routes tool_execution_update to a segment stranded behind a notice entry", () => {
		const clock = 1000;
		const panel = createChatPanel({ now: () => clock });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "s1",
			toolName: "bash",
			args: { command: "sleep 5" },
		} as ChatLoopEvent);
		panel.appendReplayBlock(() => ["context-engine notice"]);
		panel.applyEvent({
			type: "tool_execution_update",
			toolCallId: "s1",
			toolName: "bash",
			partialResult: "streamed tail line",
		} as ChatLoopEvent);
		const rendered = strip(panel.render(100).join("\n"));
		ok(rendered.includes("streamed tail line"), `the streamed body still renders after the split, got: ${rendered}`);
	});

	it("settles a reused-id orphan stranded in an earlier entry when the id restarts", () => {
		let clock = 1000;
		const panel = createChatPanel({ now: () => clock });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "dup2",
			toolName: "grep",
			args: { pattern: "a" },
		} as ChatLoopEvent);
		clock = 1400;
		panel.appendReplayBlock(() => ["notice splits the entry"]);
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "dup2",
			toolName: "grep",
			args: { pattern: "b" },
		} as ChatLoopEvent);
		clock = 1600;
		const rendered = strip(panel.render(100).join("\n"));
		const errorGlyphs = (rendered.match(/✗/g) ?? []).length;
		strictEqual(errorGlyphs, 1, `exactly the stranded reused-id orphan settled, got: ${rendered}`);
	});

	it("upgrades a force-settled segment with a late true result but never rewrites a model-finished one", () => {
		let clock = 1000;
		const panel = createChatPanel({ now: () => clock });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "late1",
			toolName: "read",
			args: { path: "a.txt" },
		} as ChatLoopEvent);
		clock = 1500;
		panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
		// The end event raced the settle and arrives after agent_end with the
		// call's true outcome: the synthetic error line upgrades to the truth.
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "late1",
			toolName: "read",
			result: "real content",
			isError: false,
			durationMs: 400,
		} as ChatLoopEvent);
		let rendered = strip(panel.render(100).join("\n"));
		ok(rendered.includes("✓"), `the late true result upgrades the synthetic settle, got: ${rendered}`);
		ok(rendered.includes("400ms"), rendered);

		// A duplicate end for the now model-finished segment must not rewrite it.
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "late1",
			toolName: "read",
			result: "spoofed overwrite",
			isError: true,
			durationMs: 9999,
		} as ChatLoopEvent);
		rendered = strip(panel.render(100).join("\n"));
		ok(rendered.includes("400ms"), `a duplicate end must not rewrite the finished segment, got: ${rendered}`);
		ok(!rendered.includes("9999"), rendered);
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

describe("chat-panel agent voice", () => {
	it("prefixes an agent reply with ✦ in accent", () => {
		strictEqual(GLYPH.agent, "✦", "the agent glyph is the four-pointed star");
		const panel = createChatPanel();
		panel.applyEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "Hello there" }], stopReason: "stop" },
		} as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
		const rendered = panel.render(80).join("\n");
		ok(rendered.includes(`${fgSequence("accent")}${GLYPH.agent}`), "the reply glyph renders in accent");
		ok(
			strip(rendered).includes("✦ Hello there"),
			`stripped reply reads glyph + text: ${JSON.stringify(strip(rendered))}`,
		);
	});

	it("turns the reply glyph and the terminal error text red on a failed turn", () => {
		const panel = createChatPanel();
		panel.applyEvent({
			type: "message_end",
			message: { role: "assistant", content: [] as unknown[], stopReason: "error", errorMessage: "boom happened" },
		} as unknown as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
		const rendered = panel.render(80).join("\n");
		ok(rendered.includes(`${fgSequence("error")}${GLYPH.agent}`), "the glyph turns error red on a failed turn");
		ok(
			rendered.includes(`${fgSequence("error")}[error] boom happened`),
			"the terminal error marker renders as its own error-token segment, not plain markdown",
		);
		ok(strip(rendered).includes("✦ [error] boom happened"), "the stripped failed reply reads glyph + error marker");
	});
});

describe("chat-panel tool ledger subline", () => {
	function feedCollapsedRead(panel: ReturnType<typeof createChatPanel>): void {
		// A streaming turn keeps its tool collapsed to the ledger subline.
		panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "r1",
			toolName: "read",
			args: { path: "src/interactive/chat-panel.ts", offset: 100 },
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "r1",
			toolName: "read",
			result: {
				content: [{ type: "text", text: "x" }],
				details: { observation: { unit: "lines", shownCount: 120, totalCount: 787, shownBytes: 23962 } },
			},
			isError: false,
			durationMs: 230,
		} as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
	}

	it("wraps the collapsed subline to two lines without splitting the status tail", () => {
		const panel = createChatPanel({ getToolExpandKey: () => "ctrl+o" });
		feedCollapsedRead(panel);
		const lines = panel
			.render(80)
			.map(strip)
			.filter((line) => line.length > 0);
		ok(lines.length <= 2, `subline renders on at most two lines, got ${lines.length}: ${JSON.stringify(lines)}`);
		ok(lines[0]?.includes("reading src/interactive/chat-panel.ts"), "the verb and object lead the first line");
		const tail = lines.find((line) => line.includes("✓"));
		ok(tail !== undefined, "a line carries the success glyph");
		ok(tail?.includes("230ms"), `the status glyph and duration share a line: ${JSON.stringify(tail)}`);
		ok(tail?.includes("(ctrl+o)"), `the expand hint stays with the status tail: ${JSON.stringify(tail)}`);
	});
});

describe("chat-panel edit diff block", () => {
	it("suppresses the \\ No newline at end of file marker rows", () => {
		const panel = createChatPanel();
		// A fresh (non-streaming) turn expands the edit tool to its diff block.
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "e1",
			toolName: "edit",
			args: { path: "a.txt", old_string: "line one\nline two", new_string: "line one\nline TWO" },
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "e1",
			toolName: "edit",
			result: "ok",
			isError: false,
		} as ChatLoopEvent);
		const rendered = strip(panel.render(80).join("\n"));
		ok(rendered.includes("line TWO"), "the diff still renders the actual change");
		ok(rendered.includes("@@"), "the diff still renders its hunk header");
		ok(!rendered.includes("No newline at end of file"), "the no-newline sentinel rows are filtered out");
	});
});
