import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { readWorkerReceiptFacts } from "./worker-receipts.js";
import { type WorkerRunEntryFields, workerRunEntryFields } from "./worker-replay.js";
import {
	createWorkerStream,
	type WorkerEntryState,
	type WorkerReceiptReader,
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
	 * Place or refresh a worker's transcript block. Optional only so a host
	 * without a chat panel still gets the footer and island repaints. Without it
	 * no block is placed and nothing is shareable, because `/share` reads
	 * `chatPanel.workerStates()`. Tests rely on the contract staying optional.
	 */
	applyWorkerState?: (state: WorkerEntryState) => void;
	/**
	 * Record one attempt of a transcript-bound run in the session ledger, so a
	 * resumed session can redraw the block from the entry plus its receipt.
	 * Called where the block opens and once per failover; absent hosts simply
	 * do not persist, which costs replay and nothing else. The argument is a
	 * snapshot, not the live block, so a host that defers the write records the
	 * attempt it was handed.
	 */
	recordWorkerRun?: (fields: WorkerRunEntryFields) => void;
	/** Sealed-receipt reader, injected by tests. Defaults to `<state>/receipts/<runId>.json`. */
	readWorkerReceipt?: WorkerReceiptReader;
	/**
	 * A dispatch run reached a terminal state. The desktop notification uses it
	 * to look for a detached batch that settled with this run; nothing else
	 * derives state from it.
	 */
	onDispatchSettled?: () => void;
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
	const repaint = (): void => {
		deps.refreshFooter();
		deps.renderTaskIsland();
		deps.requestRender();
	};
	/** Fold one lifecycle payload into its worker block, place the block, then repaint. */
	const folded =
		<P>(reduce: (payload: P) => WorkerStreamChange | null, after?: (change: WorkerStreamChange) => void) =>
		(payload: P): void => {
			const change = reduce(payload);
			if (change !== null) {
				deps.applyWorkerState?.(change.entry);
				after?.(change);
			}
			repaint();
		};
	const unsubscribers = [
		deps.bus.on(BusChannels.DispatchEnqueued, repaint),
		// Every attempt writes its own session entry: a failover is history, and
		// the attempt trail a resumed block shows is that history read back.
		deps.bus.on(
			BusChannels.DispatchStarted,
			folded(workers.started, (change) => deps.recordWorkerRun?.(workerRunEntryFields(change.entry))),
		),
		deps.bus.on(
			BusChannels.DispatchProgress,
			folded((payload) => {
				const workerEvent = payload.event as { type?: unknown } | null | undefined;
				if (workerEvent?.type === "clio_coder_steer_received") {
					deps.notify("success", `steer received by ${payload.agentId} (${payload.runId})`, `steer:${payload.runId}`);
				}
				return workers.progress(payload);
			}),
		),
		deps.bus.on(BusChannels.RunAborted, folded(workers.aborted)),
		deps.bus.on(BusChannels.DispatchCompleted, (payload) => {
			folded(workers.completed)(payload);
			deps.onDispatchSettled?.();
		}),
		deps.bus.on(BusChannels.DispatchFailed, (payload) => {
			folded(workers.failed)(payload);
			deps.onDispatchSettled?.();
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
