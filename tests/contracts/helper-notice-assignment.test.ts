import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createNotificationCenter } from "../../src/interactive/footer/notifications.js";
import { createInteractiveSubscriptions } from "../../src/interactive/interactive-subscriptions.js";

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
