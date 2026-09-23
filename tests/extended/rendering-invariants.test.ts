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
	TuiMainScreen,
	VStack,
	visibleWidth,
} from "../../src/engine/tui.js";
import { type ChatPanel, createChatPanel } from "../../src/interactive/chat-panel.js";
import { createCoalescingChatRenderer } from "../../src/interactive/chat-renderer.js";
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
import { createStreamPacer, type StreamPacerSlice } from "../../src/interactive/stream-pacer.js";
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

	it("advances a running tool's and a pending worker's elapsed on the panel's own clock", () => {
		let clock = 10_000;
		const panel = createChatPanel({ now: () => clock });
		panel.applyEvent({ type: "agent_start" } as never);
		startTool(panel);
		panel.applyWorkerState({
			assignmentId: "helper-1",
			runId: "h1lp3r",
			origin: "agent",
			helper: true,
			agentId: "context-scout",
			task: "Summarize prior probe benchmarks.",
			runtime: { kind: "clio", targetId: "dynamo", wireModelId: "qwen3.8-27b" },
			text: "",
			droppedLines: 0,
			tools: [],
			attempts: [{ runId: "h1lp3r", targetLabel: "dynamo/qwen3.8-27b" }],
			pending: true,
			startedAtMs: clock,
		});
		const before = plainRender(panel);
		clock += 2_300;
		// No invalidate between the frames: only the clock moved.
		const after = plainRender(panel);
		match(before, /running · 0ms/u);
		match(after, /running · 2\.3s/u);
		strictEqual(after.match(/2\.3s/gu)?.length, 2, "the worker's elapsed advances with the tool's");
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

const STREAMED_ANSWER = [
	"## Retry design",
	"",
	"The loop owns **how many** attempts and **how long** to wait.",
	"",
	...Array.from({ length: 12 }, (_, i) => `- step ${i} uses \`backoff(${i})\``),
	"",
	"```ts",
	...Array.from({ length: 12 }, (_, i) => `const delay${i} = backoff(${i});`),
	"```",
	"",
	"Tests drive the clock directly.",
].join("\n");

function streamAnswer(panel: ChatPanel, text: string): void {
	panel.applyEvent({ type: "agent_start" } as never);
	panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	for (let at = 0; at < text.length; at += 4) {
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: text.slice(at, at + 4) } as never);
	}
}

function settleAnswer(panel: ChatPanel, text: string): void {
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 900, output: 120, cacheRead: 0, cacheWrite: 0 },
	};
	panel.applyEvent({ type: "message_end", message } as never);
	panel.applyEvent({ type: "agent_end", messages: [message] } as never);
}

describe("streamed answers settle in place", () => {
	it("keeps every streamed row byte-stable when the answer finalizes", () => {
		const panel = createChatPanel({ now: () => 0 });
		panel.appendUser("Explain the retry design.");
		streamAnswer(panel, STREAMED_ANSWER);
		const streamed = panel.render(80);
		settleAnswer(panel, STREAMED_ANSWER);
		const settled = panel.render(80);
		// Only the receipt is added below; rows the operator already saw never change.
		ok(settled.length > streamed.length, "the settled turn gains its receipt");
		deepStrictEqual(settled.slice(0, streamed.length), streamed);
	});

	it("streams against one settled prefix array and keeps the regular root equal to the frame", () => {
		const panel = createChatPanel({ now: () => 0 });
		for (let turn = 0; turn < 3; turn += 1) {
			panel.appendUser(`Question ${turn}.`);
			streamAnswer(panel, `Answer ${turn} with **bold** text.`);
			settleAnswer(panel, `Answer ${turn} with **bold** text.`);
		}
		const banner = new Text("banner", 0, 0);
		const editor = new Text("editor", 0, 0);
		const footer = new Text("footer", 0, 0);
		const root = buildLayout({ banner, chat: panel, editor, footer });
		const expected = (): string[] => [
			...banner.render(80),
			"",
			...panel.render(80),
			"",
			...editor.render(80),
			...footer.render(80),
		];
		deepStrictEqual(root.render(80), expected());
		panel.appendUser("Explain the retry design.");
		streamAnswer(panel, STREAMED_ANSWER.slice(0, 40));
		// This frame freezes the new prompt row; from here on only the answer streams.
		deepStrictEqual(root.render(80), expected());
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: " " } as never);
		const first = panel.renderRegions(80);
		ok(first.prefix.length > 0, "settled turns form the frozen prefix");
		ok(first.tail.length > 0, "the streaming answer renders after the prefix");
		deepStrictEqual(root.render(80), expected());
		for (let at = 40; at < 200; at += 8) {
			panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: STREAMED_ANSWER.slice(at, at + 8) } as never);
			const frame = panel.renderRegions(80);
			// The settled rows are the same array every streamed frame; only the tail is new.
			strictEqual(frame.prefix, first.prefix);
			deepStrictEqual(root.render(80), expected());
		}
		// A taller banner moves the prefix down a row: the root rewrites it rather than trusting stale rows.
		banner.setText("banner\nsecond banner row");
		banner.invalidate();
		deepStrictEqual(root.render(80), expected());
		banner.setText("banner");
		banner.invalidate();
		deepStrictEqual(root.render(80), expected());
		settleAnswer(panel, STREAMED_ANSWER.slice(0, 200));
		deepStrictEqual(root.render(80), expected());
		// The frame after a settle serves the grown freeze, which now covers the answer.
		panel.appendUser("Next question.");
		const settled = panel.renderRegions(80);
		ok(settled.prefix.length > first.prefix.length, "a settled entry extends the freeze");
		deepStrictEqual([...settled.prefix, ...settled.tail], panel.render(80));
		deepStrictEqual(root.render(80), expected());
	});

	it("renders settled entries ahead in the other styles so a first Alt+O renders nothing", () => {
		let style: OutputStyle = "standard";
		let rendered = 0;
		const steps: Array<() => boolean> = [];
		const panel = createChatPanel({
			now: () => 0,
			getOutputStyle: () => style,
			onRenderMetrics: (metrics) => {
				rendered = metrics.entriesRendered;
			},
			scheduleIdle: (step) => steps.push(step),
		});
		const idle = () => {
			while (steps.length > 0) {
				const step = steps.shift();
				if (step?.()) steps.push(step);
			}
		};
		for (let turn = 0; turn < 6; turn += 1) {
			panel.appendUser(`Question ${turn}.`);
			streamAnswer(panel, `Answer ${turn}.`);
			settleAnswer(panel, `Answer ${turn}.`);
		}
		panel.render(80);
		// A streaming answer holds the job at its entry instead of being skipped.
		panel.appendUser("Still streaming.");
		streamAnswer(panel, "Partial");
		panel.render(80);
		idle();
		settleAnswer(panel, "Partial answer.");
		panel.render(80);
		idle();
		for (const next of ["detailed", "compact"] as const) {
			style = next;
			panel.render(80);
			strictEqual(rendered, 0, `the first switch to ${next} renders every entry from the cache`);
		}
	});

	it("caches a settled replay block per render key and re-renders a live one until it settles", () => {
		let style: OutputStyle = "standard";
		let clock = 0;
		const panel = createChatPanel({ now: () => clock, getOutputStyle: () => style });
		let settledCalls = 0;
		panel.appendReplayBlock((width) => {
			settledCalls += 1;
			return [`notice at ${width}`];
		});
		let running = true;
		let liveCalls = 0;
		panel.appendReplayBlock(
			() => {
				liveCalls += 1;
				return [running ? "running" : "done"];
			},
			() => running,
		);
		for (const next of ["standard", "detailed", "standard", "detailed"] as const) {
			style = next;
			panel.render(80);
			clock += 150;
		}
		strictEqual(settledCalls, 2, "one render per style, then served from the cache");
		ok(liveCalls >= 4, "a live block renders on every frame that asks");
		running = false;
		clock += 150;
		match(plainRender(panel, 80), /done/u);
		const settledLive = liveCalls;
		style = "standard";
		panel.render(80);
		style = "detailed";
		panel.render(80);
		strictEqual(liveCalls, settledLive + 1, "once settled, the formerly live block caches too");
	});

	it("never full-redraws the regular screen when an answer taller than it finalizes", () => {
		const terminal = new RenderingTerminal();
		terminal.rows = 12;
		const panel = createChatPanel({ now: () => 0, getTerminalRows: () => terminal.rows });
		const tui = new TuiMainScreen(terminal);
		tui.addChild(
			buildLayout({
				banner: new Text("banner", 0, 0),
				chat: panel,
				editor: new Text("editor", 0, 0),
				footer: new Text("footer", 0, 0),
			}),
		);
		tui.start();
		try {
			panel.appendUser("Explain the retry design.");
			tui.renderNow();
			streamAnswer(panel, STREAMED_ANSWER);
			tui.renderNow();
			const redraws = tui.fullRedraws;
			settleAnswer(panel, STREAMED_ANSWER);
			tui.renderNow();
			strictEqual(tui.fullRedraws, redraws, "finalize rewrote rows already in scrollback");
		} finally {
			tui.stop();
		}
	});
});

describe("stream presentation timing", () => {
	it("asks for a frame on the first delta after a quiet window and coalesces the rest", () => {
		let clock = 1_000;
		let requests = 0;
		const timers: Array<{ callback: () => void; ms: number }> = [];
		const renderer = createCoalescingChatRenderer({
			chatPanel: createChatPanel({ now: () => clock }),
			requestRender: () => {
				requests += 1;
			},
			now: () => clock,
			setTimer: (callback, ms) => timers.push({ callback, ms }),
			clearTimer: () => {},
		});
		const delta = (text: string) =>
			renderer.applyEvent({ type: "text_delta", contentIndex: 0, delta: text, partialText: "" } as never);
		delta("First");
		strictEqual(requests, 1, "the first token does not wait out a coalesce window");
		strictEqual(timers.length, 0);
		clock += 5;
		delta(" token");
		delta(" burst");
		strictEqual(requests, 1, "deltas inside the window share one frame");
		strictEqual(timers.length, 1);
		strictEqual(timers[0]?.ms, 11, "the window runs from the last request, not from this delta");
		timers[0]?.callback();
		strictEqual(requests, 2);
		clock += 40;
		delta(" again");
		strictEqual(requests, 3, "a delta after a quiet window is on the leading edge again");
	});

	it("shows the whole first delta of a paced stream at once", () => {
		const slices: StreamPacerSlice[] = [];
		const timers: Array<{ callback: () => void; ms: number }> = [];
		const pacer = createStreamPacer({
			mode: "on",
			onSlice: (slice) => slices.push(slice),
			now: () => 0,
			setTimer: (callback, ms) => timers.push({ callback, ms }),
			clearTimer: () => {},
		});
		pacer.enqueue({ sequence: 1, generation: 1, kind: "text", contentIndex: 0, text: "Hello there" });
		strictEqual(timers[0]?.ms, 0);
		timers[0]?.callback();
		strictEqual(slices[0]?.text, "Hello there");
		strictEqual(slices[0]?.reason, "first");
		strictEqual(slices[0]?.finalForItem, true);
	});
});

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

describe("transcript block grammar", () => {
	const assistantMessage = (text: string) => ({
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
		stopReason: "stop",
	});
	const say = (panel: ChatPanel, text: string) => {
		panel.applyEvent({ type: "message_start", message: { role: "assistant", content: [] } } as never);
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: text } as never);
		panel.applyEvent({ type: "message_end", message: assistantMessage(text) } as never);
	};
	const act = (panel: ChatPanel, id: string, toolName: string, args: unknown, result: unknown, isError = false) => {
		panel.applyEvent({ type: "tool_execution_start", toolCallId: id, toolName, args } as never);
		panel.applyEvent({ type: "tool_execution_end", toolCallId: id, toolName, result, isError, durationMs: 5 } as never);
	};
	const observed = (text: string) => ({
		content: [{ type: "text", text }],
		details: { observation: { shownCount: 3, totalCount: 3, unit: "lines" } },
	});

	it("marks every operator prompt row with the bar and keeps its words bold only once committed", () => {
		let status: "pending" | "committed" = "pending";
		const panel = createChatPanel();
		panel.appendUser("first line of the prompt\nsecond line", () => status);
		const pending = panel.render(60);
		ok(pending.every((row) => stripTerminalSequences(row).startsWith(`${GLYPH.userBar} `)));
		ok(!pending.join("\n").includes("\u001b[1m"));
		match(stripTerminalSequences(pending.join("\n")), /· preparing/u);
		status = "committed";
		panel.invalidate();
		const committed = panel.render(60);
		deepStrictEqual(committed.map(stripTerminalSequences), [
			`${GLYPH.userBar} first line of the prompt`,
			`${GLYPH.userBar} second line`,
		]);
		ok(committed[0]?.startsWith("\u001b]133;A\u0007"));
		ok(committed.every((row) => row.includes("\u001b[1m")));
	});

	for (const style of ["compact", "standard", "detailed"] as const) {
		it(`separates prose, reasoning, and actions and stacks one-row actions in ${style}`, () => {
			const panel = createChatPanel({ getOutputStyle: () => style, getTerminalRows: () => 60 });
			panel.appendUser("Fix it");
			panel.applyEvent({ type: "agent_start" } as never);
			panel.applyEvent({ type: "message_start", message: { role: "assistant", content: [] } } as never);
			panel.applyEvent({ type: "thinking_delta", contentIndex: 0, delta: "Plan the reads." } as never);
			panel.applyEvent({ type: "text_delta", contentIndex: 1, delta: "Reading first." } as never);
			panel.applyEvent({ type: "message_end", message: assistantMessage("Reading first.") } as never);
			act(panel, "r1", "grep", { pattern: "needle", path: "src" }, observed("a\nb\nc"));
			act(panel, "r2", "git", { op: "status" }, { details: { exitCode: 0 } });
			say(panel, "Found it.");
			panel.applyEvent({ type: "agent_end", messages: [assistantMessage("Found it.")] } as never);
			const rows = panel.render(100).map(stripTerminalSequences);
			const at = (pattern: RegExp) => rows.findIndex((row) => pattern.test(row));
			const reading = at(/Reading first\./u);
			const grep = at(/searching for `needle` in src/u);
			const git = at(/git status/u);
			const found = at(/Found it\./u);
			ok(reading > 0 && grep > reading && found > git, rows.join("\n"));
			strictEqual(rows[reading - 1], "", "reasoning and prose are separated");
			strictEqual(rows[grep - 1], "", "prose and the first action are separated");
			strictEqual(git, grep + (style === "detailed" ? 5 : 1), rows.join("\n"));
			strictEqual(rows[found - 1], "", "resumed prose is separated from the actions");
			ok(rows[reading]?.startsWith(`${GLYPH.agent} `));
			ok(rows[found]?.startsWith(`${GLYPH.agent} `), "every prose block carries the agent glyph");
			doesNotMatch(rows.join("\n"), /path ›|pattern ›/u);
		});
	}

	it("closes a run split by a worker with exactly one receipt, after the last output", () => {
		for (const style of ["standard", "detailed"] as const) {
			const panel = createChatPanel({ getOutputStyle: () => style });
			panel.appendUser("Delegate the review");
			panel.applyEvent({ type: "agent_start" } as never);
			say(panel, "Dispatching a reviewer.");
			act(panel, "d1", "dispatch", { agent: "reviewer", task: "review" }, "1 task dispatched");
			panel.applyWorkerState({
				assignmentId: "a1",
				runId: "run-1",
				origin: "agent",
				agentId: "reviewer",
				runtime: { kind: "clio", targetId: "mini", wireModelId: "coder" },
				text: "looks fine",
				droppedLines: 0,
				tools: [],
				attempts: [{ runId: "run-1", targetLabel: "mini" }],
				pending: false,
				parentToolCallId: "d1",
				receipt: { outcome: "succeeded" },
			} as WorkerEntryState);
			say(panel, "The reviewer found nothing.");
			panel.applyEvent({ type: "agent_end", messages: [assistantMessage("The reviewer found nothing.")] } as never);
			const plain = plainRender(panel, 100);
			const receipt = style === "standard" ? /Done/gu : /turn · in/gu;
			strictEqual((plain.match(receipt) ?? []).length, 1, plain);
			ok(plain.lastIndexOf("found nothing") < plain.search(receipt), plain);
		}
	});

	it("keeps header facts off argument rows, hides settled mutation payloads, and states change facts", () => {
		const policy = transcriptDetail("standard");
		const bash = renderToolPreview(
			{ toolCallId: "b", toolName: "bash", args: { command: "pnpm test" }, result: "ok", isError: false },
			80,
			policy,
		).map(stripTerminalSequences);
		deepStrictEqual(bash.length, 1, bash.join("\n"));
		const edit = {
			toolCallId: "e",
			toolName: "edit",
			args: { path: "src/a.ts", edits: [{ oldText: "OLD_PAYLOAD", newText: "NEW_PAYLOAD" }] },
			result: { content: [{ type: "text", text: "ok" }], details: { diff: "-1 old\n+1 new\n+2 more\n 3 same" } },
			isError: false,
		};
		for (const style of ["compact", "standard", "detailed"] as const) {
			const plain = stripTerminalSequences(renderToolPreview(edit, 80, transcriptDetail(style)).join("\n"));
			match(plain, /editing src\/a\.ts · \+2 -1/u);
			doesNotMatch(plain, /OLD_PAYLOAD|NEW_PAYLOAD/u);
		}
		const failed = stripTerminalSequences(
			renderToolPreview({ ...edit, result: "oldText not found", isError: true }, 80, policy).join("\n"),
		);
		match(failed, /OLD_PAYLOAD/u, "a failed mutation keeps the text that did not match");
	});

	it("hangs a wrapped action row and nests its body in the content column", () => {
		const rows = renderToolPreview(
			{
				toolCallId: "w",
				toolName: "bash",
				args: { command: `echo ${"x".repeat(50)}` },
				result: "line one\nline two",
				isError: true,
			},
			48,
			transcriptDetail("standard"),
		).map(stripTerminalSequences);
		ok(rows[0]?.startsWith(`${GLYPH.toolHeader} `), rows.join("\n"));
		ok(rows.length > 2, rows.join("\n"));
		for (const row of rows.slice(1)) ok(row.startsWith("  "), `continuation or body left the gutter: ${row}`);
		ok(
			rows.some((row) => row.startsWith("  │ line one")),
			rows.join("\n"),
		);
	});

	it("states a skill load's identity, who asked for it, and what it is for", () => {
		const load = {
			toolCallId: "s",
			toolName: "context",
			args: { scope: "skills", name: "test-hygiene" },
			result: {
				content: [{ type: "text", text: "# test-hygiene" }],
				details: {
					name: "test-hygiene",
					description: "Keep tests deterministic.",
					activation: "model",
					allowedTools: ["read"],
					drift: "mismatch",
					observation: { shownCount: 1, totalCount: 1, unit: "sections" },
				},
			},
			isError: false,
		};
		const render = (style: OutputStyle) =>
			stripTerminalSequences(renderToolPreview(load, 90, transcriptDetail(style)).join("\n"));
		match(render("compact"), /loaded skill test-hygiene · by model · narrows tools · drifted ✓/u);
		doesNotMatch(render("compact"), /Keep tests deterministic|1 section/u);
		match(render("standard"), /\n {2}│ Keep tests deterministic\./u);
		// Until it settles, the row says the load is in progress.
		match(
			stripTerminalSequences(renderToolSubline({ toolCallId: "s", toolName: "context", args: load.args }, 90).join("")),
			/loading skill test-hygiene/u,
		);
	});

	it("leads an explicit /skill prompt with the command in the accent token", () => {
		const panel = createChatPanel();
		panel.appendUser("/skill test-hygiene make the test deterministic");
		const [row] = panel.render(80);
		ok(row?.includes(clioTheme().style("accent", "/skill test-hygiene", { bold: true })), row);
		strictEqual(stripTerminalSequences(row ?? ""), `${GLYPH.userBar} /skill test-hygiene make the test deterministic`);
	});

	it("shows what a running worker is doing in Standard and its history only in Detailed", () => {
		const entry = {
			assignmentId: "a",
			runId: "run-2",
			origin: "user",
			agentId: "scout",
			runtime: { kind: "clio", targetId: "blade", wireModelId: "m" },
			text: "",
			droppedLines: 0,
			tools: [],
			attempts: [{ runId: "run-2", targetLabel: "blade" }],
			pending: true,
			progress: {
				revision: 1,
				phase: "tool",
				tailText: "",
				droppedLines: 0,
				droppedBytes: 0,
				currentAction: { tool: "grep", descriptor: { verb: "searching", object: "retry(" } },
				recentActions: [{ tool: "read", descriptor: { verb: "read", object: "a.ts" } }],
				toolNames: ["grep", "read"],
				settled: false,
			},
		} as unknown as WorkerEntryState;
		const render = (style: OutputStyle) =>
			renderWorkerEntryLines(entry, 80, { detail: transcriptDetail(style) })
				.map(stripTerminalSequences)
				.join("\n");
		match(render("standard"), /now: searching retry\(/u);
		doesNotMatch(render("standard"), /last: read/u);
		match(render("detailed"), /last: read a\.ts/u);
		doesNotMatch(render("compact"), /now:/u);
	});
});
