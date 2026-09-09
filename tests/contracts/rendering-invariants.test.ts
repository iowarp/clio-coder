import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { OutputStyle } from "../../src/core/defaults.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { inspectRunReceiptTrustStatus } from "../../src/domains/evidence/trust-status.js";
import {
	createWorkerProgressFold,
	WORKER_ACTION_TRAIL_LIMIT,
	WORKER_TOOL_NAME_LIMIT,
} from "../../src/domains/observability/worker-progress.js";
import type { WorkerRunEntry } from "../../src/domains/session/index.js";
import {
	ScrollView,
	stripTerminalSequences,
	type Terminal,
	Text,
	TuiAltScreen,
	VStack,
	visibleWidth,
} from "../../src/engine/tui.js";
import { type ChatPanel, createChatPanel } from "../../src/interactive/chat-panel.js";
import { buildLayout } from "../../src/interactive/layout.js";
import { showClioOverlayFrame } from "../../src/interactive/overlay-frame.js";
import { openAskUserOverlay } from "../../src/interactive/overlays/ask-user.js";
import { renderWorkerEntryLines } from "../../src/interactive/renderers/worker-entry.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";
import { workerEntriesFromRunEntries } from "../../src/interactive/worker-replay.js";
import {
	createWorkerStream,
	type WorkerEntryState,
	type WorkerReceiptFacts,
} from "../../src/interactive/worker-stream.js";

import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

function plainRender(panel: ChatPanel, width = 120): string {
	return panel.render(width).map(stripTerminalSequences).join("\n");
}

function startTool(panel: ChatPanel, id = "tool-1"): void {
	panel.applyEvent({
		type: "tool_execution_start",
		toolCallId: id,
		toolName: "bash",
		args: { command: "printf tool-command" },
	} as never);
}

function updateTool(panel: ChatPanel, text: string, id = "tool-1"): void {
	panel.applyEvent({ type: "tool_execution_update", toolCallId: id, partialResult: text } as never);
}

function endTool(panel: ChatPanel, text: string, id = "tool-1"): void {
	panel.applyEvent({
		type: "tool_execution_end",
		toolCallId: id,
		toolName: "bash",
		result: text,
		isError: false,
		durationMs: 25,
	} as never);
}

describe("Clio rendering invariants", () => {
	it("keeps reasoning, prose, and tools in stream order", () => {
		const panel = createChatPanel({ now: () => 1_000 });
		panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
		panel.applyEvent({ type: "thinking_delta", contentIndex: 0, delta: "reason one", partialThinking: "reason one" });
		panel.applyEvent({ type: "text_delta", contentIndex: 1, delta: "before tool", partialText: "before tool" });
		panel.applyEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "reason one" },
					{ type: "text", text: "before tool" },
				],
			},
		} as never);
		startTool(panel);
		endTool(panel, "tool result");
		panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
		panel.applyEvent({ type: "thinking_delta", contentIndex: 0, delta: "reason two", partialThinking: "reason two" });
		panel.applyEvent({ type: "text_delta", contentIndex: 1, delta: "after tool", partialText: "after tool" });
		panel.applyEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "reason two" },
					{ type: "text", text: "after tool" },
				],
			},
		} as never);
		panel.applyEvent({ type: "agent_end", messages: [] } as never);

		const rendered = plainRender(panel);
		const firstReasoning = rendered.indexOf("reason one");
		const before = rendered.indexOf("before tool");
		const tool = rendered.indexOf("tool-command");
		const secondReasoning = rendered.indexOf("reason two", firstReasoning + 1);
		const after = rendered.indexOf("after tool");
		ok(firstReasoning >= 0, "first reasoning marker should render");
		ok(firstReasoning < before && before < tool && tool < secondReasoning && secondReasoning < after, rendered);
	});

	it("hoists a skill-suggestion line the model wrote after its narration", () => {
		const panel = createChatPanel({ now: () => 1_000 });
		panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
		const partial = "I checked the tests first.\nSuggested skill: /sk";
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: partial, partialText: partial });
		// A half-streamed line is ordinary prose until it is whole.
		const streaming = plainRender(panel);
		ok(streaming.indexOf("I checked the tests first.") < streaming.indexOf("Suggested skill: /sk"), streaming);
		const full = "I checked the tests first.\nSuggested skill: /skill tdd\nNow the failing test.";
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: full.slice(partial.length), partialText: full });
		panel.applyEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: full }] },
		} as never);
		panel.applyEvent({ type: "agent_end", messages: [] } as never);
		const rendered = plainRender(panel);
		const suggestion = rendered.indexOf("Suggested skill: /skill tdd");
		const narration = rendered.indexOf("I checked the tests first.");
		const rest = rendered.indexOf("Now the failing test.");
		ok(suggestion >= 0 && narration >= 0 && rest >= 0, rendered);
		ok(suggestion < narration && narration < rest, rendered);
		strictEqual(rendered.split("Suggested skill:").length, 2, rendered);
	});

	it("changes the preset while a tool remains live", () => {
		let style: OutputStyle = "standard";
		const panel = createChatPanel({ getOutputStyle: () => style, now: () => 1_000 });
		panel.applyEvent({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "private reasoning body",
			partialThinking: "private reasoning body",
		});
		startTool(panel);

		style = "detailed";
		const expanded = plainRender(panel);
		match(expanded, /private reasoning body/u);
		match(expanded, /tool-command/u);

		style = "compact";
		const folded = plainRender(panel);
		doesNotMatch(folded, /private reasoning body/u);
		match(folded, /Thinking · \/view/u);
		match(folded, /tool-command/u);
	});

	it("replaces cumulative partials and re-expands at the latest state", () => {
		let style: OutputStyle = "detailed";
		const panel = createChatPanel({ getOutputStyle: () => style, now: () => 1_000 });
		startTool(panel);
		updateTool(panel, "obsolete snapshot");
		match(plainRender(panel), /obsolete snapshot/u);

		updateTool(panel, "replacement snapshot");
		const replaced = plainRender(panel);
		doesNotMatch(replaced, /obsolete snapshot/u);
		match(replaced, /replacement snapshot/u);

		style = "compact";
		updateTool(panel, "latest while folded");
		const folded = plainRender(panel);
		doesNotMatch(folded, /replacement snapshot|latest while folded/u);

		style = "detailed";
		const reExpanded = plainRender(panel);
		doesNotMatch(reExpanded, /replacement snapshot/u);
		match(reExpanded, /latest while folded/u);
	});

	it("keeps captured live output across preset changes", () => {
		let style: OutputStyle = "detailed";
		const panel = createChatPanel({ getOutputStyle: () => style, now: () => 1_000 });
		startTool(panel);
		updateTool(panel, "visible before pause");

		style = "standard";
		updateTool(panel, "accepted while paused");
		const paused = plainRender(panel);
		doesNotMatch(paused, /visible before pause|accepted while paused/u);

		style = "detailed";
		const resumed = plainRender(panel);
		match(resumed, /accepted while paused/u);
		doesNotMatch(resumed, /visible before pause/u);
	});

	it("clears partial state at terminal settlement and ignores late updates", () => {
		const panel = createChatPanel({ getOutputStyle: () => "detailed", now: () => 1_000 });
		startTool(panel);
		updateTool(panel, "partial-only text");
		endTool(panel, "sealed final text");
		updateTool(panel, "late partial text");

		const rendered = plainRender(panel);
		match(rendered, /sealed final text/u);
		doesNotMatch(rendered, /partial-only text|late partial text|live output/u);
	});
});

describe("worker rendering invariants", () => {
	it("discards worker reasoning content", () => {
		const progress = createWorkerProgressFold();
		strictEqual(
			progress.observe({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", delta: "worker chain of thought" },
			}),
			true,
		);

		const thinking = progress.snapshot();
		strictEqual(thinking.phase, "thinking");
		strictEqual(thinking.tailText, "");
		strictEqual(progress.durableText(), "");
		doesNotMatch(JSON.stringify(thinking), /worker chain of thought/u);
	});

	it("keeps only redacted and bounded worker tool activity", () => {
		const progress = createWorkerProgressFold();
		for (let index = 0; index < WORKER_TOOL_NAME_LIMIT + 4; index += 1) {
			const tool = `tool-${index}`;
			const toolCallId = `call-${index}`;
			progress.observe({
				type: "clio_coder_tool_start",
				payload: {
					tool,
					toolCallId,
					action: { verb: "read", object: `redacted-target-${index}` },
					args: { credential: `raw-secret-${index}` },
				},
			});
			progress.observe({ type: "clio_coder_tool_finish", payload: { tool, toolCallId } });
		}

		const snapshot = progress.snapshot();
		strictEqual(snapshot.toolNames.length, WORKER_TOOL_NAME_LIMIT);
		strictEqual(snapshot.recentActions.length, WORKER_ACTION_TRAIL_LIMIT);
		deepStrictEqual(
			snapshot.recentActions.map((action) => action.tool),
			["tool-11", "tool-10", "tool-9", "tool-8"],
		);
		match(JSON.stringify(snapshot), /redacted-target-11/u);
		doesNotMatch(JSON.stringify(snapshot), /raw-secret/u);
	});

	it("fits execution and validation failures at narrow widths", () => {
		const envelope = fixtureEnvelope("width-run");
		const draft = fixtureReceiptDraft(envelope);
		draft.quality.resultContract = {
			sourceId: "agent-result-contract:mutation-report:fixture",
			validatorDigest: "a".repeat(64),
			conformance: "pass",
			quality: "fail",
		};
		const receipt = withReceiptIntegrity(draft, envelope);
		const entry: WorkerEntryState = {
			assignmentId: envelope.id,
			runId: envelope.id,
			origin: "user",
			agentId: "coder",
			runtime: { kind: "clio", targetId: "codex", wireModelId: "gpt-5.6-luna" },
			text: "",
			droppedLines: 0,
			tools: [],
			attempts: [],
			pending: false,
			receipt: { outcome: "succeeded", durationMs: 21000, trust: inspectRunReceiptTrustStatus(receipt, envelope).status },
		};
		for (const width of [24, 44, 76]) {
			const lines = renderWorkerEntryLines(entry, width, {});
			ok(
				lines.every((line) => visibleWidth(line) <= width),
				`width ${width}: ${lines.map(visibleWidth)}`,
			);
			const plain = lines.map(stripTerminalSequences).join(" ").replace(/│/gu, " ").replace(/\s+/gu, " ");
			match(plain, /execution ok/u);
			match(plain, /quality: validation failed/u);
			doesNotMatch(plain, /Ctrl\+O/u);
		}
	});

	it("renders the same sealed outcome facts live and on replay", () => {
		const facts: WorkerReceiptFacts = {
			outcome: "succeeded",
			exitCode: 0,
			tokenCount: 42,
			durationMs: 900,
			toolCalls: 3,
			contract: "pass",
			text: "sealed worker answer",
		};
		const readReceipt = (): WorkerReceiptFacts => facts;
		const stream = createWorkerStream({ readReceipt });
		const started = stream.started({
			runId: "run-1",
			assignmentId: "assignment-1",
			attempt: 0,
			requestOrigin: "user",
			agentId: "scout",
			targetId: "local",
			wireModelId: "worker-model",
			runtimeId: "openai",
			runtimeKind: "http",
			pid: 123,
		} as never);
		if (started === null) throw new Error("worker did not start");
		const completed = stream.completed({
			runId: "run-1",
			outcome: "succeeded",
			outcomeCode: null,
			outcomeDetail: null,
			tokenCount: 1,
			durationMs: 1,
			exitCode: 0,
			toolActivity: null,
		} as never);
		if (completed === null) throw new Error("worker did not settle");

		const entry: WorkerRunEntry = {
			kind: "workerRun",
			turnId: "turn-1",
			parentTurnId: null,
			timestamp: "2026-09-01T00:00:00.000Z",
			assignmentId: "assignment-1",
			runId: "run-1",
			origin: "user",
			agentId: "scout",
			runtime: { kind: "clio", targetId: "local", wireModelId: "worker-model" },
		};
		const replayed = workerEntriesFromRunEntries([entry], readReceipt).get("assignment-1");
		if (replayed === undefined) throw new Error("worker did not replay");

		deepStrictEqual(completed.entry.receipt, replayed.receipt);
		strictEqual(completed.entry.text, replayed.text);
		strictEqual(completed.entry.pending, false);
		strictEqual(replayed.pending, false);
		deepStrictEqual(renderWorkerEntryLines(completed.entry, 120, {}), renderWorkerEntryLines(replayed, 120, {}));
	});
});

// Exercise the public renderer and input path without a PTY or private engine fields.
class RenderingTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	writes: string[] = [];
	input: (data: string) => void = () => {};
	start(onInput: (data: string) => void): void {
		this.input = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

describe("Pi TUI compatibility", () => {
	it("keeps framed bounds live through visibility, resize, and removal", () => {
		const terminal = new RenderingTerminal();
		const tui = new TuiAltScreen(terminal);
		let visible = true;
		const handle = showClioOverlayFrame(tui, new Text("body", 0, 0), {
			title: "Frame",
			markerId: "test",
			width: 40,
			visible: () => visible,
		});
		strictEqual(handle.getBounds(), undefined);
		tui.start();
		try {
			tui.renderNow(true);
			const bounds = handle.getBounds();
			ok(bounds);
			strictEqual(bounds.width, 80, "frame owns the full row around the box");
			handle.setHidden(true);
			strictEqual(handle.getBounds(), undefined);
			handle.setHidden(false);
			terminal.columns = 60;
			tui.renderNow(true);
			strictEqual(handle.getBounds()?.width, 60);
			visible = false;
			strictEqual(handle.getBounds(), undefined);
			visible = true;
			tui.renderNow(true);
			ok(handle.getBounds());
			handle.hide();
			strictEqual(handle.getBounds(), undefined);
		} finally {
			tui.stop();
		}
	});

	it("reports the ask-user frame while shown and no bounds after close", async () => {
		const terminal = new RenderingTerminal();
		const tui = new TuiAltScreen(terminal);
		const session = openAskUserOverlay(tui, { onCancel() {} });
		tui.start();
		try {
			tui.renderNow(true);
			const initial = session.getBounds();
			ok(initial);
			const answer = session.ask([{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }]);
			deepStrictEqual(session.getBounds(), initial, "one frame serves every round; nothing is remounted");
			tui.renderNow(true);
			const compact = session.getBounds();
			ok(compact);
			strictEqual(compact.width, terminal.columns - 4);
			session.setHidden(true);
			strictEqual(session.getBounds(), undefined);
			session.setHidden(false);
			tui.renderNow(true);
			deepStrictEqual(session.getBounds(), compact);
			session.close();
			strictEqual(session.getBounds(), undefined);
			await answer;
		} finally {
			session.close();
			tui.stop();
		}
	});

	it("preserves themed scrollbars, wheel scrolling, follow-end, and the fixed dock", () => {
		const terminal = new RenderingTerminal();
		const tui = new TuiAltScreen(terminal);
		const root = buildLayout(
			{
				banner: new Text("banner", 0, 0),
				chat: new Text(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"), 0, 0),
				editor: new Text("editor", 0, 0),
				footer: new Text("footer", 0, 0),
			},
			{ mode: "fullscreen", fullscreenScrollbar: "always" },
		);
		ok(root instanceof VStack);
		const scroll = root.children[0];
		ok(scroll instanceof ScrollView);
		tui.setLayoutRoot(root);
		tui.start();
		try {
			tui.renderNow(true);
			const end = scroll.scrollTop;
			ok(end > 0);
			strictEqual(scroll.isFollowingEnd, true);
			const output = terminal.writes.join("");
			ok(output.includes(clioTheme().fg("frameStrong", GLYPH.barFull)));
			ok(output.includes(clioTheme().fg("frame", "│")));
			match(output, /editor/u);
			match(output, /footer/u);
			terminal.input("\x1b[<64;2;2M");
			strictEqual(scroll.scrollTop, end - 1);
			strictEqual(scroll.isFollowingEnd, false);
			terminal.input("\x1b[<72;2;2M");
			strictEqual(scroll.scrollTop, end - 6, "Alt-wheel uses Pi's five-line step");
			scroll.scrollToEnd();
			strictEqual(scroll.isFollowingEnd, true);
			strictEqual(scroll.scrollTop, end);
		} finally {
			tui.stop();
		}
	});
});
