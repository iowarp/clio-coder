import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createInteractiveEventProjection } from "../../src/interactive/interactive-event-projection.js";
import { createInteractiveSubscriptions } from "../../src/interactive/interactive-subscriptions.js";

test("internal helpers announce work and failures through notices without requiring a transcript island", () => {
	const bus = createSafeEventBus();
	const notices: string[] = [];
	let islands = 0;
	const noop = (): void => undefined;
	const subscriptions = createInteractiveSubscriptions({
		bus,
		refreshFooter: noop,
		renderTaskIsland: noop,
		renderContextIsland: noop,
		requestRender: noop,
		notify: (_level, text) => notices.push(text),
		applyWorkerState: () => {
			islands += 1;
		},
	});
	const identity = {
		runId: "helper-1",
		agentId: "context-bootstrap",
		agentAudience: "internal" as const,
		requestOrigin: "internal" as const,
		targetId: "local",
		wireModelId: "model",
		runtimeId: "openai-compat",
		runtimeKind: "http" as const,
	};
	bus.emit(BusChannels.DispatchStarted, { ...identity, pid: null, assignmentId: "helper-1", attempt: 0 });
	bus.emit(BusChannels.DispatchFailed, {
		...identity,
		outcome: "failed",
		outcomeDetail: "Invalid handoff",
		reason: "failed",
	});
	deepStrictEqual(notices, [
		"Clio → context-bootstrap · working · run helper-1",
		"Clio → context-bootstrap · failed · run helper-1",
	]);
	strictEqual(islands, 0);
	subscriptions.dispose();
	bus.emit(BusChannels.DispatchStarted, { ...identity, pid: null, assignmentId: "helper-1", attempt: 0 });
	strictEqual(notices.length, 2);
});

test("S3-01: live hook trust diagnostics reach the footer notice area and unsubscribe on disposal", () => {
	const bus = createSafeEventBus();
	const notices: Array<{ level: string; text: string }> = [];
	let renders = 0;
	const noop = (): void => undefined;
	const projection = createInteractiveEventProjection({
		bus,
		chat: { onEvent: () => noop, cancel: noop },
		status: { subscribe: () => noop },
		getTerminalColumns: () => 80,
		applyChatEvent: noop,
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
		requestRender: () => {
			renders += 1;
		},
		notify: (level, text) => notices.push({ level, text }),
		dismissNotification: noop,
		appendTranscriptNotice: () => {
			throw new Error("routine diagnostics must not spill into the transcript");
		},
		refreshSettingsOverlay: noop,
	});
	const message = "/workspace/.clio-coder/hooks.yaml: project hook trust was revoked; hook skipped";
	bus.emit(BusChannels.ExtensionsLoadIssue, { message });
	deepStrictEqual(notices, [{ level: "warning", text: message }]);
	strictEqual(renders, 1);
	projection.dispose();
	bus.emit(BusChannels.ExtensionsLoadIssue, { message });
	strictEqual(notices.length, 1);
});
