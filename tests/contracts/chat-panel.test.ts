import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { SKILL_SUGGESTION_ANCHOR, SKILL_SUGGESTION_PREFIX } from "../../src/core/skill-activation.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import type { ApprovalRequestView } from "../../src/interactive/permission-overlay.js";
import { redactToolArgs, renderToolSubline } from "../../src/interactive/renderers/tool-execution.js";
import { fgSequence, GLYPH, SGR_DIM } from "../../src/interactive/theme/index.js";
import { createTestClock } from "../harness/clock.js";

const strip = stripTerminalSequences;

/**
 * Every panel in this file is built on the harness clock. A panel that reads
 * the real clock stamps a wall-clock elapsed onto whatever tool row it renders,
 * which is how #52 turned two byte-identity assertions into a race and why
 * three commits each hand-rolled the same fixed `now` in turn (audit F7).
 * The tests that need time to move keep their own stepped `now` instead.
 */
const frozen = createTestClock();

function approvalView(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
	return {
		requestId: "approval-test",
		tool: "bash",
		actionClass: "execute",
		axis: { kind: "net", ruleId: "test-confirm" },
		origin: { kind: "main" },
		reason: "approval required",
		target: "printf ready",
		...overrides,
	};
}

describe("chat-panel live thinking streaming", () => {
	it("counts no tokens from streamed thinking text and shows a static label when settled", () => {
		const panel = createChatPanel({ now: frozen.now });

		// Apply thinking_delta (pending = true)
		panel.applyEvent({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "Thinking step 1. Thinking step 2.",
			partialThinking: "Thinking step 1. Thinking step 2.",
		} as ChatLoopEvent);
		let rendered = panel.render(80).join("\n");
		// Nothing has settled into the run tally yet, so the live line states that
		// the model is thinking and nothing about how much it spent. The old
		// marker measured the visible excerpt, which moved with how much reasoning
		// the provider chose to display.
		ok(rendered.includes("Thinking…"));
		ok(!rendered.includes("tokens"));
		ok(!rendered.includes("r≈"));
		ok(!rendered.includes("Thinking step 1"));

		// Apply agent_end (pending = false)
		panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
		rendered = panel.render(80).join("\n");
		// The settled label spells its ellipsis with U+2026, like every other cut
		// and continuation marker in the TUI. ASCII "..." here was the last holdout.
		ok(rendered.includes("Thinking…"));
		ok(!rendered.includes("Thinking..."));
		ok(!rendered.includes("tokens"));
		ok(!rendered.includes("Thinking step 1"));
	});

	it("expanded render is tail-anchored when streaming and head-anchored when settled", () => {
		const panel = createChatPanel({ now: frozen.now });
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

describe("chat-panel queued user turn injection", () => {
	it("marks every user turn for Pi fullscreen prompt navigation", () => {
		const panel = createChatPanel({ now: frozen.now });
		panel.appendUser("first prompt");
		panel.appendUser("second prompt");
		const rendered = panel.render(80);
		strictEqual(
			rendered.filter((line) => line.startsWith("\x1b]133;A\x07")).length,
			2,
			"each semantic user turn begins with Pi's OSC 133 prompt marker",
		);
	});

	it("renders an injected steer as a user turn between assistant entries", () => {
		const panel = createChatPanel({ now: frozen.now });
		panel.appendUser("start a long task");
		panel.applyEvent({
			type: "text_delta",
			contentIndex: 0,
			delta: "working on it",
			partialText: "working on it",
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "queued_user_turn",
			text: "actually only list directories",
			kind: "steer",
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "text_delta",
			contentIndex: 0,
			delta: "pivoting",
			partialText: "pivoting",
		} as ChatLoopEvent);
		const rendered = panel.render(80).map(strip);
		const joined = rendered.join("\n");
		const userGlyphRows = rendered.filter((line) => line.startsWith(`${GLYPH.user} `));
		strictEqual(userGlyphRows.length, 2, "both the prompt and the injected steer carry the user glyph");
		const promptIndex = rendered.findIndex((line) => line.includes("start a long task"));
		const steerIndex = rendered.findIndex((line) => line.includes("actually only list directories"));
		const pivotIndex = rendered.findIndex((line) => line.includes("pivoting"));
		ok(promptIndex < steerIndex, "the steer renders after the original prompt");
		ok(steerIndex < pivotIndex, `the post-steer response renders below the injected turn:\n${joined}`);
	});
});

describe("chat-panel voice-first prose gutter", () => {
	const longProse =
		"A deliberately long sentence keeps every wrapped continuation visibly owned by the speaker across terminal widths.";

	function assertOwnedRows(rows: string[], glyph: string, width: number): void {
		ok(rows.length > 1, `fixture must wrap at ${width}: ${JSON.stringify(rows)}`);
		strictEqual(rows[0]?.startsWith(`${glyph} `), true, `first row owns ${glyph}: ${JSON.stringify(rows)}`);
		for (const row of rows.slice(1)) {
			strictEqual(row.startsWith("  "), true, `continuation has a two-cell gutter: ${JSON.stringify(rows)}`);
			ok(row.length <= width, `row exceeds ${width}: ${JSON.stringify(row)}`);
		}
	}

	it("hangs wrapped user and streaming assistant prose at multiple widths", () => {
		for (const width of [20, 40, 80]) {
			const user = createChatPanel({ now: frozen.now });
			user.appendUser(longProse);
			assertOwnedRows(user.render(width).map(strip), GLYPH.user, width);

			const assistant = createChatPanel({ now: frozen.now });
			assistant.applyEvent({ type: "text_delta", contentIndex: 0, delta: longProse } as ChatLoopEvent);
			assertOwnedRows(assistant.render(width).map(strip), GLYPH.agent, width);
		}
	});

	it("keeps plain prose row-stable from streaming through finalized Markdown", () => {
		for (const width of [20, 40, 80]) {
			const panel = createChatPanel({ now: frozen.now });
			panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: longProse } as ChatLoopEvent);
			const streaming = panel.render(width).map(strip);
			panel.applyEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: longProse }], stopReason: "stop" },
			} as ChatLoopEvent);
			panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
			const finalized = panel.render(width).map(strip);
			strictEqual(finalized.join("\n"), streaming.join("\n"), `stream/final shape changed at ${width}`);
			assertOwnedRows(finalized, GLYPH.agent, width);
		}
	});

	it("budgets finalized fenced Markdown inside the prose gutter", () => {
		const markdown = "Here is the command:\n\n```ts\nconst answer = 42;\nconsole.log(answer);\n```\n\nDone.";
		for (const width of [20, 40, 80]) {
			const panel = createChatPanel({ now: frozen.now });
			panel.applyEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: markdown }], stopReason: "stop" },
			} as ChatLoopEvent);
			panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
			const rows = panel.render(width).map(strip);
			strictEqual(rows[0]?.startsWith(`${GLYPH.agent} `), true, JSON.stringify(rows));
			for (const row of rows.slice(1)) strictEqual(row.startsWith("  "), true, JSON.stringify(rows));
			for (const row of rows) ok(row.length <= width, `fence row exceeds ${width}: ${JSON.stringify(row)}`);
			ok(
				rows.some((row) => row.includes("const answer")),
				JSON.stringify(rows),
			);
		}
	});

	it("renders Mermaid fences and inline LaTeX through the transcript Markdown component", () => {
		const markdown = ["The invariant is $x^2$.", "", "```mermaid", "flowchart LR", "  A[Start] --> B[Done]", "```"].join(
			"\n",
		);
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: markdown }], stopReason: "stop" },
		} as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);

		const plain = panel.render(80).map(strip).join("\n");
		ok(plain.includes("x²"), plain);
		ok(plain.includes("Start"), plain);
		ok(plain.includes("Done"), plain);
		ok(/[┌┐└┘╭╮╰╯]/u.test(plain), plain);
		ok(!plain.includes("flowchart LR"), plain);
	});

	it("leaves interleaved tool ledgers on their existing full-width grammar", () => {
		const width = 40;
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: longProse } as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "read-voice",
			toolName: "read",
			args: { path: "AGENTS.md" },
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "read-voice",
			toolName: "read",
			result: "contents",
			isError: false,
		} as ChatLoopEvent);
		panel.applyEvent({ type: "text_delta", contentIndex: 1, delta: "Summary after the tool." } as ChatLoopEvent);
		const rendered = panel.render(width);
		const ledger = renderToolSubline(
			{ toolCallId: "read-voice", toolName: "read", args: { path: "AGENTS.md" }, result: "contents", isError: false },
			width,
		);
		for (const row of ledger)
			ok(rendered.includes(row), `panel changed the full-width tool row: ${JSON.stringify(rendered)}`);
		const summary = rendered.map(strip).find((row) => row.includes("Summary after the tool."));
		ok(summary?.startsWith("  "), `post-tool prose keeps the assistant gutter: ${JSON.stringify(rendered)}`);
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
		const panel = createChatPanel({ now: frozen.now });
		feedLargeGrep(panel);
		const rendered = panel.render(100).join("\n");
		// Middle-elision keeps the head and the tail and drops the middle, so a
		// central row disappears while the first and last survive.
		ok(rendered.includes("lines hidden"), "live view should middle-elide a >120-row body");
		ok(rendered.includes("many.txt:1:"), "the head survives the elision");
		ok(rendered.includes("many.txt:300:"), "the tail survives the elision");
		ok(!rendered.includes("many.txt:150:"), "a central row is hidden by the middle-elision");
	});

	it("minimal output keeps tool calls collapsed while verbose output exposes the live body", () => {
		let verbosity: "minimal" | "default" | "verbose" = "minimal";
		const panel = createChatPanel({ now: frozen.now, getOutputVerbosity: () => verbosity });
		feedLargeGrep(panel);
		let rendered = panel.render(100).join("\\n");
		ok(!rendered.includes("many.txt:150:"), "minimal output hides the tool body");
		verbosity = "verbose";
		rendered = panel.render(100).join("\\n");
		ok(rendered.includes("many.txt:1:"), "verbose output exposes the tool body");
	});

	it("unboundedToolBodies renders the full expanded tool body with no middle-elision (for /export)", () => {
		const panel = createChatPanel({ now: frozen.now, unboundedToolBodies: true });
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
		ok(atEnd.includes("✗ orphaned"), `the stranded orphan carries an explicit orphaned label, got: ${atEnd}`);
		clock = 100_000;
		strictEqual(strip(panel.render(100).join("\n")), atEnd, "the settled line does not keep counting");
	});

	it("routes tool_execution_update to a segment stranded behind a notice entry", () => {
		const clock = 1000;
		const panel = createChatPanel({ now: () => clock });
		// grep, not bash: bash folds by default, and this test is about routing a
		// streamed body to a stranded segment, not about the fold policy.
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "s1",
			toolName: "grep",
			args: { pattern: "sleep" },
		} as ChatLoopEvent);
		panel.appendReplayBlock(() => ["context-engine notice"]);
		panel.applyEvent({
			type: "tool_execution_update",
			toolCallId: "s1",
			toolName: "grep",
			partialResult: "streamed tail line",
		} as ChatLoopEvent);
		const rendered = strip(panel.render(100).join("\n"));
		ok(rendered.includes("streamed tail line"), `the streamed body still renders after the split, got: ${rendered}`);
	});

	it("re-renders a live replay block until it declares itself settled", () => {
		let clock = 1_000;
		const panel = createChatPanel({ now: () => clock });
		// Mirrors the operator's `!` bash row: the closure reads state the command
		// keeps mutating, so the panel must not treat the first frame as final.
		const command = { output: "", running: true };
		panel.appendReplayBlock(
			() => [`local bash ${command.running ? "running" : "done"}: ${command.output || "(no output yet)"}`],
			() => command.running,
		);
		const first = strip(panel.render(100).join("\n"));
		ok(first.includes("(no output yet)"), `the first frame shows the empty live row, got: ${first}`);

		command.output = "src/tools";
		clock = 1_100;
		const streaming = strip(panel.render(100).join("\n"));
		ok(streaming.includes("running: src/tools"), `streamed output reaches a later frame, got: ${streaming}`);

		command.output = "src/tools";
		command.running = false;
		clock = 1_200;
		const settled = strip(panel.render(100).join("\n"));
		ok(settled.includes("done: src/tools"), `the row settles when the command finishes, got: ${settled}`);

		// Once settled the block is frozen again, so a later clock renders identically.
		clock = 3_601_000;
		strictEqual(strip(panel.render(100).join("\n")), settled, "a settled replay block renders time-invariant");
	});

	it("keeps one Pi tool row from streamed arguments through live output and settlement", () => {
		let clock = 1_000;
		const panel = createChatPanel({ now: () => clock });
		const partial = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "streamed-call-1",
					name: "grep",
					arguments: { pattern: "AgentToolResult", path: "src", ignoreCase: true },
				},
			],
			api: "openai-completions",
			provider: "test",
			model: "fixture",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
			stopReason: "pending",
			timestamp: 0,
		};
		panel.applyEvent({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "src", partial },
		} as unknown as ChatLoopEvent);
		let rendered = strip(panel.render(110).join("\n"));
		ok(rendered.includes("forming call"), rendered);
		ok(rendered.includes("grep(AgentToolResult)"), rendered);

		panel.applyEvent({ type: "message_end", message: { ...partial, stopReason: "toolUse" } } as unknown as ChatLoopEvent);
		rendered = strip(panel.render(110).join("\n"));
		ok(rendered.includes("ready"), rendered);

		clock = 1_300;
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "streamed-call-1",
			toolName: "grep",
			args: { pattern: "AgentToolResult", path: "src", ignoreCase: true },
		} as ChatLoopEvent);
		clock = 1_600;
		panel.applyEvent({
			type: "tool_execution_update",
			toolCallId: "streamed-call-1",
			toolName: "grep",
			partialResult: {
				content: [{ type: "text", text: "src/engine/types.ts:42" }],
				details: { observation: { shownCount: 1, totalCount: 3, unit: "matches", shownBytes: 22 } },
			},
		} as ChatLoopEvent);
		rendered = strip(panel.render(110).join("\n"));
		ok(rendered.includes("running · 300ms"), rendered);
		ok(rendered.includes("args · 2"), rendered);
		ok(rendered.includes("path"), rendered);
		ok(rendered.includes("live output · 1/3 matches · 22B"), rendered);
		ok(rendered.includes("src/engine/types.ts:42"), rendered);

		clock = 1_700;
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "streamed-call-1",
			toolName: "grep",
			result: {
				content: [{ type: "text", text: "src/engine/types.ts:42" }],
				details: { observation: { shownCount: 1, totalCount: 3, unit: "matches", shownBytes: 22 } },
			},
			isError: false,
			durationMs: 400,
		} as ChatLoopEvent);
		rendered = strip(panel.render(110).join("\n"));
		strictEqual((rendered.match(/▸ grep\(/g) ?? []).length, 1, rendered);
		ok(rendered.includes("✓ · 400ms"), rendered);
		ok(rendered.includes("output · 1/3 matches · 22B"), rendered);
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
		// Populate the completed-entry cache before the late result arrives.
		ok(strip(panel.render(100).join("\n")).includes("✗ orphaned"));
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

	it("labels an unfinished call aborted when the run reports an aborted assistant", () => {
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "abort-1",
			toolName: "bash",
			args: { command: "sleep 10" },
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
		} as unknown as ChatLoopEvent);
		ok(strip(panel.render(80).join("\n")).includes("✗ aborted"));
	});

	it("renders a permission-parked tool segment as awaiting approval, not running", () => {
		let clock = 1000;
		const panel = createChatPanel({ now: () => clock });
		// Streamed text first: the segment starts collapsed, so the running form
		// carries the counting elapsed subline the awaiting state must replace.
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "Dispatching." } as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "park1",
			toolName: "dispatch",
			args: { tasks: ["fix the flaky test"] },
		} as ChatLoopEvent);
		clock = 1500;
		// pi emitted tool_execution_start before admission parked the body: the
		// raw segment renders the counting running form.
		let rendered = strip(panel.render(80).join("\n"));
		ok(!rendered.includes("awaiting approval"), rendered);
		ok(rendered.includes("500ms"), `pre-park the segment counts elapsed, got: ${rendered}`);

		panel.applyEvent({
			type: "tool_approval_state",
			toolCallId: "park1",
			state: "awaiting-approval",
			view: approvalView({
				tool: "dispatch",
				actionClass: "dispatch",
				axis: { kind: "net", ruleId: "dispatch-plan-confirm" },
				target: "fix the flaky test",
			}),
		} as ChatLoopEvent);
		clock = 2500;
		rendered = strip(panel.render(80).join("\n"));
		ok(rendered.includes("⏸ awaiting approval"), `a parked call renders the awaiting marker, got: ${rendered}`);
		ok(rendered.includes("action · dispatch"), `the parked row names its action class, got: ${rendered}`);
		ok(
			rendered.includes("axis · safety-net rail dispatch-plan-confirm"),
			`the parked row names its axis, got: ${rendered}`,
		);
		ok(rendered.includes("target · fix the flaky test"), `the parked row names its redacted target, got: ${rendered}`);
		ok(!rendered.includes("1.5s"), `a parked call must not keep counting elapsed, got: ${rendered}`);
		ok(!rendered.includes("✓") && !rendered.includes("✗"), rendered);

		// The operator grants the call: the segment returns to the running form
		// before its body executes, then finishes normally.
		panel.applyEvent({ type: "tool_approval_state", toolCallId: "park1", state: "resumed" } as ChatLoopEvent);
		rendered = strip(panel.render(80).join("\n"));
		ok(!rendered.includes("awaiting approval"), `a resumed call sheds the awaiting marker, got: ${rendered}`);
		ok(!rendered.includes("dispatch-plan-confirm"), `a resumed call sheds transient approval facts, got: ${rendered}`);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "park1",
			toolName: "dispatch",
			result: "dispatch (parallel) total=1 failed=0",
			isError: false,
			durationMs: 2100,
		} as ChatLoopEvent);
		rendered = strip(panel.render(80).join("\n"));
		ok(rendered.includes("✓"), `the granted call settles as ordinary success, got: ${rendered}`);
		ok(!rendered.includes("awaiting approval"), rendered);
	});

	it("settles an approval-parked segment as blocked on operator cancel", () => {
		let clock = 1000;
		const panel = createChatPanel({ now: () => clock });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "park2",
			toolName: "bash",
			args: { command: "rm -rf build" },
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_approval_state",
			toolCallId: "park2",
			state: "awaiting-approval",
			view: approvalView({ target: "rm -rf build" }),
		} as ChatLoopEvent);
		ok(strip(panel.render(80).join("\n")).includes("⏸ awaiting approval"));
		// Operator cancel: the registry resolves the parked promise blocked and
		// the segment settles through its ordinary tool_execution_end, which the
		// turn runtime stamps with that verdict.
		clock = 1600;
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "park2",
			toolName: "bash",
			result: "User cancelled this tool call from the permission confirmation prompt.",
			isError: true,
			durationMs: 600,
			outcome: "blocked",
			blockReason: "operator denied bash at the confirmation prompt",
		} as ChatLoopEvent);
		const atEnd = strip(panel.render(80).join("\n"));
		ok(!atEnd.includes("awaiting approval"), `a denied park sheds the awaiting marker, got: ${atEnd}`);
		ok(atEnd.includes("✗ blocked"), `a denied park carries a blocked label, got: ${atEnd}`);
		ok(
			atEnd.includes("operator denied bash at the confirmation prompt"),
			`a blocked row states why it was refused, got: ${atEnd}`,
		);
		// The settled line is time-invariant: no lingering spinner keeps counting.
		clock = 100_000;
		strictEqual(strip(panel.render(80).join("\n")), atEnd);
	});

	it("labels a command that ran and failed an error, not a permission block", () => {
		// `node --test` prints `cancelled 0` in every summary and names the
		// failing assertion in its trailer. Classifying settlement by searching
		// result text for blocked/denied/cancelled/permission therefore labelled
		// every failing Node test run a permission block and, because a blocked
		// row is rendered as a call that never executed, hid the very output
		// that explained the failure.
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "run1",
			toolName: "bash",
			args: { command: "npm test" },
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "run1",
			toolName: "bash",
			result: [
				"> tally@0.1.0 test",
				"> node --test tests/*.test.js",
				"ℹ tests 2",
				"ℹ pass 0",
				"ℹ fail 2",
				"ℹ cancelled 0",
				"TypeError: assert.deepStrictEqual is not a function",
			].join("\n"),
			isError: true,
			durationMs: 323,
		} as ChatLoopEvent);
		const rendered = strip(panel.render(80).join("\n"));
		ok(!rendered.includes("blocked"), `a command that ran is never blocked, got: ${rendered}`);
		// The point of the label is the body it gates: a blocked row is rendered
		// as a call that never executed, so mislabelling one suppressed the
		// failure the operator and the model both needed to read.
		ok(
			rendered.includes("TypeError: assert.deepStrictEqual is not a function"),
			`an executed command keeps its output, got: ${rendered}`,
		);
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
		const panel = createChatPanel({ now: frozen.now });
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

	/**
	 * The suggestion a model actually writes has `<name>` substituted, so this
	 * feeds a real line rather than the template. Testing the template passed
	 * against a guard that could never fire in production: every live reply held
	 * the ✦ on the advisory line while the answer beneath it hung plain.
	 */
	it("leaves a leading skill suggestion unglyphed and gives ✦ to the answer after the tool ledger", () => {
		const suggestion = SKILL_SUGGESTION_ANCHOR.replace("<name>", "tui-design");
		strictEqual(suggestion, "Suggested skill: /skill tui-design");
		ok(suggestion.startsWith(SKILL_SUGGESTION_PREFIX), "a substituted suggestion still carries the shared prefix");
		ok(!suggestion.includes("<name>"), "no live reply writes the placeholder");

		for (const width of [40, 72, 80, 100]) {
			const panel = createChatPanel({ now: frozen.now });
			panel.applyEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: suggestion }], stopReason: "stop" },
			} as ChatLoopEvent);
			panel.applyEvent({
				type: "tool_execution_start",
				toolCallId: "skill-read",
				toolName: "read",
				args: { path: "skills/example/SKILL.md" },
			} as ChatLoopEvent);
			panel.applyEvent({
				type: "tool_execution_end",
				toolCallId: "skill-read",
				toolName: "read",
				result: "skill body",
				isError: false,
			} as ChatLoopEvent);
			panel.applyEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "Substantive answer" }], stopReason: "stop" },
			} as ChatLoopEvent);
			panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);

			const plain = strip(panel.render(width).join("\n"));
			const suggestionAt = plain.indexOf(SKILL_SUGGESTION_PREFIX);
			const toolAt = plain.indexOf("skills/example/SKILL.md");
			const answerAt = plain.indexOf("✦ Substantive answer");
			ok(suggestionAt >= 0, `${width}: the suggestion renders: ${plain}`);
			ok(!plain.includes(`✦ ${SKILL_SUGGESTION_PREFIX}`), `${width}: the suggestion claimed the glyph: ${plain}`);
			ok(toolAt > suggestionAt, `${width}: the tool ledger follows the suggestion: ${plain}`);
			ok(answerAt > toolAt, `${width}: the answer owns the glyph below the tool ledger: ${plain}`);
			strictEqual(plain.split("✦").length - 1, 1, `${width}: exactly one reply glyph in the turn: ${plain}`);
		}
	});

	/**
	 * The shape the prompt actually asks for: the reply *begins* with the
	 * suggestion, so the line and the answer arrive in one text segment. Judging
	 * that whole segment advisory by its prefix left the turn with no glyph at
	 * all — the suggestion declined it and the answer never got the chance.
	 */
	it("splits a one-segment suggestion so the answer under it still owns ✦", () => {
		const suggestion = SKILL_SUGGESTION_ANCHOR.replace("<name>", "tui-design");
		const answer = "The substantive answer prose follows on its own line.";
		for (const width of [40, 72, 80, 100]) {
			const panel = createChatPanel({ now: frozen.now });
			panel.applyEvent({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `${suggestion}\n${answer}` }],
					stopReason: "stop",
				},
			} as ChatLoopEvent);
			panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);

			const rows = panel.render(width).map(strip);
			const plain = rows.join("\n");
			const suggestionRow = rows.findIndex((row) => row.includes(SKILL_SUGGESTION_PREFIX));
			const answerRow = rows.findIndex((row) => row.startsWith(`${GLYPH.agent} `));
			ok(suggestionRow >= 0, `${width}: the suggestion renders: ${plain}`);
			ok(rows[suggestionRow]?.startsWith("  "), `${width}: the suggestion claimed the glyph: ${plain}`);
			ok(answerRow > suggestionRow, `${width}: the answer under the suggestion owns the glyph: ${plain}`);
			ok(rows[answerRow]?.includes("The substantive answer"), `${width}: the glyph landed off the answer: ${plain}`);
			strictEqual(plain.split("✦").length - 1, 1, `${width}: exactly one reply glyph in the turn: ${plain}`);
		}
	});

	/**
	 * Live captures put a blank line between the suggestion and the answer. The
	 * remainder then opened with a newline, so the answer's first rendered row
	 * was empty and the glyph decorated that empty row instead of the prose.
	 */
	it("gives ✦ to the answer text when a blank line separates it from the suggestion", () => {
		const suggestion = SKILL_SUGGESTION_ANCHOR.replace("<name>", "tui-design");
		const answer = "The substantive answer prose follows after a blank line.";
		for (const width of [40, 72, 80, 100]) {
			const panel = createChatPanel({ now: frozen.now });
			panel.applyEvent({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `${suggestion}\n\n${answer}` }],
					stopReason: "stop",
				},
			} as ChatLoopEvent);
			panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);

			const rows = panel.render(width).map(strip);
			const plain = rows.join("\n");
			const suggestionRow = rows.findIndex((row) => row.includes(SKILL_SUGGESTION_PREFIX));
			const glyphRow = rows.findIndex((row) => row.startsWith(`${GLYPH.agent} `));
			ok(suggestionRow >= 0, `${width}: the suggestion renders: ${plain}`);
			ok(rows[suggestionRow]?.startsWith("  "), `${width}: the suggestion claimed the glyph: ${plain}`);
			ok(glyphRow > suggestionRow, `${width}: the answer under the suggestion owns the glyph: ${plain}`);
			ok(
				rows[glyphRow]?.includes("The substantive answer"),
				`${width}: the glyph landed on an empty row, not the answer: ${JSON.stringify(rows[glyphRow])}`,
			);
			strictEqual(plain.split("✦").length - 1, 1, `${width}: exactly one reply glyph in the turn: ${plain}`);
		}
	});

	it("keeps the split shape row-stable from streaming through finalized Markdown", () => {
		const suggestion = SKILL_SUGGESTION_ANCHOR.replace("<name>", "tui-design");
		const chunks = [suggestion.slice(0, 28), `${suggestion.slice(28)}\nThe substantive`, " answer prose follows."];
		const panel = createChatPanel({ now: frozen.now });
		let partial = "";
		for (const delta of chunks) {
			partial += delta;
			panel.applyEvent({ type: "text_delta", contentIndex: 0, delta, partialText: partial } as ChatLoopEvent);
		}
		const streaming = panel.render(80).map(strip);
		panel.applyEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: partial }], stopReason: "stop" },
		} as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
		const finalized = panel.render(80).map(strip);
		strictEqual(finalized.join("\n"), streaming.join("\n"), "the split shape changed when the segment finalized");
		ok(
			finalized.some((row) => row.startsWith(`${GLYPH.agent} The substantive answer`)),
			`the answer owns the glyph while streaming: ${finalized.join("\n")}`,
		);
	});

	it("leaves a suggestion-only reply entirely unglyphed", () => {
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: SKILL_SUGGESTION_ANCHOR.replace("<name>", "tui-design") }],
				stopReason: "stop",
			},
		} as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
		const plain = strip(panel.render(80).join("\n"));
		ok(plain.includes(SKILL_SUGGESTION_PREFIX), plain);
		strictEqual(plain.split("✦").length - 1, 0, `an advisory-only turn claims no glyph: ${plain}`);
	});

	it("turns the reply glyph and the terminal error text red on a failed turn", () => {
		const panel = createChatPanel({ now: frozen.now });
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

	it("scopes a post-tool main-model timeout to the model and leaves the dispatch segment non-error", () => {
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "dispatch-1",
			toolName: "dispatch",
			args: { agent: "scout", task: "map the repository", detach: true },
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "dispatch-1",
			toolName: "dispatch",
			result: "run fleet-1 accepted",
			isError: false,
			durationMs: 120,
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [] as unknown[],
				stopReason: "error",
				errorMessage: "request timed out after 30 seconds",
			},
		} as unknown as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);

		const rendered = panel.render(120).join("\n");
		const plain = strip(rendered);
		ok(plain.includes("✓"), `the successful dispatch remains successful, got: ${plain}`);
		ok(!plain.includes("✗"), `the model timeout must not turn dispatch into a failed tool, got: ${plain}`);
		ok(
			plain.includes("[error] main model response timed out after successful tool result; detached runs continue"),
			`the terminal failure is scoped to the main model, got: ${plain}`,
		);
		ok(
			rendered.includes(`${fgSequence("error")}[error] main model response timed out`),
			"the scoped terminal failure preserves error-token styling",
		);
	});

	it("does not claim detached continuation after a successful non-dispatch tool", () => {
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "README.md" },
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
			result: "contents",
			isError: false,
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider connection failed" },
		} as unknown as ChatLoopEvent);

		const plain = strip(panel.render(120).join("\n"));
		ok(plain.includes("[error] main model response failed after successful tool result: provider connection failed"));
		ok(!plain.includes("detached runs continue"));
	});

	it("does not claim detached continuation after an attached dispatch", () => {
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "dispatch-attached",
			toolName: "dispatch",
			args: { tasks: ["review the change"] },
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "dispatch-attached",
			toolName: "dispatch",
			result: "attached run completed",
			isError: false,
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: "request timed out" },
		} as unknown as ChatLoopEvent);

		const plain = strip(panel.render(120).join("\n"));
		ok(plain.includes("[error] main model response timed out after successful tool result"));
		ok(!plain.includes("detached runs continue"));
	});
});

describe("chat-panel tool ledger subline", () => {
	function feedCollapsedRead(panel: ReturnType<typeof createChatPanel>): void {
		// Rich non-resource calls expand consistently; explicitly fold this one
		// to exercise the compact ledger contract without relying on event order.
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
		panel.toggleLastToolExpanded();
		panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
	}

	it("wraps the collapsed subline to two lines without splitting the status tail", () => {
		const panel = createChatPanel({ now: frozen.now, getToolExpandKey: () => "ctrl+o" });
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
	it("renders the canonical result diff for the current multi-edit argument shape", () => {
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "e1",
			toolName: "edit",
			args: { path: "a.txt", edits: [{ oldText: "line two", newText: "line TWO" }] },
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "e1",
			toolName: "edit",
			result: {
				content: [{ type: "text", text: "edited a.txt" }],
				details: { diff: " 1 line one\n-2 line two\n+2 line TWO" },
			},
			isError: false,
		} as ChatLoopEvent);
		const rendered = strip(panel.render(80).join("\n"));
		ok(rendered.includes("line TWO"), "the diff still renders the actual change");
		ok(rendered.includes("line two"), "the diff keeps the removed text");
		ok(!rendered.includes("edited a.txt"), "the confirmation does not replace the review surface");
	});
});

describe("chat-panel live reasoning indicator", () => {
	function pendingTurnWithTool(): ReturnType<typeof createChatPanel> {
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "weighing options",
			partialThinking: "weighing options",
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "a.ts" },
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		} as ChatLoopEvent);
		panel.applyEvent({ type: "text_delta", contentIndex: 1, delta: "answering now" } as ChatLoopEvent);
		return panel;
	}

	// The marker used to render above every segment, so on a long turn the only
	// reasoning indicator scrolled off the top while text and tools streamed
	// below it (issue #171).
	it("renders the live line at the tail, below the turn's tool and text segments", () => {
		const panel = pendingTurnWithTool();
		panel.setLiveReasoning({ tokens: 1234, provenance: "estimated" });
		const rows = panel
			.render(80)
			.map(strip)
			.filter((row) => row.trim().length > 0);
		const last = rows[rows.length - 1] ?? "";
		ok(last.includes("Thinking · r≈1.2k estimated"), JSON.stringify(rows));
		const thinkingRows = rows.filter((row) => row.includes("Thinking"));
		strictEqual(thinkingRows.length, 1, `one reasoning indicator per entry: ${JSON.stringify(rows)}`);
		ok(
			rows.some((row) => row.includes("answering now")),
			JSON.stringify(rows),
		);
		ok(rows.findIndex((row) => row.includes("answering now")) < rows.length - 1, "the line sits below the prose");
	});

	it("does not print a second thinking indicator from the status verb", () => {
		const panel = pendingTurnWithTool();
		panel.setLiveReasoning({ tokens: 900, provenance: "provider" });
		panel.setStatusLine({ phase: "thinking", verb: "receiving thinking", toneHint: "muted" });
		const rendered = strip(panel.render(80).join("\n"));
		ok(rendered.includes("Thinking · r900 provider-reported"), rendered);
		ok(!rendered.includes("receiving thinking"), rendered);
	});

	it("states no token count until something settles into the tally", () => {
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "a".repeat(4000),
			partialThinking: "a".repeat(4000),
		} as ChatLoopEvent);
		const rendered = strip(panel.render(80).join("\n"));
		ok(rendered.includes("Thinking…"), rendered);
		ok(!/r[≈0-9]/.test(rendered), `no count is inferred from the visible excerpt: ${rendered}`);
	});

	it("counts elapsed thinking time off the panel clock", () => {
		let clock = 1_000;
		const panel = createChatPanel({ now: () => clock });
		panel.applyEvent({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "still going",
			partialThinking: "still going",
		} as ChatLoopEvent);
		ok(!strip(panel.render(80).join("\n")).includes("· 0s"), "a fresh turn states no elapsed");
		clock = 13_400;
		panel.setLiveReasoning({ tokens: 3400, provenance: "provider" });
		const rendered = strip(panel.render(80).join("\n"));
		ok(rendered.includes("Thinking · r3.4k provider-reported · 12s"), rendered);
	});

	it("keeps the provider count after message_end instead of re-deriving it from text", () => {
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "b".repeat(4000),
			partialThinking: "b".repeat(4000),
		} as ChatLoopEvent);
		const message = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "b".repeat(4000) }],
			usage: { input: 30, output: 900, reasoningTokens: 42 },
			stopReason: "stop",
		};
		panel.applyEvent({ type: "message_end", message } as unknown as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [message] } as unknown as ChatLoopEvent);
		const rendered = strip(panel.render(100).join("\n"));
		ok(rendered.includes("Thinking… · r42 provider-reported"), rendered);
		ok(!rendered.includes("≈"), `the estimate never overwrites an attested count: ${rendered}`);
	});

	it("folds to a head marker carrying the settled count once the turn ends", () => {
		const panel = createChatPanel({ now: frozen.now });
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "c".repeat(4800) },
				{ type: "text", text: "done" },
			],
			usage: { input: 30, output: 5000 },
			stopReason: "stop",
		};
		panel.applyEvent({ type: "message_end", message } as unknown as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [message] } as unknown as ChatLoopEvent);
		const rows = panel
			.render(80)
			.map(strip)
			.filter((row) => row.trim().length > 0);
		strictEqual(rows[0], "Thinking… · r≈1.2k estimated", JSON.stringify(rows));
		ok(
			rows.some((row) => row.includes("done")),
			JSON.stringify(rows),
		);
	});

	it("keeps the expanded excerpt and its caveat on the settled receipt", () => {
		const panel = createChatPanel({ now: frozen.now, getOutputVerbosity: () => "verbose" });
		const message = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "first reasoning line\nsecond reasoning line" }],
			usage: { input: 30, output: 900, reasoningTokens: 42 },
			stopReason: "stop",
		};
		panel.applyEvent({ type: "message_end", message } as unknown as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [message] } as unknown as ChatLoopEvent);
		const rendered = strip(panel.render(100).join("\n"));
		ok(rendered.includes("first reasoning line"), rendered);
		ok(rendered.includes("second reasoning line"), rendered);
		ok(rendered.replace(/\s+/g, " ").includes("reasoning text is a UI excerpt, not a verification"), rendered);
	});

	// A cancel mid-turn keeps whatever the run tally folded (commit 9b29c2ca), so
	// the settled marker states the spend rather than dropping it.
	it("settles a cancelled turn onto the head marker and stops showing the live line", () => {
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "planning",
			partialThinking: "planning",
		} as ChatLoopEvent);
		panel.setLiveReasoning({ tokens: 42, provenance: "provider" });
		const message = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "planning" }],
			usage: { input: 30, output: 900, reasoningTokens: 42 },
			stopReason: "aborted",
		};
		panel.applyEvent({ type: "message_end", message } as unknown as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [message] } as unknown as ChatLoopEvent);
		const rows = panel
			.render(80)
			.map(strip)
			.filter((row) => row.trim().length > 0);
		strictEqual(rows[0], "Thinking… · r42 provider-reported", JSON.stringify(rows));
		ok(!rows.some((row) => row.includes("Thinking ·")), `no live line survives the settle: ${JSON.stringify(rows)}`);
	});

	// Replay rebuilds settled entries from persisted usage. A live projection
	// arriving from a fresh turn must never retro-label that history.
	it("never puts a live count on a settled entry", () => {
		const panel = createChatPanel({ now: frozen.now });
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "replayed reasoning" },
				{ type: "text", text: "replayed answer" },
			],
			usage: { input: 30, output: 900, reasoningTokens: 7 },
			stopReason: "stop",
		};
		panel.applyEvent({ type: "message_end", message } as unknown as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [message] } as unknown as ChatLoopEvent);
		panel.setLiveReasoning({ tokens: 9999, provenance: "estimated" });
		const rendered = strip(panel.render(80).join("\n"));
		ok(rendered.includes("Thinking… · r7 provider-reported"), rendered);
		ok(!rendered.includes("9999"), rendered);
		ok(!rendered.includes("9.9k"), rendered);
	});

	it("shows no reasoning line at all on a turn that never thought", () => {
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "straight to the answer" } as ChatLoopEvent);
		panel.setLiveReasoning({ tokens: 500, provenance: "provider" });
		const rendered = strip(panel.render(80).join("\n"));
		ok(!rendered.includes("Thinking"), rendered);
		ok(!rendered.includes("r500"), rendered);
	});

	it("states the same reasoning text at 40, 80, and 120 columns and across bare re-renders", () => {
		const panel = pendingTurnWithTool();
		panel.setLiveReasoning({ tokens: 1234, provenance: "mixed" });
		for (const width of [40, 80, 120]) {
			const rows = panel.render(width).map(strip);
			ok(
				rows.some((row) => row.includes("Thinking · r≈1.2k mixed")),
				`width ${width}: ${JSON.stringify(rows)}`,
			);
			ok(
				rows.every((row) => row.length <= width),
				`width ${width} never overflows`,
			);
		}
		// Two renders with no events in between are byte-identical: the line reads
		// the tally, not anything the render itself measures.
		strictEqual(panel.render(80).join("\n"), panel.render(80).join("\n"));
	});
});

describe("chat-panel reasoning provenance and renderer controls", () => {
	it("shows provider reasoning totals distinctly from estimated totals", () => {
		const providerPanel = createChatPanel({ now: frozen.now, getOutputVerbosity: () => "verbose" });
		const providerMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "provider reasoning body" }],
			usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 1, reasoningTokens: 42 },
			stopReason: "stop",
		};
		providerPanel.applyEvent({ type: "message_end", message: providerMessage } as unknown as ChatLoopEvent);
		providerPanel.applyEvent({ type: "agent_end", messages: [providerMessage] } as unknown as ChatLoopEvent);
		const providerText = strip(providerPanel.render(120).join("\\n"));
		ok(providerText.includes("reasoning 42 provider"), providerText);
		ok(!providerText.includes("reasoning ≈42"), providerText);
		ok(providerText.includes("cache 3/1"), providerText);
		ok(providerText.includes("not a verification"), providerText);

		const estimatedPanel = createChatPanel({ now: frozen.now, getOutputVerbosity: () => "verbose" });
		estimatedPanel.applyEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "estimated reasoning body" }],
				stopReason: "stop",
			},
		} as ChatLoopEvent);
		estimatedPanel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
		const estimatedText = strip(estimatedPanel.render(120).join("\\n"));
		ok(estimatedText.includes("reasoning ≈"), estimatedText);
		ok(estimatedText.includes("estimated"), estimatedText);
	});

	it("keeps the excerpt caveat off a turn that produced no reasoning", () => {
		// Live, every turn carried `reasoning 0 provider · reasoning text is a UI
		// excerpt, not a verification`. The caveat is about reasoning text the
		// panel displayed, so on a turn that displayed none it warned about
		// something absent and cost a wrapped line per turn at 70 columns.
		const panel = createChatPanel({ now: frozen.now, getOutputVerbosity: () => "verbose" });
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "no thinking here" }],
			usage: { input: 9650, output: 7, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
			stopReason: "stop",
		};
		panel.applyEvent({ type: "message_end", message } as unknown as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [message] } as unknown as ChatLoopEvent);
		const text = strip(panel.render(70).join("\n"));
		ok(text.includes("turn · in 9650"), text);
		ok(!text.includes("not a verification"), text);
	});

	it("omits the reasoning suffix entirely on a zero-reasoning turn", () => {
		// The llama.cpp path reports `reasoningTokens: 0` where LM Studio reports
		// nothing at all, and the panel printed `reasoning 0 provider` for it. At
		// 71 columns that pushed the bare word `provider` onto its own line. Zero
		// reasoning is the same story as no reasoning: say nothing.
		const panel = createChatPanel({ now: frozen.now, getOutputVerbosity: () => "verbose" });
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "answered without thinking" }],
			usage: { input: 7434, output: 367, cacheRead: 16865, cacheWrite: 0, reasoningTokens: 0 },
			stopReason: "stop",
		};
		panel.applyEvent({ type: "message_end", message } as unknown as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [message] } as unknown as ChatLoopEvent);
		const text = strip(panel.render(71).join("\n"));
		ok(text.includes("cache 16865/0"), text);
		ok(!text.includes("reasoning"), text);
		ok(!text.includes("provider"), text);
	});

	it("makes turn receipts honest to minimal, default, and verbose output", () => {
		let verbosity: "minimal" | "default" | "verbose" = "minimal";
		const panel = createChatPanel({ now: frozen.now, getOutputVerbosity: () => verbosity });
		const message = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "reasoning excerpt" }],
			usage: { input: 12_345, output: 678, cacheRead: 90, cacheWrite: 12, reasoningTokens: 34 },
			stopReason: "stop",
		};
		panel.applyEvent({ type: "message_end", message } as unknown as ChatLoopEvent);
		const followupCall = {
			role: "assistant",
			content: [],
			usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
			stopReason: "toolUse",
		};
		panel.applyEvent({
			type: "agent_end",
			messages: [message, followupCall, followupCall],
		} as unknown as ChatLoopEvent);

		let rows = panel.render(36).map(strip);
		strictEqual(rows.filter((row) => row.includes("turn ·")).length, 0, JSON.stringify(rows));

		verbosity = "default";
		const defaultRows = panel.render(36);
		ok(defaultRows.find((row) => strip(row).includes("turn ·"))?.includes(SGR_DIM), "the compact receipt is dim");
		rows = defaultRows.map(strip);
		const compact = rows.filter((row) => row.includes("turn ·"));
		strictEqual(compact.length, 1, `default owns one receipt row: ${JSON.stringify(rows)}`);
		ok(compact[0]?.includes("in 12345 · out 680"), JSON.stringify(compact));
		ok(!compact[0]?.includes("cache"), JSON.stringify(compact));
		ok(!rows.some((row) => row.includes("not a verification")), JSON.stringify(rows));

		verbosity = "verbose";
		const verbose = strip(panel.render(120).join("\n"));
		const normalizedVerbose = verbose.replace(/\s+/g, " ");
		ok(verbose.includes("over 3 calls"), verbose);
		ok(verbose.includes("cache 90/12"), verbose);
		ok(verbose.includes("reasoning 34 provider"), verbose);
		ok(normalizedVerbose.includes("reasoning text is a UI excerpt, not a verification"), verbose);
	});

	it("pauses and resumes cumulative live tool output without changing execution state", () => {
		const panel = createChatPanel({ now: frozen.now, getOutputVerbosity: () => "verbose" });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "live-1",
			toolName: "bash",
			args: { command: "printf hi" },
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_update",
			toolCallId: "live-1",
			partialResult: "partial hi",
		} as ChatLoopEvent);
		for (const width of [20, 40, 80, 120]) {
			for (const line of panel.render(width)) {
				ok(strip(line).length <= width, `running line overflows ${width}: ${line}`);
			}
		}
		panel.toggleLiveToolOutput();
		const paused = strip(panel.render(80).join("\\n"));
		ok(!paused.includes("partial hi"), paused);
		ok(paused.includes("running"), paused);
		panel.toggleLiveToolOutput();
		ok(strip(panel.render(80).join("\\n")).includes("partial hi"));
	});

	it("invalidates bounded render caches and keeps every line width-safe", () => {
		const metrics: Array<{ cacheHit: boolean; entriesRendered: number }> = [];
		const panel = createChatPanel({
			now: frozen.now,
			onRenderMetrics: ({ cacheHit, entriesRendered }) => metrics.push({ cacheHit, entriesRendered }),
		});
		panel.appendUser("stable history");
		panel.render(24);
		panel.render(24);
		ok(
			metrics.some((metric) => metric.cacheHit),
			JSON.stringify(metrics),
		);
		panel.appendUser("new history");
		const lines = panel.render(12);
		ok(metrics.at(-1)?.cacheHit === false, JSON.stringify(metrics));
		for (const line of lines) ok(strip(line).length <= 12, `line exceeded narrow width: ${line}`);

		const historyMetrics: Array<{ cacheHit: boolean; entriesRendered: number }> = [];
		const history = createChatPanel({
			now: frozen.now,
			onRenderMetrics: ({ cacheHit, entriesRendered }) => historyMetrics.push({ cacheHit, entriesRendered }),
		});
		for (let index = 0; index < 500; index += 1) history.appendUser(`stable entry ${index}`);
		history.render(80);
		history.appendUser("late result entry");
		history.render(80);
		ok((historyMetrics.at(-1)?.entriesRendered ?? Number.POSITIVE_INFINITY) <= 256, JSON.stringify(historyMetrics));
	});

	it("redacts URLs, flags, shell assignments, and nested environment values", () => {
		const safe = redactToolArgs({
			url: "https://alice:password@example.test/run?token=url-secret&keep=yes",
			command: "export API_KEY=shell-secret SAFE=value --token flag-secret",
			flags: ["--password=flag-secret-2"],
			env: { NESTED: { SERVICE_TOKEN: "env-secret", SAFE: "also-secret" } },
		});
		const serialized = JSON.stringify(safe);
		ok(!serialized.includes("password@example"), serialized);
		ok(!serialized.includes("$1"), serialized);
		ok(!serialized.includes("url-secret"), serialized);
		ok(!serialized.includes("shell-secret"), serialized);
		ok(!serialized.includes("flag-secret"), serialized);
		ok(serialized.includes("SAFE=value"), serialized);
		if (typeof safe !== "object" || safe === null || Array.isArray(safe)) throw new Error("expected object");
		const env = (safe as { env?: unknown }).env;
		ok(typeof env === "object" && env !== null && !Array.isArray(env), "nested env shape is retained");
	});

	it("redacts secret arguments and environment values while preserving tool structure", () => {
		const panel = createChatPanel({ now: frozen.now, getOutputVerbosity: () => "verbose" });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "secret-1",
			toolName: "custom_tool",
			args: { apiKey: "super-secret-key", env: { SERVICE_TOKEN: "another-secret" }, command: "TOKEN=third-secret run" },
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "secret-1",
			toolName: "custom_tool",
			result: "done",
			isError: false,
		} as ChatLoopEvent);
		const rendered = strip(panel.render(120).join("\\n"));
		ok(!rendered.includes("super-secret-key"), rendered);
		ok(!rendered.includes("another-secret"), rendered);
		ok(!rendered.includes("third-secret"), rendered);
		ok(rendered.includes("[redacted]"), rendered);
	});

	/**
	 * A mid-turn notice splits the transcript, so the events after it open a
	 * fresh assistant entry. A turn that stopped there never filled it, and
	 * `agent_end` wrote the run total onto it because it was simply the last
	 * assistant entry: the identical usage line printed above and below the
	 * notice, the lower one under a lone agent bubble with nothing in it.
	 */
	it("prints one usage line for a turn a notice split, and no empty bubble", () => {
		const message = {
			role: "assistant",
			stopReason: "stop",
			usage: { input: 14073, output: 198, cacheRead: 10404, cacheWrite: 0 },
		};
		const panel = createChatPanel({ now: frozen.now });
		panel.appendUser("a question");
		panel.applyEvent({ type: "text_delta", delta: "an answer" } as ChatLoopEvent);
		panel.applyEvent({ type: "message_end", message } as unknown as ChatLoopEvent);
		panel.appendReplayBlock(() => ["  stopped: aborted by user"]);
		panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as unknown as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [message] } as unknown as ChatLoopEvent);

		const lines = panel.render(80).map(strip);
		const usageLines = lines.filter((line) => line.includes("turn · in "));
		strictEqual(usageLines.length, 1, `one turn, one usage line: ${JSON.stringify(lines)}`);
		ok(usageLines[0]?.includes("in 14073"), `it carries the run total: ${usageLines[0]}`);

		const noticeIndex = lines.findIndex((line) => line.includes("stopped: aborted by user"));
		ok(noticeIndex >= 0, "the notice is rendered");
		ok(
			lines.indexOf(usageLines[0] ?? "") < noticeIndex,
			`the usage line captions the output above the notice: ${JSON.stringify(lines)}`,
		);
		ok(
			!lines.slice(noticeIndex + 1).some((line) => line.trim() === GLYPH.agent),
			`no bare agent bubble after the notice: ${JSON.stringify(lines.slice(noticeIndex + 1))}`,
		);
	});
});

describe("chat-panel render caching", () => {
	/**
	 * Steps 3 and 4 of the render performance pass replaced a whole-cache clear
	 * with targeted invalidation, and memoized the completed source lines of a
	 * streaming segment. Both are only safe if the rendered bytes never change,
	 * so each case renders the same transcript through the cached path and
	 * through a panel built from scratch and compares them.
	 */
	const settledTurns = (panel: ReturnType<typeof createChatPanel>, count: number): void => {
		for (let i = 0; i < count; i += 1) {
			panel.appendUser(`question ${i}`);
			panel.applyEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: `answer ${i}` }] },
			} as ChatLoopEvent);
			panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
		}
	};

	it("keeps hanging-indent bytes stable when settled turns are frozen", () => {
		const metrics: number[] = [];
		const buildSettledHistory = (panel: ReturnType<typeof createChatPanel>): void => {
			for (let index = 0; index < 24; index += 1) {
				panel.appendUser(`question ${index} wraps across the narrow transcript width for ownership`);
				panel.applyEvent({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: `answer ${index} also wraps across the narrow transcript width` }],
					},
				} as ChatLoopEvent);
				panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
			}
		};

		const cached = createChatPanel({
			now: frozen.now,
			onRenderMetrics: ({ entriesRendered }) => metrics.push(entriesRendered),
		});
		buildSettledHistory(cached);
		cached.render(32);
		cached.applyEvent({
			type: "text_delta",
			contentIndex: 0,
			delta: "live tail that wraps after frozen history",
		} as ChatLoopEvent);
		const cachedRows = cached.render(32);
		ok((metrics.at(-1) ?? Number.POSITIVE_INFINITY) <= 1, JSON.stringify(metrics));

		const fresh = createChatPanel({ now: frozen.now });
		buildSettledHistory(fresh);
		fresh.applyEvent({
			type: "text_delta",
			contentIndex: 0,
			delta: "live tail that wraps after frozen history",
		} as ChatLoopEvent);
		strictEqual(cachedRows.join("\n"), fresh.render(32).join("\n"));
	});

	it("renders identically after a tool event that no longer clears the whole cache", () => {
		const cached = createChatPanel({ now: frozen.now });
		settledTurns(cached, 12);
		cached.render(80);

		cached.applyEvent({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "echo hi" },
		} as ChatLoopEvent);
		cached.applyEvent({
			type: "tool_execution_update",
			toolCallId: "t1",
			partialResult: "partial output",
		} as ChatLoopEvent);
		cached.applyEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			result: "done",
			isError: false,
		} as ChatLoopEvent);
		cached.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);

		const fresh = createChatPanel({ now: frozen.now });
		settledTurns(fresh, 12);
		fresh.applyEvent({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "echo hi" },
		} as ChatLoopEvent);
		fresh.applyEvent({
			type: "tool_execution_update",
			toolCallId: "t1",
			partialResult: "partial output",
		} as ChatLoopEvent);
		fresh.applyEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			result: "done",
			isError: false,
		} as ChatLoopEvent);
		fresh.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);

		strictEqual(cached.render(80).join("\n"), fresh.render(80).join("\n"));
	});

	it("renders a streaming tail identically whether or not completed lines were memoized", () => {
		const streamed = createChatPanel({ now: frozen.now });
		const lines = [
			"First paragraph that is long enough to wrap across more than one row at eighty columns.",
			"Second line here.",
			"",
			"Fourth line with a much longer body so the wrap boundary lands somewhere interesting.",
			"Fifth and final line so far",
		];
		// Stream line by line, rendering between deltas so the wrap cache fills.
		for (let i = 0; i < lines.length; i += 1) {
			const delta = i === 0 ? lines[0] : `\n${lines[i]}`;
			streamed.applyEvent({ type: "text_delta", contentIndex: 0, delta } as ChatLoopEvent);
			streamed.render(80);
		}

		// Same text, delivered in one delta, so nothing was ever memoized.
		const oneShot = createChatPanel({ now: frozen.now });
		oneShot.applyEvent({ type: "text_delta", contentIndex: 0, delta: lines.join("\n") } as ChatLoopEvent);

		strictEqual(streamed.render(80).join("\n"), oneShot.render(80).join("\n"));
	});

	it("re-wraps a memoized streaming tail when the width changes", () => {
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({
			type: "text_delta",
			contentIndex: 0,
			delta: "A line long enough that eighty columns and forty columns wrap it differently.\nsecond",
		} as ChatLoopEvent);
		const wide = panel.render(80).join("\n");
		const narrow = panel.render(40).join("\n");

		const fresh = createChatPanel({ now: frozen.now });
		fresh.applyEvent({
			type: "text_delta",
			contentIndex: 0,
			delta: "A line long enough that eighty columns and forty columns wrap it differently.\nsecond",
		} as ChatLoopEvent);
		strictEqual(narrow, fresh.render(40).join("\n"));
		ok(wide !== narrow, "the two widths must actually wrap differently for this test to mean anything");
	});

	it("serves settled history from the frozen prefix and re-renders only the live tail", () => {
		const rendered: number[] = [];
		const panel = createChatPanel({
			now: frozen.now,
			onRenderMetrics: (metrics) => rendered.push(metrics.entriesRendered),
		});
		settledTurns(panel, 30);
		panel.render(80);

		// A streaming delta dirties the panel; the 60 settled entries before the
		// live one must come from the frozen prefix, not from per-entry renders.
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "streaming tail" } as ChatLoopEvent);
		panel.render(80);
		const dirtyRender = rendered.at(-1);
		ok(
			dirtyRender !== undefined && dirtyRender <= 2,
			`a dirty frame over settled history re-rendered ${dirtyRender} entries; the frozen prefix should hold it at the live tail`,
		);

		// Byte identity against a from-scratch panel with the same transcript.
		const fresh = createChatPanel({ now: frozen.now });
		settledTurns(fresh, 30);
		fresh.applyEvent({ type: "text_delta", contentIndex: 0, delta: "streaming tail" } as ChatLoopEvent);
		strictEqual(panel.render(80).join("\n"), fresh.render(80).join("\n"));
	});

	it("a finished tool moves the expand hint without re-rendering settled history", () => {
		const rendered: number[] = [];
		const panel = createChatPanel({
			now: frozen.now,
			onRenderMetrics: (metrics) => rendered.push(metrics.entriesRendered),
		});
		const toolTurn = (id: string): void => {
			panel.appendUser(`run ${id}`);
			panel.applyEvent({
				type: "tool_execution_start",
				toolCallId: id,
				toolName: "bash",
				args: { command: `echo ${id}` },
			} as ChatLoopEvent);
			panel.applyEvent({ type: "tool_execution_end", toolCallId: id, result: "ok", isError: false } as ChatLoopEvent);
			panel.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
		};
		for (let i = 0; i < 20; i += 1) toolTurn(`tool-${i}`);
		panel.render(80);

		// The next finished tool moves the hint from tool-19 to tool-20. Under a
		// shared hint-bearing key that re-rendered every entry in the transcript.
		toolTurn("tool-20");
		panel.render(80);
		const dirtyRender = rendered.at(-1);
		ok(
			dirtyRender !== undefined && dirtyRender <= 3,
			`the hint move re-rendered ${dirtyRender} entries; only the old and new hint owners should re-render`,
		);

		const fresh = createChatPanel({ now: frozen.now });
		const freshTurn = (id: string): void => {
			fresh.appendUser(`run ${id}`);
			fresh.applyEvent({
				type: "tool_execution_start",
				toolCallId: id,
				toolName: "bash",
				args: { command: `echo ${id}` },
			} as ChatLoopEvent);
			fresh.applyEvent({ type: "tool_execution_end", toolCallId: id, result: "ok", isError: false } as ChatLoopEvent);
			fresh.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
		};
		for (let i = 0; i < 21; i += 1) freshTurn(`tool-${i}`);
		strictEqual(panel.render(80).join("\n"), fresh.render(80).join("\n"));
	});

	it("expanding an old tool re-renders it correctly through the freeze drop", () => {
		const toolBody = Array.from({ length: 8 }, (_, i) => `result row ${i}`).join("\n");
		const buildPanel = (): ReturnType<typeof createChatPanel> => {
			const built = createChatPanel({ now: frozen.now });
			built.appendUser("first");
			built.applyEvent({
				type: "tool_execution_start",
				toolCallId: "old-tool",
				toolName: "grep",
				args: { pattern: "old" },
			} as ChatLoopEvent);
			built.applyEvent({
				type: "tool_execution_end",
				toolCallId: "old-tool",
				result: toolBody,
				isError: false,
			} as ChatLoopEvent);
			built.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
			built.appendUser("second");
			built.applyEvent({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "settled answer" }] },
			} as ChatLoopEvent);
			built.applyEvent({ type: "agent_end", messages: [] } as ChatLoopEvent);
			return built;
		};

		// The freeze forms over the settled transcript, then each toggle mutates a
		// frozen entry; every drop must produce the same bytes a fresh panel does.
		// Live tools auto-expand, so the first toggle collapses and the second
		// re-expands.
		const panel = buildPanel();
		const expanded = panel.render(80).join("\n");
		ok(expanded.includes("result row 7"), "the auto-expanded body must render before any toggle");
		panel.toggleAllToolsExpanded();
		const collapsed = panel.render(80).join("\n");
		ok(!collapsed.includes("result row 7"), "the collapse toggle must drop the frozen expanded body");
		panel.toggleAllToolsExpanded();
		const reExpanded = panel.render(80).join("\n");
		ok(reExpanded.includes("result row 7"), "the re-expand toggle must restore the body through the freeze drop");

		const fresh = buildPanel();
		fresh.toggleAllToolsExpanded();
		strictEqual(collapsed, fresh.render(80).join("\n"));
		fresh.toggleAllToolsExpanded();
		strictEqual(reExpanded, fresh.render(80).join("\n"));
	});
});

describe("chat-panel bash fold policy", () => {
	const runBash = (panel: ReturnType<typeof createChatPanel>, command: string, output: string): void => {
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "bash-1",
			toolName: "bash",
			args: { command },
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "bash-1",
			toolName: "bash",
			result: output,
			isError: false,
		} as ChatLoopEvent);
	};

	it("folds a model bash call by default and keeps other tools expanded", () => {
		const panel = createChatPanel({ now: frozen.now });
		runBash(panel, "npm test", "suite line one\nsuite line two");
		const rendered = strip(panel.render(100).join("\n"));
		ok(rendered.includes("ran `npm test`"), rendered);
		ok(!rendered.includes("suite line two"), `the bash body stays closed until asked for, got: ${rendered}`);
		ok(!rendered.includes("$ npm test"), rendered);

		const other = createChatPanel({ now: frozen.now });
		other.applyEvent({
			type: "tool_execution_start",
			toolCallId: "grep-1",
			toolName: "grep",
			args: { pattern: "needle" },
		} as ChatLoopEvent);
		other.applyEvent({
			type: "tool_execution_end",
			toolCallId: "grep-1",
			toolName: "grep",
			result: "src/a.ts:1: needle",
			isError: false,
		} as ChatLoopEvent);
		ok(strip(other.render(100).join("\n")).includes("src/a.ts:1: needle"), "non-bash tools keep the expanded default");
	});

	it("keeps resource reads folded through the same policy", () => {
		const panel = createChatPanel({ now: frozen.now });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "docs/architecture.md" },
		} as ChatLoopEvent);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
			result: "handbook body text",
			isError: false,
		} as ChatLoopEvent);
		const rendered = strip(panel.render(100).join("\n"));
		ok(rendered.includes("docs"), rendered);
		ok(!rendered.includes("handbook body text"), rendered);
	});

	it("shows a live elapsed on the folded running bash row and settles it in place", () => {
		let clock = 1_000;
		const panel = createChatPanel({ now: () => clock });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "bash-live",
			toolName: "bash",
			args: { command: "sleep 30" },
		} as ChatLoopEvent);
		clock = 3_400;
		const running = strip(panel.render(100).join("\n"));
		ok(running.includes("running `sleep 30`"), running);
		ok(running.includes("2.4s"), running);
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "bash-live",
			toolName: "bash",
			result: "done",
			isError: false,
		} as ChatLoopEvent);
		const settled = strip(panel.render(100).join("\n"));
		ok(settled.includes("ran `sleep 30`"), settled);
		ok(settled.includes("exit 0"), settled);
		ok(!settled.includes("running"), settled);
	});

	it("expands and re-collapses the folded bash row on one operator action", () => {
		const panel = createChatPanel({ now: frozen.now });
		runBash(panel, "npm test", "suite line one\nsuite line two");
		ok(panel.toggleLastToolExpanded());
		ok(strip(panel.render(100).join("\n")).includes("suite line two"), "the toggle opens the bounded body");
		ok(panel.toggleLastToolExpanded());
		ok(!strip(panel.render(100).join("\n")).includes("suite line two"), "the same key folds it again");
	});

	it("respects output verbosity over the fold policy", () => {
		let verbosity: "default" | "verbose" | "minimal" = "verbose";
		const panel = createChatPanel({ now: frozen.now, getOutputVerbosity: () => verbosity });
		runBash(panel, "npm test", "suite line one\nsuite line two");
		ok(strip(panel.render(100).join("\n")).includes("suite line two"), "/output verbose expands bash");
		verbosity = "minimal";
		ok(!strip(panel.render(100).join("\n")).includes("suite line two"), "/output minimal folds it");
	});

	it("renders the folded bash row inside 40 and 120 columns", () => {
		const panel = createChatPanel({ now: frozen.now });
		runBash(panel, "npm run typecheck -- --pretty false", "type error in src/a.ts");
		for (const width of [40, 120]) {
			for (const line of panel.render(width)) {
				ok(visibleWidth(line) <= width, `line overflows ${width}: ${JSON.stringify(strip(line))}`);
			}
		}
	});

	it("includes a fold-owning replay block in the tool expand and collapse keys", () => {
		const panel = createChatPanel({ now: frozen.now });
		let folded = true;
		panel.appendReplayBlock(
			(_width) => (folded ? ["ran `pwd` ✓"] : ["ran `pwd` ✓", "/home/operator"]),
			() => false,
			{
				isFolded: () => folded,
				setFolded: (next: boolean) => {
					folded = next;
				},
			},
		);
		ok(!strip(panel.render(100).join("\n")).includes("/home/operator"));
		ok(panel.toggleLastToolExpanded(), "Ctrl+O owns the newest local bash block");
		strictEqual(folded, false);
		ok(strip(panel.render(100).join("\n")).includes("/home/operator"), "the panel re-renders the opened block");
		panel.collapseAllTools();
		strictEqual(folded, true);
		ok(!strip(panel.render(100).join("\n")).includes("/home/operator"));
		ok(panel.toggleAllToolsExpanded(), "expand-all reaches the block too");
		strictEqual(folded, false);
	});
});
