import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkerRunEntry } from "../../src/domains/session/index.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { type ChatPanel, createChatPanel } from "../../src/interactive/chat-panel.js";
import { renderWorkerEntryLines } from "../../src/interactive/renderers/worker-entry.js";
import {
	createWorkerProgressFold,
	WORKER_ACTION_TRAIL_LIMIT,
	WORKER_TOOL_NAME_LIMIT,
} from "../../src/interactive/worker-progress.js";
import { workerEntriesFromRunEntries } from "../../src/interactive/worker-replay.js";
import { createWorkerStream, type WorkerReceiptFacts } from "../../src/interactive/worker-stream.js";

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
		const firstReasoning = rendered.indexOf("Thinking…");
		const before = rendered.indexOf("before tool");
		const tool = rendered.indexOf("tool-command");
		const secondReasoning = rendered.indexOf("Thinking…", firstReasoning + 1);
		const after = rendered.indexOf("after tool");
		ok(firstReasoning >= 0, "first reasoning marker should render");
		ok(firstReasoning < before && before < tool && tool < secondReasoning && secondReasoning < after, rendered);
	});

	it("toggles the latest reasoning stretch while a tool remains live", () => {
		const panel = createChatPanel({ now: () => 1_000 });
		panel.applyEvent({
			type: "thinking_delta",
			contentIndex: 0,
			delta: "private reasoning body",
			partialThinking: "private reasoning body",
		});
		startTool(panel);

		strictEqual(panel.toggleLastThinking(), true);
		const expanded = plainRender(panel);
		match(expanded, /private reasoning body/u);
		match(expanded, /tool-command/u);

		strictEqual(panel.toggleLastThinking(), true);
		const folded = plainRender(panel);
		doesNotMatch(folded, /private reasoning body/u);
		match(folded, /Thinking…/u);
		match(folded, /tool-command/u);
	});

	it("replaces cumulative partials and re-expands at the latest state", () => {
		const panel = createChatPanel({ getOutputVerbosity: () => "verbose", now: () => 1_000 });
		startTool(panel);
		updateTool(panel, "obsolete snapshot");
		match(plainRender(panel), /obsolete snapshot/u);

		updateTool(panel, "replacement snapshot");
		const replaced = plainRender(panel);
		doesNotMatch(replaced, /obsolete snapshot/u);
		match(replaced, /replacement snapshot/u);

		strictEqual(panel.toggleLastToolExpanded(), true);
		updateTool(panel, "latest while folded");
		const folded = plainRender(panel);
		doesNotMatch(folded, /replacement snapshot|latest while folded/u);

		strictEqual(panel.toggleLastToolExpanded(), true);
		const reExpanded = plainRender(panel);
		doesNotMatch(reExpanded, /replacement snapshot/u);
		match(reExpanded, /latest while folded/u);
	});

	it("treats live-output pause as presentation-only", () => {
		const panel = createChatPanel({ getOutputVerbosity: () => "verbose", now: () => 1_000 });
		startTool(panel);
		updateTool(panel, "visible before pause");

		strictEqual(panel.toggleLiveToolOutput(), false);
		updateTool(panel, "accepted while paused");
		const paused = plainRender(panel);
		match(paused, /live output paused/u);
		doesNotMatch(paused, /visible before pause|accepted while paused/u);

		strictEqual(panel.toggleLiveToolOutput(), true);
		const resumed = plainRender(panel);
		match(resumed, /accepted while paused/u);
		doesNotMatch(resumed, /visible before pause/u);
	});

	it("clears partial state at terminal settlement and ignores late updates", () => {
		const panel = createChatPanel({ getOutputVerbosity: () => "verbose", now: () => 1_000 });
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
		deepStrictEqual(
			renderWorkerEntryLines(completed.entry, 120, { folded: false }),
			renderWorkerEntryLines(replayed, 120, { folded: false }),
		);
	});
});
