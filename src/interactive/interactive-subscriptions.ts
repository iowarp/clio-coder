import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { readWorkerReceiptFacts } from "./worker-receipts.js";
import {
	createWorkerStream,
	type WorkerEntryState,
	type WorkerReceiptFacts,
	type WorkerStream,
	type WorkerStreamChange,
} from "./worker-stream.js";

export type InteractiveNoticeLevel = "info" | "success" | "warning" | "error";

export interface InteractiveSubscriptionsDeps {
	bus: SafeEventBus;
	refreshFooter: () => void;
	renderTaskIsland: () => void;
	renderContextIsland: () => void;
	requestRender: () => void;
	notify: (level: InteractiveNoticeLevel, text: string, key?: string) => void;
	/**
	 * Place or refresh a worker's transcript block. Optional because a host
	 * without a chat panel still wants the footer and island repaints; when it is
	 * absent the fold still runs, so `/share` can find a finished run either way.
	 */
	applyWorkerState?: (state: WorkerEntryState) => void;
	/** Sealed-receipt reader, injected by tests. Defaults to `<state>/receipts/<runId>.json`. */
	readWorkerReceipt?: (runId: string) => WorkerReceiptFacts | null;
}

export interface InteractiveSubscriptions {
	/** Live worker blocks folded from the dispatch lifecycle, keyed by assignment. */
	workers: WorkerStream;
	dispose(): void;
}

/**
 * Own the non-modal dispatch and context repaint subscriptions. Bus delivery
 * is synchronous, so each handler deliberately preserves the existing order:
 * fold the worker block, refresh data-backed footer state, refresh islands,
 * then request one render. The worker fold runs first because the render it
 * asks for has to show the delta that arrived with the event.
 */
export function createInteractiveSubscriptions(deps: InteractiveSubscriptionsDeps): InteractiveSubscriptions {
	const workers = createWorkerStream({ readReceipt: deps.readWorkerReceipt ?? readWorkerReceiptFacts });
	const applyWorker = (change: WorkerStreamChange | null): void => {
		if (change !== null) deps.applyWorkerState?.(change.entry);
	};
	const unsubscribers = [
		deps.bus.on(BusChannels.DispatchEnqueued, () => {
			deps.refreshFooter();
			deps.renderTaskIsland();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchStarted, (payload) => {
			applyWorker(workers.started(payload));
			deps.refreshFooter();
			deps.renderTaskIsland();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchProgress, (payload) => {
			const workerEvent = payload.event as { type?: unknown } | null | undefined;
			if (workerEvent?.type === "clio_steer_received") {
				deps.notify("success", `steer received by ${payload.agentId} (${payload.runId})`, `steer:${payload.runId}`);
			}
			applyWorker(workers.progress(payload));
			deps.refreshFooter();
			deps.renderTaskIsland();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.RunAborted, (payload) => {
			applyWorker(workers.aborted(payload));
			deps.refreshFooter();
			deps.renderTaskIsland();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchCompleted, (payload) => {
			applyWorker(workers.completed(payload));
			deps.refreshFooter();
			deps.renderTaskIsland();
			deps.requestRender();
		}),
		deps.bus.on(BusChannels.DispatchFailed, (payload) => {
			applyWorker(workers.failed(payload));
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
		workers,
		dispose(): void {
			if (disposed) return;
			disposed = true;
			for (const unsubscribe of unsubscribers) unsubscribe();
		},
	};
}
