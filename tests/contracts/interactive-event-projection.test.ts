import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels, type LoopBlockedPayload } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { ChatCancelOptions, ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import {
	createInteractiveEventProjection,
	type InteractiveEventProjectionDeps,
} from "../../src/interactive/interactive-event-projection.js";
import type { AgentStatus } from "../../src/interactive/status/index.js";

interface ProjectionHarness {
	deps: InteractiveEventProjectionDeps;
	emitChat(event: ChatLoopEvent): void;
	emitStatus(status: AgentStatus): void;
}

function createHarness(log: string[]): ProjectionHarness {
	const bus = createSafeEventBus();
	const chatHandlers = new Set<(event: ChatLoopEvent) => void>();
	const statusHandlers = new Set<(status: AgentStatus) => void>();
	const deps: InteractiveEventProjectionDeps = {
		bus,
		chat: {
			onEvent: (handler) => {
				chatHandlers.add(handler);
				return () => chatHandlers.delete(handler);
			},
			cancel: (options?: ChatCancelOptions) => log.push(`cancel:${options?.source}:${options?.reason}`),
		},
		status: {
			subscribe: (handler) => {
				statusHandlers.add(handler);
				return () => statusHandlers.delete(handler);
			},
		},
		getTerminalColumns: () => 80,
		now: () => 5_000,
		applyChatEvent: (event) => log.push(`chat:${event.type}`),
		setFollowUpMessages: (messages) => log.push(`queue:${messages.length}`),
		isAskUserWaiting: () => true,
		closeAskUserSession: () => log.push("ask:close"),
		resetAskUserCancellation: () => log.push("ask:reset"),
		recordToolStart: (toolName, toolCallId) => log.push(`tool:start:${toolName}:${toolCallId}`),
		recordToolEnd: (toolName, toolCallId, isError, truncated) =>
			log.push(`tool:end:${toolName}:${toolCallId}:${isError}:${truncated}`),
		setStatusLine: (line) => log.push(line ? `status:${line.phase}:${line.verb}` : "status:null"),
		setLastTurnSummary: () => log.push("summary"),
		startTerminalProgress: () => log.push("progress:start"),
		stopTerminalProgress: () => log.push("progress:stop"),
		refreshLiveWorkspaceGit: (force) => log.push(`git:${force}`),
		refreshFooter: () => log.push("footer"),
		requestRender: () => log.push("render"),
		notify: (level, text, key) => log.push(`notify:${level}:${text}:${key ?? ""}`),
		dismissNotification: (key) => log.push(`dismiss:${key}`),
		appendTranscriptNotice: (level, text) => log.push(`transcript:${level}:${text}`),
		refreshSettingsOverlay: () => log.push("settings:refresh"),
	};
	return {
		deps,
		emitChat: (event) => {
			for (const handler of chatHandlers) handler(event);
		},
		emitStatus: (status) => {
			for (const handler of statusHandlers) handler(status);
		},
	};
}

describe("interactive event projection", () => {
	it("preserves startup, queue, tool, and chat-render ordering", () => {
		const log: string[] = [];
		const harness = createHarness(log);
		harness.deps.initialNotices = ["  keybinding notice: conflict  ", "  "];
		createInteractiveEventProjection(harness.deps);

		harness.emitChat({ type: "queue_update", messages: [] });
		harness.emitChat({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {} });
		harness.emitChat({
			type: "tool_execution_end",
			toolCallId: "tool-2",
			toolName: "ask_user",
			result: { details: { interview: { status: "complete" } } },
			isError: false,
			resultSummary: { truncated: true },
		} as ChatLoopEvent & { resultSummary: { truncated: boolean } });
		harness.emitChat({ type: "tool_execution_start", toolCallId: "dispatch-1", toolName: "Dispatch", args: {} });

		deepStrictEqual(log, [
			"notify:warning:keybinding notice: conflict:startup:keybinding-notice",
			"queue:0",
			"render",
			"tool:start:bash:tool-1",
			"footer",
			"chat:tool_execution_start",
			"ask:close",
			"ask:reset",
			"tool:end:ask_user:tool-2:false:true",
			"footer",
			"chat:tool_execution_end",
			"chat:tool_execution_start",
		]);
	});

	it("projects status before repaint and refreshes terminal facts after final events", () => {
		const log: string[] = [];
		const harness = createHarness(log);
		createInteractiveEventProjection(harness.deps);

		harness.emitStatus({
			phase: "preparing",
			since: 4_000,
			lastMeaningfulAt: 4_000,
			watchdogTier: 0,
			watchdogPeak: 0,
			localRuntime: false,
		});
		harness.emitChat({ type: "agent_end", messages: [] });

		strictEqual(log[1], "footer");
		strictEqual(log[2], "render");
		match(log[0] ?? "", /^status:preparing:.+Preparing harness · 1\.0s$/u);
		deepStrictEqual(log.slice(3), [
			"ask:close",
			"ask:reset",
			"chat:agent_end",
			"progress:stop",
			"git:true",
			"footer",
			"render",
		]);
	});

	it("preserves loop cancellation and context-warning order, then disposes idempotently", () => {
		const log: string[] = [];
		const harness = createHarness(log);
		const projection = createInteractiveEventProjection(harness.deps);
		const blocked: LoopBlockedPayload = {
			tool: "bash",
			repeatCount: 7,
			blocksThisTurn: 4,
			budget: 4,
			interrupted: true,
			disposition: "stop",
			at: 5_000,
		};

		harness.deps.bus.emit(BusChannels.LoopBlocked, blocked);
		harness.deps.bus.emit(BusChannels.ContextWarning, { warning: "context nearly full" });
		projection.disposePrimary();
		harness.deps.bus.emit(BusChannels.ContextWarning, { warning: null });
		harness.emitChat({ type: "agent_end", messages: [] });
		projection.disposeRemaining();
		projection.dispose();
		harness.deps.bus.emit(BusChannels.ContextWarning, { warning: "ignored" });
		harness.emitChat({ type: "agent_end", messages: [] });

		strictEqual(log.length, 12);
		match(log[0] ?? "", /^cancel:loop_guard:/u);
		deepStrictEqual(log.slice(1), [
			"render",
			"notify:warning:context nearly full:context-low-warning",
			"footer",
			"render",
			"dismiss:context-low-warning",
			"footer",
			"render",
			"progress:stop",
			"git:true",
			"footer",
			"render",
		]);
	});
});
