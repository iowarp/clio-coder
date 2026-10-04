/**
 * The worker runs `/share` chooses from, for a host with no chat panel.
 *
 * The terminal folds the dispatch lifecycle into worker blocks through
 * {@link createWorkerStream} and `/share` reads those blocks back. An ACP host
 * has the same bus and the same receipts but no transcript, so it folds the
 * same events into the same stream and keeps only the states, in the order
 * their runs started. Nothing is rendered and nothing is persisted here.
 */

import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { readWorkerReceiptFacts } from "./worker-receipts.js";
import {
	createWorkerStream,
	type WorkerEntryState,
	type WorkerReceiptReader,
	type WorkerStreamChange,
} from "./worker-stream.js";

/** Runs older than this are dropped; `/share` picks from the most recent anyway. */
const MAX_TRACKED_RUNS = 256;

export interface WorkerRunLedger {
	/** Settled and running assignments, oldest first, as the terminal's panel lists them. */
	list(): ReadonlyArray<WorkerEntryState>;
	dispose(): void;
}

export function followWorkerRuns(
	bus: SafeEventBus,
	readReceipt: WorkerReceiptReader = readWorkerReceiptFacts,
): WorkerRunLedger {
	const stream = createWorkerStream({ readReceipt });
	const states = new Map<string, WorkerEntryState>();
	const keep = (change: WorkerStreamChange | null): void => {
		if (change === null) return;
		// A Map keeps first-insertion order, which is the order the runs started.
		states.set(change.entry.assignmentId, change.entry);
		while (states.size > MAX_TRACKED_RUNS) {
			const oldest = states.keys().next().value;
			if (oldest === undefined) break;
			states.delete(oldest);
		}
	};
	const unsubscribers = [
		bus.on(BusChannels.DispatchStarted, (payload) => keep(stream.started(payload))),
		bus.on(BusChannels.DispatchProgress, (payload) => keep(stream.progress(payload))),
		bus.on(BusChannels.DispatchCompleted, (payload) => keep(stream.completed(payload))),
		bus.on(BusChannels.DispatchFailed, (payload) => keep(stream.failed(payload))),
		bus.on(BusChannels.RunAborted, (payload) => keep(stream.aborted(payload))),
	];
	return {
		list: () => [...states.values()],
		dispose: () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		},
	};
}
