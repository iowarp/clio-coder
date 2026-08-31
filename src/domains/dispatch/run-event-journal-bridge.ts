/**
 * Domain-owned writer for the run event journal.
 *
 * The journal was originally teed from `createDispatchRunEventRegistry`
 * (src/tools/dispatch-run-events.ts), the display-tail helper behind the
 * model-facing `dispatch` tool. That helper is not on the operator paths:
 * `clio-coder run --agent` (src/cli/run.ts), `clio-coder fleet run`
 * (src/cli/fleet.ts), and the TUI `/run` slash command each take a handle
 * straight off `DispatchContract.dispatch` and iterate `handle.events`
 * themselves, so no registry is ever built and the sink never fired. The
 * writer had to move to something every dispatch reaches.
 *
 * `BusChannels.DispatchProgress` is that thing. The dispatch domain publishes
 * it from inside the event pump for every consumer-visible event of every run,
 * "attached, detached, batched, and retry runs, exactly once" (see
 * src/core/bus-events.ts), whether or not anyone iterates the handle. The
 * terminal pair `DispatchCompleted`/`DispatchFailed` closes every run the same
 * way. Subscribing here makes the journal a property of dispatching, not of
 * which caller happened to build a registry.
 *
 * Ownership is explicit rather than ambient: the bridge attaches only when a
 * composition root asks for it (`DispatchBundleOptions.journalRunEvents`), and
 * `registerAllTools` hands its registry `journal: null` in that same process.
 * One writer per file, decided at one place, so a tool-path run in the TUI is
 * not transcribed twice.
 *
 * Every write is best-effort. The sink degrades itself on I/O failure and a
 * listener that throws is contained by the safe bus, so nothing here can fail a
 * dispatch.
 */

import type {
	DispatchCompletedPayload,
	DispatchFailedPayload,
	DispatchProgressPayload,
} from "../../core/bus-events.js";
import { BusChannels } from "../../core/bus-events.js";
import type { SafeEventBus } from "../../core/event-bus.js";
import { runTailEntryFromEvent } from "../../tools/dispatch-run-events.js";
import { defaultRunEventJournal, type RunEventJournalSink } from "./run-event-journal.js";

/**
 * Runs whose `open` line this bridge has already written. Bounded so a
 * long-lived orchestrator cannot grow it without limit; the journal writer
 * keeps its own bound for the same reason. Evicting a run only forgets that it
 * was opened, and a later event for it writes a second `open` line, which the
 * reader and the writer both tolerate.
 */
const OPENED_RUN_LIMIT = 512;

export interface RunEventJournalBridge {
	/** Unsubscribe from the bus. Idempotent. */
	stop(): void;
}

export interface AttachRunEventJournalBridgeOptions {
	/** Sink override; defaults to the process-wide journal. */
	journal?: RunEventJournalSink;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runIdentity(payload: unknown): { runId: string; agentId: string } | null {
	if (!isRecord(payload)) return null;
	if (typeof payload.runId !== "string" || payload.runId.length === 0) return null;
	return { runId: payload.runId, agentId: typeof payload.agentId === "string" ? payload.agentId : "unknown" };
}

/**
 * Subscribe the journal to a dispatch bus. Returns a handle whose `stop()` the
 * owning bundle calls on shutdown so a second bundle in the same process (tests
 * do this) never inherits the first one's listeners.
 */
export function attachRunEventJournalBridge(
	bus: SafeEventBus,
	options: AttachRunEventJournalBridgeOptions = {},
): RunEventJournalBridge {
	const journal = options.journal ?? defaultRunEventJournal();
	const opened = new Set<string>();

	const ensureOpen = (runId: string, agentId: string): void => {
		if (opened.has(runId)) return;
		opened.add(runId);
		while (opened.size > OPENED_RUN_LIMIT) {
			const oldest = opened.values().next();
			if (oldest.done === true) break;
			opened.delete(oldest.value);
		}
		journal.open(runId, agentId);
	};

	/**
	 * Write the receipt facts and close the run. Read defensively for the same
	 * reason the registry's seal is: a terminal payload that is missing a field
	 * it is typed to have must degrade the transcript, never throw back into the
	 * finalizer that emitted it.
	 */
	const seal = (outcome: string, detail: string | null | undefined, payload: unknown): void => {
		const identity = runIdentity(payload);
		if (identity === null) return;
		ensureOpen(identity.runId, identity.agentId);
		const exitCode = isRecord(payload) && typeof payload.exitCode === "number" ? payload.exitCode : null;
		journal.receipt(identity.runId, { outcome, exitCode });
		journal.terminal(identity.runId, outcome, detail ?? undefined);
		opened.delete(identity.runId);
	};

	const unsubscribes = [
		bus.on(BusChannels.DispatchProgress, (payload: DispatchProgressPayload) => {
			const identity = runIdentity(payload);
			if (identity === null) return;
			// The display projection decides what a transcript line is; a
			// heartbeat or a streaming delta is not one. Opening the run only
			// once an event survives that filter keeps a heartbeat-only run from
			// creating an empty journal directory.
			const entry = runTailEntryFromEvent(payload.event);
			if (entry === null) return;
			ensureOpen(identity.runId, identity.agentId);
			// Route resolution warnings use `message`, while worker transcript
			// events generally project their text through `detail`. Preserve the
			// warning at this dispatch-owned durability seam so fleet view does not
			// render a content-free `route_warning` line.
			const message =
				isRecord(payload.event) && typeof payload.event.message === "string" ? payload.event.message : undefined;
			journal.append(
				identity.runId,
				entry.detail === undefined && message !== undefined ? { ...entry, detail: message } : entry,
			);
		}),
		bus.on(BusChannels.DispatchCompleted, (payload: DispatchCompletedPayload) => {
			seal(payload.outcome, payload.outcomeDetail, payload);
		}),
		bus.on(BusChannels.DispatchFailed, (payload: DispatchFailedPayload) => {
			seal(payload.outcome, payload.outcomeDetail, payload);
		}),
	];

	let stopped = false;
	return {
		stop(): void {
			if (stopped) return;
			stopped = true;
			for (const unsubscribe of unsubscribes) unsubscribe();
			opened.clear();
		},
	};
}
