import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BusChannels,
	type DispatchCompletedPayload,
	type DispatchProgressPayload,
	type DispatchStartedPayload,
} from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { type ChatPanel, createChatPanel } from "../../src/interactive/chat-panel.js";
import { createInteractiveSubscriptions } from "../../src/interactive/interactive-subscriptions.js";
import { GLYPH } from "../../src/interactive/theme/index.js";
import type { WorkerReceiptFacts } from "../../src/interactive/worker-stream.js";

const PROGRESS: DispatchProgressPayload = {
	runId: "run-1",
	agentId: "coder",
	event: { type: "clio_steer_received" },
};

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function started(overrides: Partial<DispatchStartedPayload> = {}): DispatchStartedPayload {
	return {
		runId: "run-1",
		agentId: "coder",
		requestOrigin: "user",
		targetId: "mini",
		wireModelId: "Nemo-3.5-Lightning",
		runtimeId: "lmstudio",
		runtimeKind: "http",
		pid: 4242,
		assignmentId: "run-1",
		attempt: 0,
		...overrides,
	};
}

function completed(overrides: Partial<DispatchCompletedPayload> = {}): DispatchCompletedPayload {
	return {
		runId: "run-1",
		agentId: "coder",
		requestOrigin: "user",
		targetId: "mini",
		wireModelId: "Nemo-3.5-Lightning",
		runtimeId: "lmstudio",
		runtimeKind: "http",
		outcome: "succeeded",
		outcomeCode: null,
		outcomeDetail: null,
		lineage: { rootRunId: "run-1", parentRunId: null, attempt: 0, depth: 0 },
		tokenCount: 4800,
		inputTokenCount: 4000,
		outputTokenCount: 800,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		costUsd: 0,
		durationMs: 9600,
		exitCode: 0,
		toolActivity: { calls: 1, succeeded: 1, failed: 0, blocked: 0, mutatingSucceeded: false },
		...overrides,
	};
}

/** A panel wired to the subscriptions exactly as the interactive application wires it. */
function transcriptHarness(receipt: (runId: string) => WorkerReceiptFacts | null = () => null): {
	bus: ReturnType<typeof createSafeEventBus>;
	panel: ChatPanel;
	render: () => string;
	/** The application's one transcript reset: the panel and the fold together. */
	resetTranscript: () => void;
} {
	const bus = createSafeEventBus();
	const panel = createChatPanel({ getToolExpandKey: () => "Ctrl+O" });
	const subscriptions = createInteractiveSubscriptions({
		bus,
		refreshFooter: () => {},
		renderTaskIsland: () => {},
		renderContextIsland: () => {},
		requestRender: () => {},
		notify: () => {},
		applyWorkerState: (state) => panel.applyWorkerState(state),
		readWorkerReceipt: receipt,
	});
	return {
		bus,
		panel,
		render: () => panel.render(96).join("\n").replace(ANSI, ""),
		resetTranscript: () => {
			panel.reset();
			subscriptions.workers.reset();
		},
	};
}

describe("interactive dispatch subscriptions", () => {
	it("preserves progress acknowledgement and repaint ordering", () => {
		const bus = createSafeEventBus();
		const log: string[] = [];
		createInteractiveSubscriptions({
			bus,
			refreshFooter: () => log.push("footer"),
			renderTaskIsland: () => log.push("task"),
			renderContextIsland: () => log.push("context"),
			requestRender: () => log.push("render"),
			notify: (level, text, key) => log.push(`notify:${level}:${text}:${key ?? ""}`),
		});

		bus.emit(BusChannels.DispatchProgress, PROGRESS);

		deepStrictEqual(log, ["notify:success:steer received by coder (run-1):steer:run-1", "footer", "task", "render"]);
	});

	it("folds, places, records, and only then repaints, on every lifecycle channel", () => {
		const bus = createSafeEventBus();
		const log: string[] = [];
		createInteractiveSubscriptions({
			bus,
			refreshFooter: () => log.push("footer"),
			renderTaskIsland: () => log.push("task"),
			renderContextIsland: () => log.push("context"),
			requestRender: () => log.push("render"),
			notify: () => {},
			applyWorkerState: (state) => log.push(`apply:${state.runId}:${state.pending ? "live" : "settled"}`),
			recordWorkerRun: (fields) => log.push(`record:${fields.runId}`),
			readWorkerReceipt: () => null,
		});
		bus.emit(BusChannels.DispatchStarted, started());
		bus.emit(BusChannels.DispatchCompleted, completed());
		// A payload the fold has no block for still repaints the footer and island.
		bus.emit(BusChannels.DispatchCompleted, completed({ runId: "unknown" }));
		deepStrictEqual(log, [
			"apply:run-1:live",
			"record:run-1",
			"footer",
			"task",
			"render",
			"apply:run-1:settled",
			"footer",
			"task",
			"render",
			"footer",
			"task",
			"render",
		]);
	});

	it("refreshes both islands for context activity and unsubscribes idempotently", () => {
		const bus = createSafeEventBus();
		const log: string[] = [];
		const subscriptions = createInteractiveSubscriptions({
			bus,
			refreshFooter: () => log.push("footer"),
			renderTaskIsland: () => log.push("task"),
			renderContextIsland: () => log.push("context"),
			requestRender: () => log.push("render"),
			notify: () => {},
		});
		const payload = {
			kind: "context-init",
			phase: "scan",
			status: "running",
			message: "scanning",
			at: 1,
		} as const;

		bus.emit(BusChannels.ContextActivity, payload);
		subscriptions.dispose();
		subscriptions.dispose();
		bus.emit(BusChannels.ContextActivity, payload);

		deepStrictEqual(log, ["footer", "context", "task", "render"]);
	});

	it("streams a user-origin run into the transcript and seals it from the receipt", () => {
		const h = transcriptHarness((runId) =>
			runId === "run-1"
				? {
						outcome: "succeeded",
						tokenCount: 4800,
						durationMs: 9600,
						contract: "pass",
						text: "Hello! I'm the coder worker.",
					}
				: null,
		);

		h.bus.emit(BusChannels.DispatchStarted, started());
		h.bus.emit(BusChannels.DispatchProgress, {
			runId: "run-1",
			agentId: "coder",
			event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello!" } },
		});
		h.bus.emit(BusChannels.DispatchProgress, {
			runId: "run-1",
			agentId: "coder",
			event: { type: "clio_tool_start", payload: { tool: "read" } },
		});
		const live = h.render();
		ok(live.includes(`${GLYPH.workerHuman} coder · mini/Nemo-3.5-Lightning · run run-1`), live);
		ok(live.includes("│ Hello!"), live);
		ok(live.includes(`│ ${GLYPH.phaseTool} read`), live);
		ok(live.includes("└ ● running"), live);

		h.bus.emit(BusChannels.DispatchCompleted, completed());
		const settled = h.render();
		// The sealed receipt is the terminal truth: its answer replaces the live
		// tail and its facts are what the footer reports.
		ok(settled.includes("│ Hello! I'm the coder worker."), settled);
		ok(settled.includes(`└ ${GLYPH.ok} ok · 4.8k tok · 9.6s · contract pass`), settled);
	});

	it("clears the fold with the transcript, so an old session's run neither reappears nor is shareable", () => {
		const h = transcriptHarness((runId) => ({ outcome: "succeeded", text: `answer from ${runId}` }));
		h.bus.emit(BusChannels.DispatchStarted, started({ runId: "old", assignmentId: "old" }));
		h.bus.emit(BusChannels.DispatchCompleted, completed({ runId: "old" }));
		h.bus.emit(BusChannels.DispatchStarted, started({ runId: "live", assignmentId: "live" }));
		strictEqual(h.panel.workerStates().length, 2);

		h.resetTranscript();
		deepStrictEqual(h.panel.workerStates(), [], "nothing of the old session is left to share");
		// The old session's run keeps going in the process; its events find no block.
		h.bus.emit(BusChannels.DispatchProgress, {
			runId: "live",
			agentId: "coder",
			event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "late" } },
		});
		h.bus.emit(BusChannels.DispatchCompleted, completed({ runId: "live" }));
		strictEqual(h.render().trim(), "", `an old-session event repainted into the new transcript:\n${h.render()}`);

		// A run started after the reset is this session's, and shareable.
		h.bus.emit(BusChannels.DispatchStarted, started({ runId: "new", assignmentId: "new" }));
		h.bus.emit(BusChannels.DispatchCompleted, completed({ runId: "new" }));
		deepStrictEqual(
			h.panel.workerStates().map((state) => `${state.runId}:${state.text}`),
			["new:answer from new"],
		);
	});

	it("keeps internal-origin runs off the transcript", () => {
		const h = transcriptHarness();
		h.bus.emit(
			BusChannels.DispatchStarted,
			started({ runId: "wiki-1", assignmentId: "wiki-1", requestOrigin: "internal" }),
		);
		h.bus.emit(BusChannels.DispatchProgress, {
			runId: "wiki-1",
			agentId: "coder",
			event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "indexing" } },
		});
		h.bus.emit(BusChannels.DispatchCompleted, completed({ runId: "wiki-1", requestOrigin: "internal" }));
		strictEqual(h.render().trim(), "");
	});

	it("nests an agent-driven fan-out under the dispatch tool segment as folded cards", () => {
		const h = transcriptHarness((runId) => ({ outcome: "succeeded", text: `answer from ${runId}`, durationMs: 41_000 }));
		h.panel.appendUser("find the slow path");
		h.panel.applyEvent({ type: "text_delta", delta: "Scouting the repository." } as ChatLoopEvent);
		h.panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "dispatch",
			args: { mode: "parallel" },
		} as ChatLoopEvent);
		for (const index of [1, 2, 3]) {
			h.bus.emit(
				BusChannels.DispatchStarted,
				started({
					runId: `s${index}`,
					assignmentId: `s${index}`,
					agentId: `scout-${index}`,
					requestOrigin: "agent",
					targetId: "zbook",
					wireModelId: "gemma-4-26b",
					parentToolCallId: "call_1",
				}),
			);
		}
		for (const index of [1, 2, 3]) {
			h.bus.emit(
				BusChannels.DispatchCompleted,
				completed({ runId: `s${index}`, agentId: `scout-${index}`, requestOrigin: "agent", durationMs: 41_000 }),
			);
		}
		h.panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "call_1",
			toolName: "dispatch",
			args: { mode: "parallel" },
			result: "3 scouts finished",
			isError: false,
		} as ChatLoopEvent);
		h.panel.applyEvent({ type: "text_delta", delta: "Three scouts are back." } as ChatLoopEvent);

		const rendered = h.render();
		const rows = rendered.split("\n");
		const callRow = rows.findIndex((row) => row.includes("tool action"));
		const cardRows = [1, 2, 3].map((index) =>
			rows.findIndex((row) => row.includes(`${GLYPH.workerAgent} scout-${index}`)),
		);
		deepStrictEqual(
			cardRows,
			[cardRows[0], (cardRows[0] ?? 0) + 1, (cardRows[0] ?? 0) + 2],
			`three cards, three consecutive rows, in spawn order:\n${rendered}`,
		);
		ok(callRow >= 0 && callRow < (cardRows[0] ?? -1), `cards sit under the call:\n${rendered}`);
		ok(!rendered.includes("dispatch("), `the live header stays tool-neutral:\n${rendered}`);
		ok(!rendered.includes("answer from s1"), `folded by default:\n${rendered}`);
		// One chord, one target. The tool segment stops advertising the key once a
		// worker card behind it is what the key would reach.
		strictEqual(rendered.split("Ctrl+O").length - 1, 1, `exactly one expand hint:\n${rendered}`);
		ok(rows[cardRows[2] ?? 0]?.endsWith("(Ctrl+O)"), `the hint is on the newest card:\n${rendered}`);

		strictEqual(h.panel.toggleLastToolExpanded(), true);
		const expanded = h.render();
		ok(expanded.includes("│ answer from s3"), expanded);
		ok(!expanded.includes("answer from s2"), `only the targeted card opened:\n${expanded}`);
	});
});
