import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BusChannels,
	type DispatchCompletedPayload,
	type DispatchProgressPayload,
	type DispatchStartedPayload,
} from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
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
	render: () => string;
} {
	const bus = createSafeEventBus();
	const panel = createChatPanel();
	createInteractiveSubscriptions({
		bus,
		refreshFooter: () => {},
		renderTaskIsland: () => {},
		renderContextIsland: () => {},
		requestRender: () => {},
		notify: () => {},
		applyWorkerState: (state) => panel.applyWorkerState(state),
		readWorkerReceipt: receipt,
	});
	return { bus, render: () => panel.render(96).join("\n").replace(ANSI, "") };
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
		ok(live.includes(`${GLYPH.workerHuman} you → coder · mini/Nemo-3.5-Lightning · run run-1`), live);
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
});
