import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels, type DispatchProgressPayload } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { createInteractiveSubscriptions } from "../../src/interactive/interactive-subscriptions.js";

const PROGRESS: DispatchProgressPayload = {
	runId: "run-1",
	agentId: "coder",
	event: { type: "clio_steer_received" },
};

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
});
