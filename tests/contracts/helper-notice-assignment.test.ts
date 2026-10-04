import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createNotificationCenter } from "../../src/interactive/footer/notifications.js";
import { createInteractiveEventProjection } from "../../src/interactive/interactive-event-projection.js";
import { createInteractiveSubscriptions } from "../../src/interactive/interactive-subscriptions.js";
import type { ChatLoopEvent } from "../../src/session-control/chat-loop.js";

const identity = {
	agentId: "scout",
	agentAudience: "shadow" as const,
	requestOrigin: "agent" as const,
	targetId: "inception",
	wireModelId: "mercury-2.5",
	runtimeId: "inception",
	runtimeKind: "http" as const,
};

function footer() {
	const bus = createSafeEventBus();
	const notifications = createNotificationCenter();
	const noop = (): void => undefined;
	const subscriptions = createInteractiveSubscriptions({
		bus,
		refreshFooter: noop,
		renderTaskIsland: noop,
		renderContextIsland: noop,
		requestRender: noop,
		notify: (level, text, key) => {
			notifications.add(key ? { level, text, key } : { level, text });
		},
	});
	const shown = () => notifications.list().map((notice) => `${notice.level}: ${notice.text}`);
	return { bus, shown, dispose: () => subscriptions.dispose() };
}

test("a retried helper leaves the footer on its assignment's terminal state and run", () => {
	const { bus, shown, dispose } = footer();
	try {
		bus.emit(BusChannels.DispatchStarted, { ...identity, runId: "run-a", pid: null, assignmentId: "run-a", attempt: 0 });
		bus.emit(BusChannels.DispatchFailed, {
			...identity,
			runId: "run-a",
			outcome: "failed",
			outcomeDetail: null,
			reason: "failed",
		});
		deepStrictEqual(shown(), ["warning: Clio-Coder → Scout · failed · run run-a"]);
		bus.emit(BusChannels.DispatchStarted, { ...identity, runId: "run-b", pid: null, assignmentId: "run-a", attempt: 1 });
		deepStrictEqual(shown(), ["info: Clio-Coder → Scout · working · run run-b"]);
		bus.emit(BusChannels.DispatchCompleted, { ...identity, runId: "run-b", outcome: "succeeded" } as never);
		deepStrictEqual(shown(), ["success: Clio-Coder → Scout · completed · run run-b"]);
	} finally {
		dispose();
	}
});

test("parallel helpers keep one notice each", () => {
	const { bus, shown, dispose } = footer();
	try {
		for (const runId of ["run-a", "run-c"])
			bus.emit(BusChannels.DispatchStarted, { ...identity, runId, pid: null, assignmentId: runId, attempt: 0 });
		bus.emit(BusChannels.DispatchFailed, {
			...identity,
			runId: "run-c",
			outcome: "failed",
			outcomeDetail: null,
			reason: "failed",
		});
		deepStrictEqual(shown(), [
			"warning: Clio-Coder → Scout · failed · run run-c",
			"info: Clio-Coder → Scout · working · run run-a",
		]);
	} finally {
		dispose();
	}
});

test("context generators use the composer progress rail without helper notices or transcript blocks", () => {
	const { bus, shown, dispose } = footer();
	try {
		bus.emit(BusChannels.DispatchStarted, {
			...identity,
			agentId: "context-bootstrap",
			agentAudience: "internal",
			requestOrigin: "internal",
			runId: "context-run",
			pid: null,
			assignmentId: "context-run",
			attempt: 0,
		});
		bus.emit(BusChannels.DispatchCompleted, {
			...identity,
			agentId: "context-bootstrap",
			agentAudience: "internal",
			requestOrigin: "internal",
			runId: "context-run",
			outcome: "succeeded",
		} as never);
		deepStrictEqual(shown(), []);
	} finally {
		dispose();
	}
});

test("context reduction status uses the footer while errors retain transcript evidence", () => {
	const noop = (): void => undefined;
	const handlers: Array<(event: ChatLoopEvent) => void> = [];
	const ingress = (event: ChatLoopEvent): void => {
		for (const handler of handlers) handler(event);
	};
	const transcript: ChatLoopEvent[] = [];
	const footer: string[] = [];
	let helperDismissals = 0;
	const projection = createInteractiveEventProjection({
		bus: createSafeEventBus(),
		chat: {
			onEvent: (handler) => {
				handlers.push(handler);
				return noop;
			},
			cancel: noop,
		},
		status: { subscribe: () => noop },
		getTerminalColumns: () => 80,
		applyChatEvent: (event) => transcript.push(event),
		setFollowUpMessages: noop,
		isAskUserWaiting: () => false,
		closeAskUserSession: noop,
		resetAskUserCancellation: noop,
		recordToolStart: noop,
		recordToolEnd: noop,
		setLastTurnSummary: noop,
		startTerminalProgress: noop,
		stopTerminalProgress: noop,
		refreshLiveWorkspaceGit: noop,
		refreshFooter: noop,
		requestRender: noop,
		notify: (_level, text) => footer.push(text),
		dismissNotification: noop,
		dismissHelperNotifications: () => {
			helperDismissals += 1;
		},
		appendTranscriptNotice: noop,
		refreshSettingsOverlay: noop,
	});
	const status = {
		type: "notice",
		level: "info",
		surface: "transcript",
		text: "[context engine] llm_summary: 12 messages summarized",
	} as const;
	ingress(status);
	deepStrictEqual(footer, [status.text]);
	deepStrictEqual(transcript, []);
	const failure = { ...status, level: "error" as const, text: "[context engine] checkpoint failed" };
	ingress(failure);
	deepStrictEqual(transcript, [failure]);
	ingress({ type: "agent_start" } as ChatLoopEvent);
	deepStrictEqual(helperDismissals, 1);
	projection.dispose();
});
