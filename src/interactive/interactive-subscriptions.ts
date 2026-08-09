import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";

export type InteractiveNoticeLevel = "info" | "success" | "warning" | "error";

export interface InteractiveSubscriptionsDeps {
	bus: SafeEventBus;
	refreshFooter: () => void;
	renderTaskIsland: () => void;
	renderContextIsland: () => void;
	requestRender: () => void;
	notify: (level: InteractiveNoticeLevel, text: string, key?: string) => void;
}

export interface InteractiveSubscriptions {
	dispose(): void;
}

/**
 * Own the non-modal dispatch and context repaint subscriptions. Bus delivery
 * is synchronous, so each handler deliberately preserves the existing order:
 * refresh data-backed footer state, refresh islands, then request one render.
 */
export function createInteractiveSubscriptions(deps: InteractiveSubscriptionsDeps): InteractiveSubscriptions {
	const unsubscribers = [
		deps.bus.on(BusChannels.DispatchEnqueued, () => {
			deps.refreshFooter();
			deps.renderTaskIsland();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchStarted, () => {
			deps.refreshFooter();
			deps.renderTaskIsland();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchProgress, (payload) => {
			const workerEvent = payload.event as { type?: unknown } | null | undefined;
			if (workerEvent?.type === "clio_steer_received") {
				deps.notify("success", `steer received by ${payload.agentId} (${payload.runId})`, `steer:${payload.runId}`);
			}
			deps.refreshFooter();
			deps.renderTaskIsland();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.RunAborted, () => {
			deps.refreshFooter();
			deps.renderTaskIsland();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchCompleted, () => {
			deps.refreshFooter();
			deps.renderTaskIsland();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchFailed, () => {
			deps.refreshFooter();
			deps.renderTaskIsland();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.ContextActivity, () => {
			deps.refreshFooter();
			deps.renderContextIsland();
			deps.renderTaskIsland();
			deps.requestRender();
		}),
	];

	let disposed = false;
	return {
		dispose(): void {
			if (disposed) return;
			disposed = true;
			for (const unsubscribe of unsubscribers) unsubscribe();
		},
	};
}
