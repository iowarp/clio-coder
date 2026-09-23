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
import { appendNotice } from "../../src/interactive/command-output.js";
import { openContextOverlay } from "../../src/interactive/context-overlay.js";
import { createEditorSubmitController, type EditorSubmitDeps } from "../../src/interactive/editor-submit.js";
import {
	createInteractiveSlashRuntime,
	type InteractiveSlashRuntimeDeps,
} from "../../src/interactive/interactive-slash-runtime.js";
import { buildLayout, returnToLiveEdge } from "../../src/interactive/layout.js";
import { showClioOverlayFrame } from "../../src/interactive/overlay-frame.js";
import { openAskUserOverlay } from "../../src/interactive/overlays/ask-user.js";
import {
	renderBashTranscriptExecution,
	renderToolExecution,
	renderToolPreview,
	renderToolSubline,
	type ToolExecutionFinished,
} from "../../src/interactive/renderers/tool-execution.js";
import { renderWorkerEntryLines } from "../../src/interactive/renderers/worker-entry.js";
import { createStreamPacer, type StreamPacerSlice } from "../../src/interactive/stream-pacer.js";
import { clioTheme, formatContextPercent, GLYPH } from "../../src/interactive/theme/index.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";
import {
	workerEntriesFromRunEntries,
	workerRunEntryFields,
	workerSettledFields,
	workerSettledFromData,
} from "../../src/interactive/worker-replay.js";
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

	it("states a skill suggestion the model wrote after its narration as a § row ahead of the answer", () => {
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
		const lines = rendered.split("\n");
		// The suggestion is advice for the operator: its own row under the
		// knowledge mark, never the agent's prose, and never repeated.
		strictEqual(lines[0], `${GLYPH.classKnowledge} suggests /skill tdd`, rendered);
		doesNotMatch(rendered, /Suggested skill:/u);
		strictEqual(rendered.split("/skill tdd").length, 2, rendered);
		ok(
			lines.some((line) => line === `${GLYPH.agent} I checked the tests first.`),
			rendered,
		);
		ok(rendered.indexOf("I checked the tests first.") < rendered.indexOf("Now the failing test."), rendered);
		const styled = panel.render(120).join("\n");
		ok(styled.includes(clioTheme().fg("accent", "/skill tdd")), "the command reads in the slash-command accent");
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

	/** A thinking model's turn: reasoning before every call, then reasoning before the answer. */
	const thinkingTurn = (
		style: OutputStyle,
		steps: ReadonlyArray<readonly [thinking: string | null, call: string | null]>,
	) => {
		const panel = createChatPanel({ getOutputStyle: () => style, now: () => 1_000 });
		panel.appendUser("Find the flaky test");
		panel.applyEvent({ type: "agent_start" } as never);
		const messages: unknown[] = [];
		const message = (thinking: string | null, text?: string) => {
			panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
			if (thinking !== null)
				panel.applyEvent({ type: "thinking_delta", contentIndex: 0, delta: thinking, partialThinking: thinking });
			const content = [
				...(thinking === null ? [] : [{ type: "thinking", thinking }]),
				...(text === undefined ? [] : [{ type: "text", text }]),
			];
			const settled = {
				role: "assistant",
				content,
				stopReason: text === undefined ? "toolUse" : "stop",
				usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 40 },
			};
			panel.applyEvent({ type: "message_end", message: settled } as never);
			messages.push(settled);
		};
		const calls: Record<string, [string, unknown, unknown]> = {
			read: [
				"read",
				{ path: "src/retry.js" },
				{
					content: [{ type: "text", text: "x" }],
					details: { observation: { unit: "lines", shownCount: 3, totalCount: 3 } },
				},
			],
			grep: [
				"grep",
				{ pattern: "Math.random" },
				{
					content: [{ type: "text", text: "x" }],
					details: { observation: { unit: "matches", shownCount: 1, totalCount: 1 } },
				},
			],
			test: [
				"read",
				{ path: "tests/retry.test.js" },
				{
					content: [{ type: "text", text: "x" }],
					details: { observation: { unit: "lines", shownCount: 3, totalCount: 3 } },
				},
			],
			bash: ["bash", { command: "npm test" }, { content: [{ type: "text", text: "ok" }], details: { exitCode: 0 } }],
		};
		steps.forEach(([thinking, call], index) => {
			if (thinking !== null) message(thinking);
			// A model call that returned only reasoning leaves two stretches side by side.
			if (call === null) return;
			const [toolName, args, result] = calls[call] ?? [];
			const id = `c${index}`;
			panel.applyEvent({ type: "tool_execution_start", toolCallId: id, toolName, args } as never);
			panel.applyEvent({
				type: "tool_execution_end",
				toolCallId: id,
				toolName,
				result,
				isError: false,
				durationMs: 5,
			} as never);
		});
		message("summarize the cause", "The jitter was real randomness.");
		panel.applyEvent({ type: "agent_end", messages } as never);
		return plainRender(panel, 100);
	};
	const markerRows = (rendered: string) => rendered.split("\n").filter((row) => row.startsWith("│ Thinking · /view"));

	it("folds a thinking model's explorations across its reasoning in Compact, one marker per run", () => {
		const rendered = thinkingTurn("compact", [
			["read the module", "read"],
			["search for the jitter", "grep"],
			["check the test", "test"],
			["run it", "bash"],
		]);
		// One fold for the three explorations: the reasoning between them does not split it.
		strictEqual(rendered.match(/explored/gu)?.length, 1, rendered);
		match(rendered, /▸ explored 2 files, 1 search ✓\n {2}│ src\/retry\.js · `Math\.random` · tests\/retry\.test\.js/u);
		// A marker ahead of the fold, one ahead of the command, and one ahead of the answer.
		deepStrictEqual(markerRows(rendered), [
			"│ Thinking · /view",
			"│ Thinking · /view",
			"│ Thinking · /view · 200 tokens",
		]);
		ok(rendered.indexOf("· 200 tokens") < rendered.indexOf("The jitter was real randomness."), rendered);
	});

	it("keeps a Compact fold's inner reasoning as the one marker ahead of it, with the turn's count", () => {
		const rendered = thinkingTurn("compact", [
			[null, "read"],
			["search for the jitter", "grep"],
		]);
		strictEqual(rendered.match(/explored/gu)?.length, 1, rendered);
		const rows = rendered.split("\n");
		const marker = rows.findIndex((row) => row.startsWith("│ Thinking · /view"));
		ok(marker >= 0 && marker < rows.findIndex((row) => row.startsWith("▸ explored")), rendered);
		// The answer's own reasoning keeps its marker, which carries the turn's count.
		deepStrictEqual(markerRows(rendered), ["│ Thinking · /view", "│ Thinking · /view · 80 tokens"]);
	});

	it("shows Standard's reasoning tail before Clio's words and a marker before an action", () => {
		const rendered = thinkingTurn("standard", [
			["read the module", "read"],
			["the test is next", null],
			["run it", "bash"],
		]);
		doesNotMatch(rendered, /read the module|the test is next|run it/u);
		// Stretches of reasoning that nothing visible separates are one run and one marker.
		strictEqual(markerRows(rendered).length, 2, rendered);
		match(rendered, /│ summarize the cause\n\n✦ The jitter was real randomness\./u);
		const detailed = thinkingTurn("detailed", [["read the module", "read"]]);
		match(detailed, /│ read the module\n\n▸ read src\/retry\.js/u);
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
		// A running row's verb is progressive; its tail is the live mark and the elapsed.
		match(before, /running `printf tool-command` ● 0ms/u);
		match(after, /running `printf tool-command` ● 2\.3s/u);
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

	it("keeps blocked and failed outcomes on finished calls without treating them as completed work", () => {
		const progress = createWorkerProgressFold();
		for (const [toolCallId, outcome] of [
			["blocked-call", "blocked"],
			["failed-call", "error"],
		] as const) {
			progress.observe({
				type: "clio_coder_tool_start",
				payload: { tool: "read", toolCallId, action: { verb: "reading", object: `${toolCallId}.ts` } },
			});
			progress.observe({ type: "clio_coder_tool_finish", payload: { tool: "read", toolCallId, outcome } });
		}
		deepStrictEqual(
			progress.snapshot().recentActions.map((action) => action.outcome),
			["error", "blocked"],
		);
		const entry = {
			assignmentId: "a",
			runId: "run-outcomes",
			origin: "user",
			agentId: "verifier",
			runtime: { kind: "clio", targetId: "blade", wireModelId: "m" },
			text: "",
			droppedLines: 0,
			tools: ["read"],
			attempts: [{ runId: "run-outcomes", targetLabel: "blade" }],
			pending: false,
			receipt: { outcome: "failed", durationMs: 1000, toolCalls: 2 },
			progress: progress.snapshot(),
		} as unknown as WorkerEntryState;
		const settled = workerSettledFields(entry);
		ok(settled);
		deepStrictEqual(
			workerSettledFromData(settled)?.calls?.map((call) => call.outcome),
			["error", "blocked"],
		);
		const rows = renderWorkerEntryLines(entry, 90, { detail: transcriptDetail("detailed") })
			.map(stripTerminalSequences)
			.join("\n");
		match(rows, /read blocked-call\.ts ✗ blocked/u);
		match(rows, /read failed-call\.ts ✗ failed/u);
	});

	it("neutralizes dead tool-call markup in a worker's live answer tail", () => {
		const entry = {
			assignmentId: "a",
			runId: "run-markup",
			origin: "user",
			agentId: "verifier",
			runtime: { kind: "clio", targetId: "blade", wireModelId: "m" },
			text: 'Evidence found. <tool_call>{"name":"read","arguments":{"path":"secrets"}}</tool_call> Reporting now.',
			droppedLines: 0,
			tools: [],
			attempts: [{ runId: "run-markup", targetLabel: "blade" }],
			pending: true,
		} as unknown as WorkerEntryState;
		const live = renderWorkerEntryLines(entry, 100, { detail: transcriptDetail("standard") })
			.map(stripTerminalSequences)
			.join("\n");
		match(live, /Evidence found\.\s+Reporting now\./u);
		doesNotMatch(live, /<tool_call>|"secrets"/u);
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
			match(plain, /quality validation failed/u);
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

	it("keeps the transcript's last column for a scrollbar that can appear, so the bar never covers content", () => {
		for (const [scrollbar, reserved] of [
			["auto", true],
			["always", true],
			["hidden", false],
		] as const) {
			const widths: number[] = [];
			// Every row fills the width it is given and ends in a marker cell.
			const chat = {
				render: (width: number) => {
					widths.push(width);
					return Array.from({ length: 60 }, () => `${"x".repeat(Math.max(0, width - 1))}Z`);
				},
				invalidate() {},
			};
			const terminal = new RenderingTerminal();
			const tui = new TuiAltScreen(terminal);
			const root = buildLayout(
				{ banner: new Text("", 0, 0), chat, editor: new Text("editor", 0, 0), footer: new Text("footer", 0, 0) },
				{ mode: "fullscreen", fullscreenScrollbar: scrollbar },
			);
			tui.setLayoutRoot(root);
			tui.start();
			try {
				tui.renderNow(true);
				// Scrolling shows an auto bar; the marker cell must survive it.
				terminal.input("\x1b[<64;2;2M");
				tui.renderNow(true);
				strictEqual(widths.at(-1), reserved ? 79 : 80, scrollbar);
				const screen = stripTerminalSequences(terminal.writes.join(""));
				ok(screen.includes(`${"x".repeat(reserved ? 78 : 79)}Z`), `${scrollbar}: a content row lost its last cell`);
			} finally {
				tui.stop();
			}
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

	it("returns a scrolled-up fullscreen transcript to its live edge when the operator submits", async () => {
		const terminal = new RenderingTerminal();
		const tui = new TuiAltScreen(terminal);
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
		const chat = new Text(lines.join("\n"), 0, 0);
		const root = buildLayout(
			{ banner: new Text("banner", 0, 0), chat, editor: new Text("editor", 0, 0), footer: new Text("footer", 0, 0) },
			{ mode: "fullscreen", fullscreenScrollbar: "auto" },
		);
		ok(root instanceof VStack);
		const scroll = root.children[0];
		ok(scroll instanceof ScrollView);
		tui.setLayoutRoot(root);
		tui.start();
		const noop = (): void => undefined;
		const liveEdge = (): void => returnToLiveEdge(tui);
		const runtime = createInteractiveSlashRuntime({
			io: { stdout: noop, stderr: noop },
			chat: { isStreaming: () => false, submit: async () => undefined },
			chatPanel: { appendReplayBlock: noop, appendUser: noop },
			requestRender: noop,
			refreshFooter: noop,
			recordSubmittedTurn: noop,
			returnToLiveEdge: liveEdge,
		} as unknown as InteractiveSlashRuntimeDeps);
		const editor = createEditorSubmitController({
			editor: { getText: () => "", getTextForSubmit: () => "", setText: noop, addToHistory: noop },
			ui: { start: noop, stop: noop, requestRender: noop },
			io: { stdout: noop, stderr: noop },
			chat: { isStreaming: () => false },
			dispatch: {},
			sessionTranscript: {
				ensureSessionForLocalEntry: noop,
				refreshChatContextFromSession: noop,
				recordSubmittedTurn: noop,
			},
			chatPanel: { appendReplayBlock: noop },
			dispatchCommand: noop,
			expandSubmit: async (text: string) => ({ text, images: [] }),
			notify: noop,
			runBash: async () => ({ output: "", exitCode: 0 }),
			returnToLiveEdge: liveEdge,
		} as unknown as EditorSubmitDeps);
		const scrollUp = (): void => {
			terminal.input("\x1b[<64;2;2M");
			tui.renderNow(true);
			strictEqual(tui.isFollowingOutput, false);
		};
		try {
			tui.renderNow(true);
			strictEqual(tui.isFollowingOutput, true);
			scrollUp();
			// New output alone keeps the operator where they scrolled.
			chat.setText([...lines, "more output"].join("\n"));
			tui.renderNow(true);
			strictEqual(tui.isFollowingOutput, false);
			const submits: Array<[string, () => unknown]> = [
				["a prompt", () => runtime.context.submitOperatorNote?.("what next?")],
				["a /run echo", () => runtime.context.echoOperatorCommand?.("/run scout map the retry module")],
				["a local ! command", () => editor.runEditorBash("!ls")],
			];
			for (const [name, submit] of submits) {
				scrollUp();
				await submit();
				tui.renderNow(true);
				strictEqual(tui.isFollowingOutput, true, name);
			}
			await editor.shutdownEditorBash();
		} finally {
			tui.stop();
		}
		// The regular screen has no viewport to move.
		returnToLiveEdge(new TuiMainScreen(new RenderingTerminal()));
	});
});

it("renders helper work as one subordinate row outside Detailed and keeps its identity on replay", () => {
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
	deepStrictEqual(lines.map(stripTerminalSequences), [
		`${GLYPH.subProcess} scout · Explore the source architecture ${GLYPH.running} 0ms`,
	]);
	ok(lines.every((line) => visibleWidth(line) <= 100));
	for (const style of ["compact", "standard", "detailed"] as const) {
		for (const width of [32, 80, 120]) {
			const rendered = renderWorkerEntryLines(state, width, {
				detail: transcriptDetail(style),
				terminalRows: 24,
				nowMs: 7000,
			});
			ok(rendered.every((line) => visibleWidth(line) <= width));
			if (style === "compact")
				match(stripTerminalSequences(rendered.join("\n")), width >= 80 ? /Explore the source/ : /· Explore.* ● 6\.0s$/u);
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
	match(stripTerminalSequences(call.join("\n")), /delegating to scout: Explore the source architecture/);
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
	match(done, new RegExp(`^${GLYPH.subProcess} scout · Explore the source architecture ✓`, "u"));
	doesNotMatch(done, /full findings|\n/u);
	const expanded = stripTerminalSequences(renderWorkerEntryLines(replayed, 100, { unbounded: true }).join("\n"));
	match(expanded, /full findings/);
	match(expanded, new RegExp(`^${GLYPH.subProcess} scout · internal`, "u"));
	const detailed = stripTerminalSequences(
		renderWorkerEntryLines(replayed, 100, { detail: transcriptDetail("detailed") }).join("\n"),
	);
	match(detailed, /full findings/);

	replayed.receipt = { outcome: "failed", failureMessage: "Invalid helper result" };
	const failed = stripTerminalSequences(renderWorkerEntryLines(replayed, 100, {}).join("\n"));
	match(failed, new RegExp(`^${GLYPH.subProcess} scout · Explore the source architecture ✗`, "u"));
	match(failed, /\n {2}│ ✗ Invalid helper result/u);
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
			const grep = at(/searched for `needle` in src/u);
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

	it("marks every transcript notice in the gutter by level and hangs its wrapped rows", () => {
		const panel = createChatPanel({ now: () => 1_000 });
		const notice = (level: "info" | "success" | "warning" | "error", text: string) =>
			panel.applyEvent({ type: "notice", level, surface: "transcript", text } as never);
		notice("info", "[Clio Coder] interrupt refused: a dispatch is attached. Queued for the next slot instead.");
		notice("warning", "[/context compact] auto-compaction failed: the summary exceeded its budget");
		notice("error", "[Clio Coder] context overflow persisted after compaction");
		notice("success", "session saved");
		// A footer notice is the footer's; the transcript never shows it.
		panel.applyEvent({ type: "notice", level: "info", surface: "footer", text: "cache may be cold" } as never);
		const rows = panel.render(40).map(stripTerminalSequences);
		const plain = rows.join("\n");
		doesNotMatch(plain, /\[Clio Coder\]|cache may be cold/u);
		match(plain, /^ℹ interrupt refused: a dispatch is/mu);
		match(plain, /^⚠ \[\/context compact\] auto-compaction/mu, "a subsystem tag stays");
		match(plain, /^✗ context overflow persisted after/mu);
		match(plain, /^✓ session saved$/mu);
		for (const row of rows.filter((line) => line.length > 0 && !/^[ℹ⚠✗✓] /u.test(line))) {
			ok(row.startsWith("  "), `a wrapped notice row left the content column: ${row}`);
		}
		for (const row of rows) ok(visibleWidth(row) <= 40, row);
	});

	it("hangs a wrapped command reply in the content column beside its mark", () => {
		const blocks: Array<(width: number) => string[]> = [];
		appendNotice(
			"success",
			"[/export] wrote 2301 lines to /tmp/scratchpad/demo-repo/.clio-coder/exports/1t6ygqmc7kuu-2026-09-23.html",
			{ appendReplayBlock: (block) => blocks.push(block), requestRender() {} },
		);
		const rows = (blocks[0]?.(40) ?? []).map(stripTerminalSequences);
		ok(rows[0]?.startsWith("✓ [/export] wrote 2301 lines"), rows.join("\n"));
		ok(rows.length > 1, rows.join("\n"));
		for (const row of rows.slice(1)) ok(row.startsWith("  "), `continuation left the gutter: ${row}`);
	});

	it("states guidance middleware attached for the model as one note, never as tool output", () => {
		const listing = {
			toolCallId: "l",
			toolName: "ls",
			args: { path: "." },
			result:
				"README.md\nsrc\n\n[middleware:info] Demo guidance: use the evidence you are gathering to identify one useful next step.\n[middleware:warn] Second note.",
			isError: false,
		};
		const detailed = stripTerminalSequences(renderToolPreview(listing, 100, transcriptDetail("detailed")).join("\n"));
		match(detailed, /│ README\.md\n {2}│ src\n {2}│ note to model · Demo guidance: use the evidence/u);
		match(detailed, /· \+1 more$/u);
		doesNotMatch(detailed, /\[middleware:/u);
		// The full result in /view is what the model read, notes included.
		const full = stripTerminalSequences(renderToolExecution(listing, 100, { unbounded: true }).join("\n"));
		match(full, /\[middleware:info\] Demo guidance/u);
		// Output that only quotes the tag mid-line stays output.
		const quoting = { ...listing, result: 'const warning = "[middleware:warn] " + TEXT;\nexport {}' };
		match(
			stripTerminalSequences(renderToolPreview(quoting, 100, transcriptDetail("detailed")).join("\n")),
			/const warning = "\[middleware:warn\] "/u,
		);
	});

	it("hangs a wrapped diff row under its content, past the sign and line number", () => {
		const edit = {
			toolCallId: "e",
			toolName: "edit",
			args: { path: "src/net/retry.js" },
			result: {
				content: [{ type: "text", text: "ok" }],
				details: {
					diff:
						'-24       console.debug("retry " + (attempt + 1) + " after " + Math.round(jitter) + "ms jitter");\n+24       console.debug(formatRetryMessage(attempt + 1, Math.round(jitter), "ms jitter", options));',
				},
			},
			isError: false,
		};
		for (const width of [40, 65]) {
			const rows = renderToolPreview(edit, width, transcriptDetail("standard")).map(stripTerminalSequences).slice(1);
			const removed = rows.findIndex((row) => row.startsWith("  │ -24 "));
			ok(removed >= 0 && rows[removed + 1]?.startsWith("  │     "), rows.join("\n"));
			for (const row of rows) ok(visibleWidth(row) <= width, row);
			for (const row of rows.filter((line) => !/^ {2}│ ([-+]24 |… \d+ rows)/u.test(line)))
				ok(/^ {2}│ {5}\S/u.test(row), `a continuation left the content column: ${row}`);
		}
	});

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
			const receipt = style === "standard" ? /Done/gu : /Done · \S+ · in 10 · out 5/gu;
			strictEqual((plain.match(receipt) ?? []).length, 1, plain);
			ok(plain.lastIndexOf("found nothing") < plain.search(receipt), plain);
		}
	});

	it("puts a card that arrives after its dispatch settled under that call, and one from an earlier turn at the tail", () => {
		const reviewer = (assignmentId: string, parentToolCallId: string) =>
			({
				assignmentId,
				runId: `run-${assignmentId}`,
				origin: "agent",
				agentId: "reviewer",
				runtime: { kind: "clio", targetId: "mini", wireModelId: "coder" },
				text: "looks fine",
				droppedLines: 0,
				tools: [],
				attempts: [{ runId: `run-${assignmentId}`, targetLabel: "mini" }],
				pending: false,
				parentToolCallId,
				receipt: { outcome: "succeeded" },
			}) as WorkerEntryState;
		const panel = createChatPanel({ getOutputStyle: () => "detailed" });
		panel.appendUser("Delegate the review");
		panel.applyEvent({ type: "agent_start" } as never);
		act(panel, "d1", "dispatch", { agent: "reviewer", task: "review the diff", detach: true }, "1 task dispatched");
		act(panel, "d2", "dispatch", { agent: "reviewer", task: "audit the docs", detach: true }, "1 task dispatched");
		appendNotice("info", "a notice between the call and its card", {
			appendReplayBlock: (block) => panel.appendReplayBlock(block),
			requestRender: () => undefined,
		});
		panel.applyWorkerState(reviewer("a1", "d1"));
		say(panel, "The reviewer found nothing.");
		panel.applyEvent({ type: "agent_end", messages: [assistantMessage("The reviewer found nothing.")] } as never);
		const rows = plainRender(panel, 100).split("\n");
		const call = rows.findIndex((row) => row.startsWith(`${GLYPH.workerAgent} delegated`));
		const card = rows.findIndex((row) => row.startsWith(`${GLYPH.workerAgent} reviewer`));
		const notice = rows.findIndex((row) => row.includes("a notice between the call and its card"));
		ok(call >= 0 && card > call && card < notice, rows.join("\n"));
		// The card states the run, so the call drops its task and its receipt body.
		strictEqual(rows[call], `${GLYPH.workerAgent} delegated to reviewer ✓ · 5ms`, rows.join("\n"));
		doesNotMatch(rows.join("\n"), /review the diff/u);
		// A call from an earlier turn keeps its row; a card for it lands at the tail.
		panel.appendUser("Something else");
		panel.applyWorkerState(reviewer("a2", "d2"));
		const later = plainRender(panel, 100).split("\n");
		match(later.join("\n"), /delegated to reviewer: audit the docs/u);
		const lastCard = later
			.flatMap((row, index) => (row.startsWith(`${GLYPH.workerAgent} reviewer`) ? [index] : []))
			.at(-1);
		ok((lastCard ?? -1) > later.indexOf("▌ Something else"), later.join("\n"));
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
			match(plain, /edited src\/a\.ts · \+2 -1/u);
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
		ok(rows[0]?.startsWith(`${GLYPH.classExecute} `), rows.join("\n"));
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
		match(render("compact"), /loaded skill test-hygiene · by model · drifted ✓/u);
		doesNotMatch(render("compact"), /narrows|Keep tests deterministic|1 section/u);
		// Standard nests the surface the skill declares, then what it is for.
		for (const style of ["standard", "detailed"] as const) {
			match(render(style), /✓\n {2}│ narrows tools to read\n {2}│ Keep tests deterministic\./u);
			doesNotMatch(render(style).split("\n")[0] ?? "", /narrows/u);
		}
		const excluding = {
			...load,
			result: {
				...load.result,
				details: { ...load.result.details, allowedTools: [], disallowedTools: ["bash", "write"] },
			},
		};
		match(
			stripTerminalSequences(renderToolPreview(excluding, 90, transcriptDetail("standard")).join("\n")),
			/\n {2}│ narrows tools to all but bash, write\n/u,
		);
		// Until it settles, the row says the load is in progress.
		match(
			stripTerminalSequences(renderToolSubline({ toolCallId: "s", toolName: "context", args: load.args }, 90).join("")),
			/loading skill test-hygiene/u,
		);
	});

	it("states a refused skill load as plainly as a load, from the refusal in its details", () => {
		const message =
			'context: skill "tech-spec" requires explicit operator activation with /skill tech-spec; it disables model invocation. Do not retry this load.';
		const refused = (refusal: Record<string, string>) => ({
			toolCallId: "r",
			toolName: "context",
			args: { scope: "skills", name: "tech-spec" },
			result: {
				content: [{ type: "text", text: message }],
				details: { refusal: { subject: "skill", name: "tech-spec", ...refusal } },
			},
			isError: true,
		});
		const cases: Array<[Record<string, string>, string]> = [
			[{ kind: "manual-only" }, "manual-only: /skill tech-spec"],
			[{ kind: "untrusted" }, "untrusted: review it in /library"],
			[{ kind: "not-imported", source: "claude", scope: "project" }, "not imported: found in claude/project"],
			[{ kind: "not-installed" }, "not installed: /skill tech-spec"],
			[{ kind: "not-ready", scope: "user", state: "disabled" }, "installed but disabled: /library"],
			[{ kind: "operator-only" }, "only you can load it: /skill tech-spec"],
			[{ kind: "recipe-bound" }, "not declared for this run"],
			[{ kind: "not-requested" }, "not requested this turn"],
			[{ kind: "already-loaded" }, "already loaded"],
			[{ kind: "unknown" }, "unknown skill"],
		];
		for (const [refusal, reason] of cases) {
			for (const style of ["compact", "standard", "detailed"] as const) {
				// One row and no body: the message is the model's instruction and stays in /view.
				const rows = renderToolPreview(refused(refusal), 100, transcriptDetail(style));
				deepStrictEqual(rows.map(stripTerminalSequences), [`§ skill tech-spec not loaded · ${reason} ✗`]);
			}
		}
		const [row] = renderToolPreview(refused({ kind: "manual-only" }), 100, transcriptDetail("standard"));
		ok(row?.includes(clioTheme().fg("accent", "/skill tech-spec")), "the move reads in the slash-command accent");
		// Narrow terminals hang the reason in the content column.
		const narrow = renderToolPreview(
			refused({ kind: "not-imported", source: "claude", scope: "project" }),
			40,
			transcriptDetail("standard"),
		).map(stripTerminalSequences);
		ok(narrow.length > 1, narrow.join("\n"));
		for (const line of narrow) ok(visibleWidth(line) <= 40, line);
		for (const line of narrow.slice(1)) ok(line.startsWith("  "), `continuation left the gutter: ${line}`);
		// An error without a refusal is still an ordinary failed load with its message.
		const failed = stripTerminalSequences(
			renderToolPreview({ ...refused({ kind: "manual-only" }), result: message }, 100, transcriptDetail("standard")).join(
				"\n",
			),
		);
		doesNotMatch(failed, /not loaded/u);
		match(failed, /requires explicit operator activation/u);
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
		// One live line in every style says what the run is doing now.
		for (const style of ["compact", "standard", "detailed"] as const) {
			match(render(style), /^◇ scout · blade\/m · run run-2 ●\n {2}│ ⚙ searching retry\(/u);
		}
		doesNotMatch(render("standard"), /last: read/u);
		match(render("detailed"), /last: read a\.ts/u);
		doesNotMatch(render("compact"), /last:/u);
	});

	it("lists a settled card's calls oldest first in the past tense, and a running card's last call alone", () => {
		const recentActions = [
			{ tool: "limitation" },
			{ tool: "read", descriptor: { verb: "reading", object: "docs/retry.md" } },
			{ tool: "grep", descriptor: { verb: "searching", object: "retry|options" } },
			{ tool: "git", descriptor: { verb: "git" } },
		];
		const entry = (pending: boolean) =>
			({
				assignmentId: "a",
				runId: "run-3",
				origin: "agent",
				agentId: "scout",
				runtime: { kind: "clio", targetId: "blade", wireModelId: "m" },
				text: "Found it.",
				droppedLines: 0,
				tools: ["git", "grep", "read", "limitation"],
				attempts: [{ runId: "run-3", targetLabel: "blade" }],
				pending,
				...(pending ? {} : { receipt: { outcome: "succeeded", durationMs: 9_000, toolCalls: 4 } }),
				progress: {
					revision: 1,
					phase: "tool",
					tailText: "",
					droppedLines: 0,
					droppedBytes: 0,
					currentAction: pending ? { tool: "bash", descriptor: { verb: "running", object: "npm test" } } : null,
					recentActions,
					toolNames: ["git", "grep", "read", "limitation"],
					settled: !pending,
				},
			}) as unknown as WorkerEntryState;
		const trail = (pending: boolean) =>
			renderWorkerEntryLines(entry(pending), 80, { detail: transcriptDetail("detailed") })
				.map(stripTerminalSequences)
				.filter((row) => row.startsWith(`  │ ${GLYPH.phaseTool}`));
		deepStrictEqual(trail(false), [
			`  │ ${GLYPH.phaseTool} git`,
			`  │ ${GLYPH.phaseTool} searched retry|options`,
			`  │ ${GLYPH.phaseTool} read docs/retry.md`,
			`  │ ${GLYPH.phaseTool} limitation`,
		]);
		deepStrictEqual(trail(true), [`  │ ${GLYPH.phaseTool} running npm test`, `  │ ${GLYPH.phaseTool} last: limitation`]);
	});

	it("states a run of one repeated call once, counted, and marks a call object the safety layer cut", () => {
		const evidence = { tool: "gateway", descriptor: { verb: "gateway", object: "evidence" } };
		const entry = {
			assignmentId: "a",
			runId: "run-5",
			origin: "user",
			agentId: "verifier",
			runtime: { kind: "clio", targetId: "blade", wireModelId: "m" },
			text: "",
			droppedLines: 0,
			tools: ["gateway", "read"],
			attempts: [{ runId: "run-5", targetLabel: "blade" }],
			pending: false,
			receipt: { outcome: "succeeded", durationMs: 9_000, toolCalls: 5 },
			// Newest first, as the worker progress fold keeps them.
			recentActions: [
				evidence,
				evidence,
				evidence,
				{ tool: "read", descriptor: { verb: "reading", object: "docs/a-long-name", truncated: true } },
			],
		} as unknown as WorkerEntryState;
		const trail = renderWorkerEntryLines(entry, 80, { detail: transcriptDetail("detailed") })
			.map(stripTerminalSequences)
			.filter((row) => row.startsWith(`  │ ${GLYPH.phaseTool}`));
		deepStrictEqual(trail, [
			`  │ ${GLYPH.phaseTool} … 1 earlier call · /view dispatch:run-5`,
			`  │ ${GLYPH.phaseTool} read docs/a-long-name${GLYPH.ellipsis}`,
			`  │ ${GLYPH.phaseTool} gateway evidence ${GLYPH.times}3`,
		]);
	});

	it("inspects a card in /view and /export as the Detailed card states it, with the answer whole and raw", () => {
		const answer = `{"verdict":"pass","checks":[{"name":"docs match","passed":true,"evidence":"${"read both files. ".repeat(40)}"}]}`;
		const entry = {
			assignmentId: "a",
			runId: "run-4",
			origin: "user",
			agentId: "verifier",
			runtime: { kind: "clio", targetId: "blade", wireModelId: "m" },
			text: answer,
			droppedLines: 0,
			tools: ["read"],
			attempts: [{ runId: "run-4", targetLabel: "blade" }],
			pending: false,
			contextTokens: 3_164,
			receipt: { outcome: "succeeded", durationMs: 8_200, toolCalls: 1, tokenCount: 19_100, contract: "pass" },
			progress: {
				revision: 1,
				phase: "writing",
				tailText: "",
				droppedLines: 0,
				droppedBytes: 0,
				currentAction: null,
				recentActions: [{ tool: "read", descriptor: { verb: "reading", object: "docs/retry.md" } }],
				toolNames: ["read"],
				settled: true,
			},
		} as unknown as WorkerEntryState;
		const detailed = renderWorkerEntryLines(entry, 80, { detail: transcriptDetail("detailed") }).map(
			stripTerminalSequences,
		);
		const inspected = renderWorkerEntryLines(entry, 80, { unbounded: true }).map(stripTerminalSequences);
		// The same header, spend, trail and quality rows, in the same words.
		strictEqual(inspected[0], detailed[0]);
		strictEqual(inspected[0], "◇ verifier · blade/m · run run-4 ✓ execution ok · 8.2s");
		strictEqual(inspected[1], "  │ 19.1k tokens processed · context 3.2k · 1 tool call · contract pass");
		strictEqual(detailed[1], "  │ 19.1k tokens processed · context 3.2k · 1 tool call");
		for (const row of detailed.filter((line) => /│ (⚙|quality )/u.test(line))) ok(inspected.includes(row), row);
		doesNotMatch(inspected.join("\n"), /└|\btok\b|… \d+ rows/u);
		// The answer is whole and as the run returned it.
		const body = inspected
			.map((row) => row.replace(/^ {2}│ /u, ""))
			.join(" ")
			.replace(/\s+/gu, " ");
		match(body, /\{"verdict":"pass","checks":/u);
		strictEqual(body.split("read both files.").length - 1, 40, body);
		match(detailed.join("\n"), /… \d+ rows · \/view/u, "the transcript bounds what inspection shows whole");
	});
});

describe("tool classes", () => {
	const text = (body: string, details: Record<string, unknown> = {}) => ({
		content: [{ type: "text", text: body }],
		details,
	});
	const settled = (toolName: string, args: unknown, result: unknown, extra: Partial<ToolExecutionFinished> = {}) =>
		({
			toolCallId: `${toolName}-1`,
			toolName,
			args,
			result,
			isError: false,
			durationMs: 42,
			...extra,
		}) as ToolExecutionFinished;
	const rows = (call: Parameters<typeof renderToolPreview>[0], style: OutputStyle = "standard", width = 100) =>
		renderToolPreview(call, width, transcriptDetail(style)).map(stripTerminalSequences);

	it("marks each class in the gutter, running rows progressive and settled rows past tense", () => {
		const cases: Array<[string, Record<string, unknown>, string, string, string]> = [
			["read", { path: "a.ts" }, GLYPH.toolHeader, "reading a.ts", "read a.ts"],
			["grep", { pattern: "needle" }, GLYPH.toolHeader, "searching for `needle`", "searched for `needle`"],
			["context", { scope: "docs", query: "q" }, GLYPH.classKnowledge, "consulting docs", "consulted docs"],
			["edit", { path: "a.ts" }, GLYPH.classMutate, "editing a.ts", "edited a.ts"],
			["write", { path: "a.ts" }, GLYPH.classMutate, "writing a.ts", "wrote a.ts"],
			["bash", { command: "ls" }, GLYPH.classExecute, "running `ls`", "ran `ls`"],
			[
				"web_fetch",
				{ url: "https://example.com/a" },
				GLYPH.classNetwork,
				"fetching example.com/a",
				"fetched example.com/a",
			],
			["dispatch", { agent: "scout", task: "map" }, GLYPH.workerAgent, "delegating to scout", "delegated to scout"],
			["ask_user", { questions: [{ question: "Keep it?" }] }, GLYPH.classInteraction, "asking Keep it?", "asked Keep it?"],
			[
				"mcp_github__search_issues",
				{},
				GLYPH.classExternal,
				"calling github › search_issues",
				"called github › search_issues",
			],
		];
		for (const [toolName, args, mark, running, done] of cases) {
			const live = renderToolSubline({ toolCallId: toolName, toolName, args }, 100).map(stripTerminalSequences);
			ok(live[0]?.startsWith(`${mark} ${running}`), `${toolName} running: ${live[0]}`);
			const row = renderToolSubline(settled(toolName, args, text("ok")), 100).map(stripTerminalSequences);
			ok(row[0]?.startsWith(`${mark} ${done}`), `${toolName} settled: ${row[0]}`);
		}
	});

	it("names the operation a call performs and what it acts on", () => {
		const head = (toolName: string, args: Record<string, unknown>) =>
			stripTerminalSequences(renderToolSubline(settled(toolName, args, text("ok")), 200)[0] ?? "");
		const cases: Array<[string, Record<string, unknown>, string]> = [
			["steer", { run_id: "r1", action: "cancel" }, `${GLYPH.workerAgent} cancelled run r1 ✓`],
			["monitor", { mode: "wait", run_id: "r1" }, `${GLYPH.workerAgent} waited on run r1 ✓`],
			["monitor", { mode: "collect", batch_id: "b7" }, `${GLYPH.workerAgent} collected batch b7 ✓`],
			["dispatch", { list: true }, `${GLYPH.workerAgent} listed fleet agents ✓`],
			[
				"dispatch",
				{ mode: "council", roster: "design", task: "Own the clock?" },
				`${GLYPH.workerAgent} delegated a council of design: Own the clock? ✓`,
			],
			[
				"dispatch",
				{ tasks: ["a", "b", "c"], mode: "pipeline", detach: true },
				`${GLYPH.workerAgent} delegated 3 tasks as a pipeline · detach ✓`,
			],
			["data", { op: "select", path: "runs.csv", limit: 5 }, `${GLYPH.toolHeader} selected from runs.csv · limit 5 ✓`],
			[
				"web_fetch",
				{ url: "https://api.example.com/v1/items", method: "POST" },
				`${GLYPH.classNetwork} sent api.example.com/v1/items · method POST ✓`,
			],
			["verify", {}, `${GLYPH.classExecute} listed checks ✓`],
			["git", { op: "diff", path: "src/a.ts", cached: true }, `${GLYPH.classExecute} ran git diff src/a.ts · cached ✓`],
			[
				"run_script",
				{ interpreter: "python3", script: "probe.py", args: ["--n", "5"] },
				`${GLYPH.classExecute} ran \`python3 probe.py --n 5\` ✓`,
			],
			["panes", { action: "show", target: "r1" }, `${GLYPH.classExecute} ran panes show r1 ✓`],
			[
				"ledger",
				{ action: "post", kind: "finding", path: "src/a.ts", line: 12 },
				`${GLYPH.classKnowledge} consulted ledger post finding src/a.ts:12 ✓`,
			],
			["context", { scope: "skills", query: "profiling" }, `${GLYPH.classKnowledge} consulted skills \`profiling\` ✓`],
			["grep", { pattern: "x", ignore_case: true }, `${GLYPH.toolHeader} searched for \`x\` · ignore_case ✓`],
			[
				"artifact",
				{ kind: "plan", title: "Retry design", path: "docs/plan.md", content: "…" },
				`${GLYPH.classMutate} wrote plan "Retry design" to docs/plan.md ✓`,
			],
		];
		for (const [toolName, args, expected] of cases) strictEqual(head(toolName, args), `${expected} · 42ms`, toolName);
	});

	it("does not repeat a monitor run id at the start of its result preview", () => {
		const call = settled("monitor", { run_id: "k2m9x4" }, text("k2m9x4 · completed · 7 tool calls"));
		const preview = rows(call, "detailed").join("\n");
		match(preview, /checked run k2m9x4/u);
		match(preview, /│ completed · 7 tool calls/u);
		doesNotMatch(preview, /│ k2m9x4 · completed/u);
		const inspected = renderToolExecution(call, 100, { unbounded: true }).map(stripTerminalSequences).join("\n");
		match(inspected, /k2m9x4 · completed · 7 tool calls/u, "inspection retains the model-facing result");
	});

	it("gives a running row the live mark and elapsed, never the verb twice", () => {
		const live = renderToolSubline(
			{ toolCallId: "b", toolName: "bash", args: { command: "sleep 5" }, elapsedMs: 1_200 },
			100,
		);
		strictEqual(
			stripTerminalSequences(live.join("\n")),
			`${GLYPH.classExecute} running \`sleep 5\` ${GLYPH.running} 1.2s`,
		);
	});

	it("states a failed command's exit once and keeps its output without the status line", () => {
		const failed = rows(
			settled(
				"bash",
				{ command: "pnpm run lint" },
				text("src/a.ts:1:1 lint/style/useTemplate prefer a template\n\nCommand exited with code 1"),
				{ isError: true, durationMs: 4_100 },
			),
		);
		strictEqual(failed[0], `${GLYPH.classExecute} ran \`pnpm run lint\` · exit 1 ✗ · 4.1s`);
		strictEqual(failed.join("\n").match(/exit 1|exited with code|command failed/gu)?.length, 1, failed.join("\n"));
		match(failed.join("\n"), /│ src\/a\.ts:1:1 lint\/style\/useTemplate/u);
		// The main agent's error path delivers only text; a status that carries the diagnosis keeps it.
		const missing = rows(
			settled("bash", { command: "pnpm lint" }, text("bash: command failed (exit 127): pnpm: not found"), {
				isError: true,
			}),
		);
		match(missing[0] ?? "", /· exit 127 ✗/u);
		deepStrictEqual(missing.slice(1), ["  │ pnpm: not found"]);
	});

	it("states an exit code only when the result carries one", () => {
		const panes = rows(settled("panes", { action: "list" }, text("2 panes", { action: "list", panes: [] })));
		doesNotMatch(panes[0] ?? "", /exit/u);
		const unknown = rows(settled("deploy_preview", { stage: "staging" }, text("deployed"), { actionClass: "execute" }));
		ok(unknown[0]?.startsWith(`${GLYPH.classExecute} ran deploy_preview · stage staging`), unknown[0]);
		doesNotMatch(unknown[0] ?? "", /exit/u);
	});

	it("keeps a failed edit's error once, in its body, beside the text that did not match", () => {
		const failed = rows(
			settled(
				"edit",
				{ path: "src/a.ts", edits: [{ oldText: "OLD", newText: "NEW" }] },
				text("edit: oldText not found in src/a.ts."),
				{ isError: true },
			),
		);
		deepStrictEqual(failed, [
			`${GLYPH.classMutate} edited src/a.ts ✗ · 42ms`,
			"  │ oldText › OLD",
			"  │ newText › NEW",
			"  │ edit: oldText not found in src/a.ts.",
		]);
	});

	it("names a web row's host and path tail, never the whole URL, and states its format once", () => {
		const fetched = rows(
			settled(
				"web_fetch",
				{ url: "https://nodejs.org/api/globals.html#abortsignaltimeoutdelay", format: "markdown" },
				text("## AbortSignal", { status: 200, format: "markdown", bytesRead: 12_431 }),
			),
		);
		deepStrictEqual(fetched, [
			`${GLYPH.classNetwork} fetched nodejs.org/api/globals.html · 200 · markdown · 12.1KB ✓ · 42ms`,
		]);
		const issue = settled("web_fetch", { url: "https://github.com/iowarp/clio-coder/issues/412" }, text("# issue"));
		match(rows(issue, "standard", 100)[0] ?? "", /fetched github\.com\/iowarp\/clio-coder\/issues\/412 /u);
		// At 40 columns the label shortens to the path tail instead of splitting mid-token.
		const narrow = rows(issue, "standard", 40);
		match(narrow.join("\n"), /github\.com\/…\/issues\/412/u);
		ok(
			narrow.every((row) => !/https?:/u.test(row) && visibleWidth(row) <= 40),
			narrow.join("\n"),
		);
	});

	it("reads a gateway or MCP call as its capability, with no op, capability or args rows", () => {
		for (const style of ["compact", "standard", "detailed"] as const) {
			const mcp = rows(
				settled(
					"gateway",
					{ op: "call", capability: "mcp_github__search_issues", args: { query: "flaky retry test", state: "open" } },
					text("#412", { capability: "mcp_github__search_issues" }),
				),
				style,
			);
			strictEqual(
				mcp[0],
				`${GLYPH.classExternal} called github › search_issues · query "flaky retry test" · state open · via gateway ✓ · 42ms`,
			);
			doesNotMatch(mcp.join("\n"), /op ›|capability ›|args ›/u);
			const builtin = rows(
				settled(
					"gateway",
					{ op: "call", capability: "web_fetch", args: { url: "https://github.com/iowarp/clio-coder/issues/412" } },
					text("# issue", { capability: "web_fetch", status: 200 }),
				),
				style,
			);
			match(builtin[0] ?? "", new RegExp(`^${GLYPH.classNetwork} fetched github\\.com/.* · 200 · via gateway ✓`, "u"));
			const find = rows(
				settled("gateway", { op: "find", query: "github issues" }, text("…", { op: "find", count: 3, total: 7 })),
				style,
			);
			strictEqual(find[0], `${GLYPH.classExternal} searched capabilities for \`github issues\` · 3 of 7 found ✓ · 42ms`);
		}
	});

	it("reads an extension tool as server › tool with its scalar arguments inline", () => {
		const row = rows(settled("extension_hpc__queue_status", { partition: "gpu" }, text("gpu: 3 pending")));
		deepStrictEqual(row, [`${GLYPH.classExternal} called hpc › queue_status · partition gpu ✓ · 42ms`]);
	});

	it("reads an operator question as question → answer and never renders the model's copy", () => {
		const interview = (answers: unknown[], decisions: unknown[] = []) =>
			text('ask_user result: answered\n\n{ "interview": {} }', { interview: {}, answers, decisions });
		for (const style of ["compact", "standard", "detailed"] as const) {
			const one = rows(
				settled(
					"ask_user",
					{ questions: [{ question: "Keep it deprecated?", options: [{ label: "Yes" }, { label: "No" }] }] },
					interview([{ question: "Keep it deprecated?", answer: "Yes" }]),
				),
				style,
			);
			deepStrictEqual(one, [`${GLYPH.classInteraction} asked Keep it deprecated? → Yes ✓ · 42ms`]);
			const round = rows(
				settled(
					"ask_user",
					{ questions: [{ question: "Jitter?" }, { question: "Alias?" }] },
					interview([
						{ question: "Jitter?", answer: "50" },
						{ question: "Alias?", answer: "Yes" },
					]),
				),
				style,
			);
			deepStrictEqual(round, [
				`${GLYPH.classInteraction} asked 2 questions ✓ · 42ms`,
				"  │ Jitter? → 50",
				"  │ Alias? → Yes",
			]);
			const complete = rows(
				settled(
					"ask_user",
					{ action: "complete", decisions: [{ key: "jitter_ms", value: "50", label: "Jitter" }], summary: "Jitter 50." },
					interview([], [{ key: "jitter_ms", value: "50", label: "Jitter" }]),
				),
				style,
			);
			deepStrictEqual(complete, [`${GLYPH.classInteraction} completed the interview ✓ · 42ms`, "  │ Jitter → 50"]);
		}
	});

	it("states evidence and run_script calls on their rows instead of as JSON", () => {
		deepStrictEqual(rows(settled("evidence", { mode: "list" }, text("{}"))), [
			`${GLYPH.classKnowledge} consulted evidence list ✓ · 42ms`,
		]);
		deepStrictEqual(
			rows(
				settled("run_script", { script: "scripts/check-flaky.ts", args: ["--runs", "50"] }, text("50/50", { exitCode: 0 })),
			),
			[`${GLYPH.classExecute} ran \`scripts/check-flaky.ts --runs 50\` · exit 0 ✓ · 42ms`],
		);
	});

	it("repeats under a row only the argument the row had to cut", () => {
		const task = "List every call site of retry() and the options each one passes to it.";
		const body = rows({ toolCallId: "d", toolName: "dispatch", args: { agent: "scout", task } }, "standard", 80);
		match(body[0] ?? "", /delegating to scout: List every call site/u);
		deepStrictEqual(
			body
				.slice(1)
				.join(" ")
				.replace(/\s*│\s*/gu, " ")
				.trim(),
			`task › ${task}`,
		);
		const fits = rows({ toolCallId: "d", toolName: "dispatch", args: { agent: "scout", task } }, "standard", 200);
		strictEqual(fits.length, 1, fits.join("\n"));
		// A multiline command is flattened on its row, so its body states it whole.
		const script = rows({ toolCallId: "b", toolName: "bash", args: { command: "cd src\nls" } }, "standard", 100);
		deepStrictEqual(script.slice(1), ["  │ command › cd src", "  │   ls"]);
	});

	it("points an offloaded result at /view instead of printing its scratch path", () => {
		const offloadPath = `/home/operator/.local/state/clio-coder/scratch/1t6ygq/${"a".repeat(64)}.txt`;
		const fetched = {
			toolCallId: "f",
			toolName: "web_fetch",
			args: { url: "https://nodejs.org/api/test.html", format: "markdown" },
			result: {
				content: [{ type: "text", text: "# Test runner" }],
				details: { status: 200, format: "markdown", resultSize: { truncated: true, offloadPath } },
			},
			isError: false,
			durationMs: 377,
		};
		for (const style of ["compact", "standard", "detailed"] as const) {
			const rows = renderToolPreview(fetched, 100, transcriptDetail(style)).map(stripTerminalSequences);
			match(rows[0] ?? "", /· full output · \/view$/u, style);
			doesNotMatch(rows.join("\n"), /scratch\/1t6ygq|a{64}/u);
		}
		// The full body in /view states where the rest is.
		match(
			stripTerminalSequences(renderToolExecution(fetched, 140, { unbounded: true }).join("\n")),
			new RegExp(`full output {2}${offloadPath.replaceAll(".", "\\.")}`, "u"),
		);
	});

	it("states the command a bash call ran, not a cd into the workspace it already runs in", () => {
		const cwd = process.cwd();
		const rows = (args: Record<string, unknown>, result: unknown = "ok", isError = false) =>
			renderToolPreview(
				{ toolCallId: "b", toolName: "bash", args, result, isError },
				100,
				transcriptDetail("standard"),
			).map(stripTerminalSequences);
		deepStrictEqual(rows({ command: `cd ${cwd} && npm test 2>&1`, timeout_ms: 30_000 }), ["$ ran `npm test 2>&1` ✓"]);
		deepStrictEqual(rows({ command: `cd "${cwd}"; npm run lint` }), ["$ ran `npm run lint` ✓"]);
		// A cd into a subdirectory, or an explicit cwd, is where the command ran.
		deepStrictEqual(rows({ command: `cd ${cwd}/src && ls` }), ["$ ran `ls` in src ✓"]);
		deepStrictEqual(rows({ command: "npm test", cwd: `${cwd}/tests` }), ["$ ran `npm test` in tests ✓"]);
		// A cd anywhere else is part of what ran.
		deepStrictEqual(rows({ command: "cd /etc && cat hosts" }), ["$ ran `cd /etc && cat hosts` ✓"]);
		// A command too long for its row is cut with the ellipsis glyph, never three dots.
		const long = rows({ command: `node scripts/${"x".repeat(200)}.js --flag` });
		match(long[0] ?? "", /^\$ ran `node scripts\/x+…` ✓$/u);
		// A timeout the command hit is the fact; one it stayed under is not stated.
		const timedOut = rows(
			{ command: "npm test", timeout_ms: 30_000 },
			{ content: [{ type: "text", text: "bash: command timed out after 30000ms" }], details: { timedOut: true } },
			true,
		);
		match(timedOut[0] ?? "", /^\$ ran `npm test` · timed out after 30s ✗/u);
	});

	it("keeps every character of a command the full body echoes, a lone & included", () => {
		for (const command of ["npm test 2>&1 | tail -5", "sleep 5 & wait", "make >out.log 2>&1 && echo ok"]) {
			const body = renderToolExecution(
				{ toolCallId: "b", toolName: "bash", args: { command }, result: "done", isError: false },
				160,
				{ unbounded: true },
			)
				.map(stripTerminalSequences)
				.join("\n");
			ok(body.includes(`$ ${command}`), body);
		}
	});

	it("states the operator's local command as not sent to the model once", () => {
		for (const running of [true, false]) {
			const plain = renderBashTranscriptExecution(
				{ command: "cat notes.txt", output: "notes", running, exitCode: 0, excludeFromContext: true },
				100,
			)
				.map(stripTerminalSequences)
				.join("\n");
			strictEqual(plain.match(/not sent to model/gu)?.length, 1, plain);
			doesNotMatch(plain, /context/u);
		}
	});

	it("counts a listing's entries and never its bytes, while a read keeps the size it returned", () => {
		// The ls tool's own observation: a count of entries and the bytes of the listing text.
		const listing = text("a.ts\nb.ts\nsrc/\ntests/\nREADME.md\npackage.json\n.git/", {
			observation: { unit: "entries", shownCount: 7, totalCount: 7, shownBytes: 55, totalBytes: 55 },
		});
		deepStrictEqual(rows(settled("ls", {}, listing)), [`${GLYPH.toolHeader} listed workspace · 7 entries ✓ · 42ms`]);
		const read = text("x", {
			observation: { unit: "lines", shownCount: 40, totalCount: 120, shownBytes: 1_434, totalBytes: 4_403 },
		});
		deepStrictEqual(rows(settled("read", { path: "src/net/retry.ts" }, read)), [
			`${GLYPH.toolHeader} read src/net/retry.ts · lines 1-40 of 120 · 1.4KB of 4.3KB ✓ · 42ms`,
		]);
	});

	it("wraps a narrow row of facts between the facts, never inside one, on rows, cards and receipts", () => {
		const output = Array.from({ length: 18 }, (_, index) => `line ${index}`).join("\n");
		const command = "npm test -- --test-reporter spec --test-concurrency 1 --test-timeout 60000";
		const card = {
			assignmentId: "a",
			runId: "run-6",
			origin: "user",
			agentId: "verifier",
			runtime: { kind: "clio", targetId: "blade", wireModelId: "m" },
			text: "",
			droppedLines: 0,
			tools: [],
			attempts: [{ runId: "run-6", targetLabel: "blade" }],
			pending: false,
			contextTokens: 3_164,
			receipt: { outcome: "succeeded", durationMs: 8_200, toolCalls: 6, tokenCount: 19_100 },
		} as unknown as WorkerEntryState;
		const panel = createChatPanel({ getOutputStyle: () => "detailed" });
		const usage = { input: 47_200, output: 465, cacheRead: 0, cacheWrite: 0, reasoning: 138, totalTokens: 47_665 };
		const message = { role: "assistant", content: [{ type: "text", text: "Done." }], usage, stopReason: "stop" };
		panel.appendUser("Q");
		panel.applyEvent({ type: "agent_start" } as never);
		panel.applyEvent({ type: "message_start", message: { role: "assistant", content: [] } } as never);
		panel.applyEvent({ type: "message_end", message } as never);
		panel.applyEvent({ type: "agent_end", messages: [message, message] } as never);
		for (const width of [40, 60, 95]) {
			const row = rows(settled("bash", { command }, text(output, { exitCode: 0 })), "standard", width);
			const spend = renderWorkerEntryLines(card, width, { detail: transcriptDetail("standard") }).map(
				stripTerminalSequences,
			);
			const receipt = panel.render(width).map(stripTerminalSequences);
			for (const [rendered, facts] of [
				[row, ["exit 0", "18 lines"]],
				[spend, ["context 3.2k", "6 tool calls"]],
				[receipt, ["in 94.4k", "out 930", "reasoning 276"]],
			] as const) {
				for (const fact of facts)
					ok(
						rendered.some((line) => line.includes(fact)),
						`${width}: "${fact}" split\n${rendered.join("\n")}`,
					);
			}
		}
	});

	it("states a refusal once: on the blocked row's tail, not again as its body's first line", () => {
		const rejection = [
			"bash blocked: system_modify",
			"Clio refused to run bash.",
			"- matched rm-recursive-or-force: rm with recursive or force flags",
			"rule: rm-recursive-or-force",
		].join("\n");
		for (const style of ["compact", "standard", "detailed"] as const) {
			const plain = rows(
				settled("bash", { command: "rm -rf ./build" }, text(rejection), {
					isError: true,
					outcome: "blocked",
					blockReason: "bash blocked: system_modify",
				}),
				style,
			).join("\n");
			strictEqual(plain.split("bash blocked: system_modify").length - 1, 1, plain);
			match(plain, /^\$ blocked `rm -rf \.\/build` ✗ · bash blocked: system_modify/u);
			match(plain, /rule: rm-recursive-or-force/u, "the rest of the rejection stays");
		}
	});

	it("states a path inside the workspace relative to it and keeps the tail of one it must cut", () => {
		const cwd = process.cwd();
		const listing = text("a.ts", { observation: { unit: "entries", shownCount: 7, totalCount: 7, shownBytes: 55 } });
		// A model that sends absolute paths reads the same as one that sends
		// relative ones: no cut prefix, no `path ›` row repeating it.
		deepStrictEqual(rows(settled("ls", { path: cwd }, listing)), [
			`${GLYPH.toolHeader} listed workspace · 7 entries ✓ · 42ms`,
		]);
		deepStrictEqual(rows(settled("read", { path: `${cwd}/docs/retry.md` }, text("x"))), [
			`${GLYPH.toolHeader} read docs/retry.md ✓ · 42ms`,
		]);
		deepStrictEqual(rows(settled("grep", { pattern: "needle", path: `${cwd}/src` }, text("x"))), [
			`${GLYPH.toolHeader} searched for \`needle\` in src ✓ · 42ms`,
		]);
		deepStrictEqual(rows(settled("edit", { path: `${cwd}/src/a.ts` }, text("ok"))), [
			`${GLYPH.classMutate} edited src/a.ts ✓ · 42ms`,
		]);
		// A resource read the path already names carries no second label.
		deepStrictEqual(rows(settled("read", { path: "docs/retry.md" }, text("x"))), [
			`${GLYPH.toolHeader} read docs/retry.md ✓ · 42ms`,
		]);
		match(rows(settled("read", { path: "CLIO-CODER.md" }, text("x")))[0] ?? "", /read CLIO-CODER\.md · handbook ✓/u);
		// A path that fits beside its verb stays whole, so nothing repeats it.
		const whole = rows(settled("read", { path: "library/skills/perf/SKILL.md" }, text("x")), "standard", 40);
		match(whole[0] ?? "", /^▸ read library\/skills\/perf\/SKILL\.md/u, whole.join("\n"));
		doesNotMatch(whole.join("\n"), /path ›/u);
		// A path outside the workspace that must be cut keeps its file name, on
		// the row's first line with its outcome, and repeats in full beneath it.
		const outside = `/opt/${"deep/".repeat(20)}src/net/retry.js`;
		for (const width of [40, 60, 100]) {
			const cut = rows(settled("read", { path: outside }, text("x")), "standard", width);
			match(cut[0] ?? "", /^▸ read …\/[^ ]*\/net\/retry\.js ✓/u, `${width}: ${cut.join("\n")}`);
			match(cut.join("\n"), /path ›/u);
		}
	});

	it("folds explorations, lookups and changes by class in Compact and never folds commands or failures", () => {
		const panel = createChatPanel({ getOutputStyle: () => "compact" });
		const act = (id: string, toolName: string, args: unknown, result: unknown, isError = false) => {
			panel.applyEvent({ type: "tool_execution_start", toolCallId: id, toolName, args } as never);
			panel.applyEvent({ type: "tool_execution_end", toolCallId: id, toolName, result, isError, durationMs: 5 } as never);
		};
		const lines = (count: number) => text("x", { observation: { shownCount: count, totalCount: count, unit: "lines" } });
		act("r1", "read", { path: "a.ts" }, lines(3));
		act("r2", "grep", { pattern: "needle", path: "src" }, lines(1));
		act("r3", "ls", { path: "src" }, lines(2));
		act("m1", "edit", { path: "a.ts" }, text("ok", { diff: "-1 a\n+1 b" }));
		act("m2", "write", { path: "b.ts" }, text("ok", { diff: "+1 c" }));
		act("b1", "bash", { command: "pnpm test" }, text("ok", { exitCode: 0 }));
		act("b2", "bash", { command: "pnpm lint" }, text("ok", { exitCode: 0 }));
		act("f1", "read", { path: "gone.ts" }, text("read: no such file"), true);
		act("f2", "read", { path: "c.ts" }, lines(1));
		const plain = plainRender(panel, 100);
		match(
			plain,
			new RegExp(
				`${GLYPH.toolHeader} explored 1 file, 1 search, 1 directory ✓\\n  │ a\\.ts · \`needle\` in src · src`,
				"u",
			),
		);
		match(
			plain,
			new RegExp(`${GLYPH.classMutate} edited 2 files · \\+2 -1 ✓\\n  │ a\\.ts \\+1 -1 · b\\.ts \\+1 -0`, "u"),
		);
		strictEqual(plain.match(new RegExp(`^\\${GLYPH.classExecute} ran`, "gmu"))?.length, 2, plain);
		match(plain, new RegExp(`${GLYPH.toolHeader} read gone\\.ts ✗`, "u"));
		match(plain, new RegExp(`${GLYPH.toolHeader} read c\\.ts · lines 1-1 of 1 ✓`, "u"));
	});
});

describe("agent invocations", () => {
	/** A settled card by default; a running one passes `pending: true` and gets no receipt. */
	const card = (
		overrides: Partial<Omit<WorkerEntryState, "receipt">> &
			Pick<WorkerEntryState, "assignmentId" | "agentId"> & { receipt?: WorkerEntryState["receipt"] | undefined },
	) => {
		const state = {
			runId: `${overrides.assignmentId}-r1`,
			origin: "agent",
			runtime: { kind: "clio", targetId: "dynamo", wireModelId: "qwen" },
			text: "Found 4 call sites.",
			droppedLines: 0,
			tools: [],
			attempts: [{ runId: `${overrides.assignmentId}-r1`, targetLabel: "dynamo/qwen" }],
			pending: false,
			receipt: { outcome: "succeeded", durationMs: 38_000, tokenCount: 18_200, toolCalls: 7 },
			...overrides,
		} as WorkerEntryState;
		if (state.pending) delete state.receipt;
		return state;
	};
	const dispatchStart = (panel: ChatPanel, id: string, args: unknown) =>
		panel.applyEvent({ type: "tool_execution_start", toolCallId: id, toolName: "dispatch", args } as never);
	const dispatchEnd = (panel: ChatPanel, id: string, receiptCount: number, failedCount = 0) =>
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: id,
			toolName: "dispatch",
			result: {
				content: [{ type: "text", text: `${receiptCount} tasks -> done` }],
				details: { receiptCount, failedCount, runs: [] },
			},
			isError: false,
			durationMs: 38_000,
		} as never);

	it("lets a card under a dispatch call be the run's row: no task, no tally, no body", () => {
		for (const style of ["compact", "standard", "detailed"] as const) {
			const panel = createChatPanel({ getOutputStyle: () => style, now: () => 50_000 });
			panel.applyEvent({ type: "agent_start" } as never);
			const task = "List every call site of retry() and the options each one passes.";
			dispatchStart(panel, "d1", { agent: "scout", task });
			panel.applyWorkerState(
				card({
					assignmentId: "a1",
					agentId: "scout",
					parentToolCallId: "d1",
					pending: true,
					startedAtMs: 40_000,
				}),
			);
			const running = plainRender(panel, 100);
			match(running, new RegExp(`^${GLYPH.workerAgent} delegating to scout ${GLYPH.running}`, "mu"));
			doesNotMatch(running, /List every call site|task ›/u);
			dispatchEnd(panel, "d1", 1);
			const settledRows = plainRender(panel, 100).split("\n");
			strictEqual(settledRows[0], `${GLYPH.workerAgent} delegated to scout ✓ · 38s`, style);
			doesNotMatch(settledRows.join("\n"), /1 ok|quality .*\n.*quality|tasks -> done/u);
		}
	});

	it("lets a shadow helper the model dispatched be the dispatch's row, stating its task once", () => {
		for (const style of ["compact", "standard", "detailed"] as const) {
			const panel = createChatPanel({ getOutputStyle: () => style, now: () => 50_000 });
			panel.applyEvent({ type: "agent_start" } as never);
			const task = "Map every caller of the retry function exported from src/net/retry.js in this repository.";
			dispatchStart(panel, "d1", { agent: "scout", task, target: "blade", model: "dynamo/qwopus" });
			panel.applyWorkerState(
				card({ assignmentId: "s1", agentId: "scout", parentToolCallId: "d1", helper: true, task, startedAtMs: 39_000 }),
			);
			dispatchEnd(panel, "d1", 1);
			const plain = plainRender(panel, 130);
			strictEqual(plain.split("\n")[0], `${GLYPH.workerAgent} delegated to scout ✓ · 38s`, `${style}\n${plain}`);
			strictEqual(plain.split("Map every caller").length, 2, `${style}: the task must appear once\n${plain}`);
			doesNotMatch(plain, /task ›/u);
		}
		// Under a call that is not a dispatch, a helper that ran during the call
		// stays beside the call's own output.
		const panel = createChatPanel({ getOutputStyle: () => "detailed" });
		panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "context",
			args: { scope: "docs", query: "retry" },
		} as never);
		panel.applyWorkerState(card({ assignmentId: "h1", agentId: "context-scout", parentToolCallId: "c1", helper: true }));
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "context",
			result: "Retry docs section body",
			isError: false,
		} as never);
		match(plainRender(panel, 100), /Retry docs section body/u);
	});

	it("keeps one tally row over a fan-out's stacked cards and quality on each card", () => {
		const panel = createChatPanel({ getOutputStyle: () => "standard" });
		panel.applyEvent({ type: "agent_start" } as never);
		dispatchStart(panel, "fan", { tasks: [{ task: "a" }, { task: "b" }, { task: "c" }] });
		for (const index of [0, 1, 2]) {
			panel.applyWorkerState(
				card({
					assignmentId: `f${index}`,
					agentId: "scout",
					parentToolCallId: "fan",
					...(index === 2 ? { receipt: { outcome: "failed", failureMessage: "context overflow", durationMs: 9_000 } } : {}),
				}),
			);
		}
		dispatchEnd(panel, "fan", 3, 1);
		const rows = plainRender(panel, 100).split("\n");
		strictEqual(rows[0], `${GLYPH.workerAgent} delegated 3 tasks · 2 ok, 1 failed ✓ · 38s`);
		strictEqual(rows[1], "", "the cards follow the call as the next entry");
		const cards = rows.filter((row) => row.startsWith(`${GLYPH.workerAgent} scout`));
		strictEqual(cards.length, 3);
		const lastCard = rows.lastIndexOf(cards[2] ?? "");
		ok(!rows.slice(2, lastCard).includes(""), "sibling cards stack with no blank row between them");
		strictEqual(rows.filter((row) => /│ quality /u.test(row)).length, 3);
	});

	it("groups a council round under one header with each member's roster label", () => {
		const panel = createChatPanel({ getOutputStyle: () => "standard" });
		panel.appendUser("/council should retry() own its clock?");
		const members: Array<[string, string, number]> = [
			["Architect", "#7fb2e5", 1],
			["Skeptic", "warning", 1],
			["Architect", "#7fb2e5", 2],
		];
		for (const [index, [label, color, round]] of members.entries()) {
			panel.applyWorkerState(
				card({
					assignmentId: `c${index}`,
					agentId: label.toLowerCase(),
					origin: "user",
					council: { group: "g1", label, color, round },
				}),
			);
		}
		const styled = panel.render(100);
		const rows = styled.map(stripTerminalSequences);
		deepStrictEqual(
			rows.filter((row) => row.startsWith(GLYPH.workerHuman)),
			[`${GLYPH.workerHuman} council · round 1`, `${GLYPH.workerHuman} council · round 2`],
		);
		ok(
			rows.some((row) => row.startsWith("  Architect · dynamo/qwen · run c0-r1 ✓ execution ok")),
			rows.join("\n"),
		);
		ok(
			rows.some((row) => row.startsWith("  Skeptic · dynamo/qwen")),
			rows.join("\n"),
		);
		doesNotMatch(rows.join("\n"), /^. architect|^. skeptic/mu);
		const round1 = rows.indexOf(`${GLYPH.workerHuman} council · round 1`);
		const round2 = rows.indexOf(`${GLYPH.workerHuman} council · round 2`);
		ok(!rows.slice(round1, round2 - 1).includes(""), "one round's members stack under its header");
		// The label is painted in the member's roster color, or its token.
		ok(
			styled.some((row) => row.includes("\u001b[38;2;127;178;229mArchitect") || row.includes("38;5;")),
			styled.join("\n"),
		);
	});

	it("names a failover's attempt in the card header as well as on its rail row", () => {
		const entry = card({
			assignmentId: "b1",
			agentId: "benchmarker",
			attempts: [
				{ runId: "b1-r0", targetLabel: "mini/qwen", outcome: "failed" },
				{ runId: "b1-r1", targetLabel: "dynamo/qwen" },
			],
		});
		const rows = renderWorkerEntryLines(entry, 120, { detail: transcriptDetail("standard") }).map(stripTerminalSequences);
		match(rows[0] ?? "", /run b1-r1 · attempt 2 ✓ execution ok/u);
		ok(
			rows.some((row) => row.includes("↻ failed over → attempt 2 on dynamo/qwen")),
			rows.join("\n"),
		);
	});

	it("keeps a running card's clock on its live line at every width", () => {
		const entry = card({
			assignmentId: "l1",
			agentId: "link-checker",
			pending: true,
			startedAtMs: 1_000,
			progress: {
				revision: 1,
				phase: "tool",
				tailText: "",
				droppedLines: 0,
				droppedBytes: 0,
				processedTokens: 6_200,
				toolCalls: 4,
				currentAction: { tool: "bash", descriptor: { verb: "running", object: "lychee dist/**/*.html --verbose" } },
				recentActions: [],
				toolNames: ["bash"],
				settled: false,
			} as unknown as NonNullable<WorkerEntryState["progress"]>,
		});
		for (const width of [40, 60, 100, 200]) {
			const rows = renderWorkerEntryLines(entry, width, { detail: transcriptDetail("standard"), nowMs: 13_000 }).map(
				stripTerminalSequences,
			);
			match(rows[1] ?? "", /^ {2}│ ⚙ running lychee.* · 12s/u, `${width}: ${rows[1]}`);
			ok(
				rows.every((row) => visibleWidth(row) <= width),
				rows.join("\n"),
			);
		}
		match(
			stripTerminalSequences(renderWorkerEntryLines(entry, 200, { nowMs: 13_000 })[1] ?? ""),
			/⚙ running lychee dist\/\*\*\/\*\.html --verbose · 12s · 6\.2k tokens · 4 calls$/u,
		);
	});
});
