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
import { buildContextLedger } from "../../src/domains/session/context-ledger.js";
import type { WorkerRunEntry } from "../../src/domains/session/index.js";
import {
	type Component,
	InstrumentedTuiAltScreen,
	ScrollView,
	stripTerminalSequences,
	type Terminal,
	Text,
	type TUI,
	TuiAltScreen,
	VStack,
	visibleWidth,
} from "../../src/engine/tui.js";
import { type ChatPanel, createChatPanel } from "../../src/interactive/chat-panel.js";
import { openContextOverlay } from "../../src/interactive/context-overlay.js";
import { buildLayout } from "../../src/interactive/layout.js";
import { showClioOverlayFrame } from "../../src/interactive/overlay-frame.js";
import { openAskUserOverlay } from "../../src/interactive/overlays/ask-user.js";
import {
	renderToolExecution,
	renderToolPreview,
	renderToolSubline,
} from "../../src/interactive/renderers/tool-execution.js";
import { renderWorkerEntryLines } from "../../src/interactive/renderers/worker-entry.js";
import { clioTheme, formatContextPercent, GLYPH } from "../../src/interactive/theme/index.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";
import { workerEntriesFromRunEntries, workerRunEntryFields } from "../../src/interactive/worker-replay.js";
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

	it("renders one physical row per line for a multi-line bash command and cursor-moving output", () => {
		// pi-tui's diff renderer treats each array element as one terminal row. A
		// raw newline or cursor movement inside one shifts every row below it, and
		// the composer border kept residue from a bash row after a tool batch.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: the control bytes are the subject
		const control = /[\x00-\x08\x0a-\x1f\x7f]/u;
		for (const style of ["compact", "standard", "detailed"] as const) {
			const panel = createChatPanel({ getOutputStyle: () => style, now: () => 1_000 });
			panel.applyEvent({
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "bash",
				args: { command: "cd /var/tmp &&\nls -la\r\n\x1b[2Aecho done" },
			} as never);
			const assertRows = (phase: string): void => {
				for (const line of panel.render(80)) {
					// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR is the one sequence a row may carry
					const unstyled = line.replace(/\x1b\[[0-9;]*m/gu, "").replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/gu, "");
					doesNotMatch(unstyled, control, `${style} ${phase}: ${JSON.stringify(line)}`);
				}
			};
			assertRows("live");
			updateTool(panel, "Progress 1\x1b[1A\x1b[2K\rProgress 2\b\b");
			assertRows("partial");
			endTool(panel, "Progress 1\x1b[1A\x1b[2K\rProgress 2\b\b\x07");
			assertRows("settled");
		}
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
	it("keeps context legend percentages on their row through frame resizing and refresh", () => {
		let frame!: Component;
		let onEvent!: (event: { type: string }) => void;
		let messageTokens = 1000;
		const ledger = () =>
			buildContextLedger({
				provider: "fixture",
				model: "fixture",
				contextWindow: 32768,
				systemPromptTokens: 1200,
				toolSchemaTokens: 800,
				messageTokens,
				compactionThreshold: 0.9,
				compactionAuto: true,
			});
		const tui = {
			showOverlay: (component: Component) => {
				frame = component;
				return { hide() {} };
			},
			requestRender() {},
		} as unknown as TUI;
		const handle = openContextOverlay(tui, ledger, {
			chat: {
				isStreaming: () => false,
				onEvent: (handler) => {
					onEvent = handler;
					return () => {};
				},
			},
		});
		try {
			for (const width of [86, 86, 60, 40, 86]) {
				const rows = frame.render(width);
				ok(rows.every((row) => visibleWidth(row) <= width));
				const plain = rows.map(stripTerminalSequences);
				for (const group of ledger().meter) {
					const row = plain.find((line) => line.includes(group.label.slice(0, 6)));
					ok(row?.includes(formatContextPercent(group.percent)), `${width}: ${group.label}\n${plain.join("\n")}`);
				}
				messageTokens += 1000;
				onEvent({ type: "message_end" });
			}
		} finally {
			handle.hide();
		}
	});

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

	it("keeps the interview full-screen across background updates and restores mouse tracking on close", async () => {
		const terminal = new RenderingTerminal();
		const tui = new InstrumentedTuiAltScreen(terminal, {
			beginFrame() {},
			endFrame() {},
			beginPhase() {},
			endPhase() {},
		});
		tui.start();
		const session = openAskUserOverlay(tui, { onCancel() {} });
		ok(terminal.writes.at(-1)?.includes("?1006l"), "native text selection is enabled");
		try {
			tui.renderNow(true);
			const initial = session.getBounds();
			ok(initial);
			const answer = session.ask([{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }]);
			deepStrictEqual(session.getBounds(), initial, "one frame serves every round; nothing is remounted");
			tui.renderNow(true);
			const compact = session.getBounds();
			ok(compact);
			strictEqual(compact.width, terminal.columns);
			strictEqual(compact.height, terminal.rows);
			strictEqual(compact.row, 0);
			tui.addChild(new Text("background agent update", 0, 0));
			tui.renderNow();
			deepStrictEqual(session.getBounds(), compact, "background work cannot move the interview");
			terminal.columns = 120;
			tui.renderNow(true);
			strictEqual(session.getBounds()?.width, 120);
			terminal.columns = compact.width;
			tui.renderNow(true);
			session.setHidden(true);
			ok(terminal.writes.at(-1)?.includes("?1006h"));
			strictEqual(session.getBounds(), undefined);
			session.setHidden(false);
			tui.renderNow(true);
			deepStrictEqual(session.getBounds(), compact);
			session.close();
			ok(terminal.writes.at(-1)?.includes("?1006h"), "mouse tracking restored");
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

it("renders a distinct compact helper card and preserves its identity on replay", () => {
	const stream = createWorkerStream({ readReceipt: () => null });
	const started = stream.started({
		runId: "helper-run",
		assignmentId: "helper-task",
		attempt: 0,
		requestOrigin: "agent",
		agentAudience: "shadow",
		agentId: "scout",
		task: "Explore the source architecture",
		runtimeKind: "http",
		runtimeId: "openai-compat",
		targetId: "blade",
		wireModelId: "model",
		pid: null,
	});
	ok(started);
	const state = started.entry;
	state.startedAtMs = 1000;
	match(stripTerminalSequences(renderWorkerEntryLines(state, 100, { nowMs: 7000 }).join("\n")), /6.0s/);
	match(stripTerminalSequences(renderWorkerEntryLines(state, 100, { nowMs: 13000 }).join("\n")), /12s/);
	const lines = renderWorkerEntryLines(state, 100, { nowMs: 1000 });
	strictEqual(lines.length, 4);
	const plain = stripTerminalSequences(lines.join("\n"));
	match(plain, /Clio-Coder → Scout.*internal agent.*working/);
	match(plain, /Explore the source architecture/);
	match(plain, /Gathering findings for Clio/);
	ok(lines.every((line) => visibleWidth(line) <= 100));
	for (const style of ["compact", "standard", "detailed"] as const) {
		for (const width of [32, 80, 120]) {
			const rendered = renderWorkerEntryLines(state, width, { detail: transcriptDetail(style), terminalRows: 24 });
			ok(rendered.every((line) => visibleWidth(line) <= width));
			if (style === "compact") match(stripTerminalSequences(rendered.join("\n")), /Explore the source/);
		}
	}
	const call = renderToolSubline(
		{
			toolName: "dispatch",
			toolCallId: "helper-call",
			args: { agent: "scout", task: "Explore the source architecture" },
		},
		100,
	);
	match(stripTerminalSequences(call.join("\n")), /dispatching scout/);
	doesNotMatch(stripTerminalSequences(call.join("\n")), /tool action/);
	const fields = workerRunEntryFields(state);
	const entry: WorkerRunEntry = {
		...fields,
		parentTurnId: null,
		turnId: "helper-entry",
		timestamp: new Date().toISOString(),
	};
	const replayed = workerEntriesFromRunEntries([entry], () => ({
		outcome: "succeeded",
		contract: "pass",
		text: "full findings",
	})).get("helper-task");
	ok(replayed);
	const done = stripTerminalSequences(renderWorkerEntryLines(replayed, 100, {}).join("\n"));
	match(done, /internal agent.*completed/);
	match(done, /Explore the source architecture/);
	match(done, /Findings returned to Clio/);
	doesNotMatch(done, /full findings/);
	const expanded = stripTerminalSequences(renderWorkerEntryLines(replayed, 100, { unbounded: true }).join("\n"));
	match(expanded, /full findings/);
	match(expanded, /internal agent/);
	const detailed = stripTerminalSequences(
		renderWorkerEntryLines(replayed, 100, { detail: transcriptDetail("detailed") }).join("\n"),
	);
	match(detailed, /full findings/);

	replayed.receipt = { outcome: "failed", failureMessage: "Invalid helper result" };
	const failed = stripTerminalSequences(renderWorkerEntryLines(replayed, 100, {}).join("\n"));
	match(failed, /internal agent.*failed/);
	match(failed, /Invalid helper result/);
});

it("preserves complete invocation arguments in inspection and meaningful intent in every style", () => {
	const command = `printf '%s\\n' ${"long-command-argument ".repeat(30)}FINAL_ARGUMENT`;
	const call = {
		toolName: "bash",
		toolCallId: "transparent",
		args: { command, cwd: "/tmp/project", api_key: "do-not-display-me" },
		result: "done",
		isError: false,
	};
	const full = stripTerminalSequences(renderToolExecution(call, 72).join("\n"));
	match(full, /FINAL_ARGUMENT/);
	match(full, /cwd.*project/);
	doesNotMatch(full, /do-not-display-me/);
	for (const style of ["compact", "standard", "detailed"] as const) {
		const rows = renderToolPreview(call, 72, transcriptDetail(style));
		const text = stripTerminalSequences(rows.join("\n"));
		match(text, /command/);
		match(text, /long-command-argument/);
		if (style !== "detailed") match(text, /\/view/);
		doesNotMatch(text, /do-not-display-me/);
		ok(rows.every((row) => visibleWidth(row) <= 72));
	}
	const nested = {
		toolName: "gateway",
		toolCallId: "nested",
		args: { payload: { prompt: `start\n${"line\n".repeat(30)}END_OF_PROMPT` } },
		result: "ok",
		isError: false,
	};
	match(stripTerminalSequences(renderToolExecution(nested, 72).join("\n")), /END_OF_PROMPT/);
});

it("keeps helper context occupancy separate from cumulative tokens and counts observed tool invocations", () => {
	const fold = createWorkerProgressFold();
	strictEqual(fold.snapshot().processedTokens, undefined);
	strictEqual(fold.snapshot().contextTokens, undefined);
	for (const input of [100, 200])
		fold.observe({
			type: "message_end",
			message: { role: "assistant", usage: { input, output: 20, cacheRead: 50, cacheWrite: 10 } },
		});
	fold.observe({ type: "clio_coder_tool_start", payload: { tool: "read", toolCallId: "one" } });
	fold.observe({ type: "clio_coder_tool_start", payload: { tool: "read", toolCallId: "one" } });
	fold.observe({ type: "clio_coder_tool_finish", payload: { tool: "read", toolCallId: "one" } });
	strictEqual(fold.snapshot().processedTokens, 460);
	strictEqual(fold.snapshot().contextTokens, 280);
	strictEqual(fold.snapshot().toolCalls, 1);
	fold.restart();
	strictEqual(fold.snapshot().processedTokens, undefined);
	strictEqual(fold.snapshot().toolCalls, undefined);
});
