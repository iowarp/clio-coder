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
 *
 * The lines it writes are the feed the workers dashboard streams from, so they
 * carry more than the display tail does: a tool call's start and finish with
 * its redacted descriptor, outcome and duration, the tokens each model call
 * processed, a reasoning block opening (never its content), approvals and
 * refusals, and the worker's prose. Prose arrives as streaming deltas, which
 * are coalesced per run into one line per {@link TEXT_COALESCE_MS} rather than
 * one line per token. Coalescing needs no timer: a buffer is written when the
 * next delta lands past the window, when any other event arrives, and before
 * the run seals, so a finished process holds no handle and a sealed run has no
 * text left behind. Lifecycle noise the richer lines already cover
 * (`tool_execution_*`, message and turn boundaries) is not written at all.
 */

import type {
	DispatchCompletedPayload,
	DispatchFailedPayload,
	DispatchProgressPayload,
} from "../../core/bus-events.js";
import { BusChannels } from "../../core/bus-events.js";
import type { SafeEventBus } from "../../core/event-bus.js";
import { normalizeClioCoderEventRecord } from "../../core/naming-events.js";
import { runTailEntryFromEvent } from "../../tools/dispatch-run-events.js";
import { truncateUtf8 } from "../../tools/truncate-utf8.js";
import { isThinkingEvent, workerTextDelta } from "../observability/worker-progress.js";
import { defaultRunEventJournal, type RunEventJournalEntry, type RunEventJournalSink } from "./run-event-journal.js";

/** Window one coalesced prose line covers. A viewer polls at the same cadence. */
export const TEXT_COALESCE_MS = 250;
/** A coalesced prose line is written early once it holds this much. */
const TEXT_CHUNK_MAX_BYTES = 4096;
/** Bytes kept of a reason or a call object; the viewer bounds its rows again. */
const FACT_MAX_BYTES = 240;

/**
 * Events the feed does not write. Each is either covered by a richer line
 * (`clio_coder_tool_*` for `tool_execution_*`, coalesced prose for deltas) or
 * is a boundary with nothing an operator reads in it. `tool_execution_*` also
 * carries the call's literal arguments, which never belong on disk here.
 */
const UNJOURNALED_TYPES = new Set([
	"heartbeat",
	"message_start",
	"message_update",
	"text_delta",
	"thinking_delta",
	"turn_start",
	"turn_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

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
	/** Skip projection when neither history nor explicit recording needs this run. */
	acceptRun?: (runId: string) => boolean;
	/** Sink override; defaults to the process-wide journal. */
	journal?: RunEventJournalSink;
	/** Monotonic clock for the coalescing window; tests pin it. */
	nowMs?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runIdentity(payload: unknown): { runId: string; agentId: string } | null {
	if (!isRecord(payload)) return null;
	if (typeof payload.runId !== "string" || payload.runId.length === 0) return null;
	return { runId: payload.runId, agentId: typeof payload.agentId === "string" ? payload.agentId : "unknown" };
}

function boundedText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text.length === 0 ? undefined : truncateUtf8(text, FACT_MAX_BYTES, "…");
}

function finiteCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

/**
 * The feed line for a `clio_coder_tool_start` or `clio_coder_tool_finish`
 * event: the tool, its correlation id, and the descriptor the tool-admission
 * seam composed from the arguments (its verb, and its object as the detail).
 */
function toolEntry(type: string, payload: Record<string, unknown>, at: string): RunEventJournalEntry | null {
	const tool = boundedText(payload.tool);
	if (tool === undefined) return null;
	const action = isRecord(payload.action) ? payload.action : null;
	const verb = boundedText(action?.verb);
	const object = boundedText(action?.object);
	const outcome = payload.outcome;
	const durationMs = finiteCount(payload.durationMs);
	const reason = boundedText(payload.reason);
	const callId = boundedText(payload.toolCallId);
	return {
		at,
		type,
		tool,
		...(callId !== undefined ? { callId } : {}),
		...(verb !== undefined ? { verb } : {}),
		...(object !== undefined ? { detail: action?.truncated === true ? `${object}…` : object } : {}),
		...(type === "clio_coder_tool_finish" && (outcome === "ok" || outcome === "error" || outcome === "blocked")
			? { outcome }
			: {}),
		...(type === "clio_coder_tool_finish" && durationMs !== undefined ? { durationMs } : {}),
		...(type === "clio_coder_tool_finish" && outcome !== "ok" && reason !== undefined ? { reason } : {}),
	};
}

/** Tokens one assistant model call processed, the same sum the worker progress fold keeps. */
function messageTokens(event: Record<string, unknown>): number | undefined {
	if (!isRecord(event.message) || event.message.role !== "assistant" || !isRecord(event.message.usage)) return undefined;
	const usage = event.message.usage;
	const input = finiteCount(usage.input);
	const output = finiteCount(usage.output);
	if (input === undefined || output === undefined) return undefined;
	const tokens = input + output + (finiteCount(usage.cacheRead) ?? 0) + (finiteCount(usage.cacheWrite) ?? 0);
	// A message with no measured usage (a repair or an aborted call) adds nothing to say.
	return tokens > 0 ? tokens : undefined;
}

/**
 * Project one non-delta worker event into a feed line, or null when the feed
 * does not keep it. `streamed` says prose deltas already carried this
 * message's text, so its `message_end` keeps only the token count.
 */
function runFeedEntryFromEvent(event: unknown, streamed: boolean, at: string): RunEventJournalEntry | null {
	if (!isRecord(event)) return null;
	const normalized = normalizeClioCoderEventRecord(event);
	const type = typeof normalized.type === "string" ? normalized.type : "unknown";
	if (UNJOURNALED_TYPES.has(type)) return null;
	const payload = isRecord(normalized.payload) ? normalized.payload : {};
	if (type === "clio_coder_tool_start" || type === "clio_coder_tool_finish") return toolEntry(type, payload, at);
	if (type === "message_end") {
		const tokens = messageTokens(normalized);
		const tail = streamed ? null : runTailEntryFromEvent(normalized, at);
		if (tokens === undefined && tail?.detail === undefined) return null;
		return {
			at,
			type,
			...(tail?.detail !== undefined ? { detail: tail.detail } : {}),
			...(tokens !== undefined ? { tokens } : {}),
		};
	}
	if (type === "clio_coder_permission_escalated") {
		const tool = boundedText(payload.tool);
		const detail = boundedText(payload.target) ?? boundedText(payload.summary);
		return { at, type, ...(tool !== undefined ? { tool } : {}), ...(detail !== undefined ? { detail } : {}) };
	}
	if (type === "clio_coder_permission_resolved") {
		const tool = boundedText(payload.tool);
		const decision = payload.decision === "approved" || payload.decision === "denied" ? payload.decision : undefined;
		const reason = boundedText(payload.reason);
		return {
			at,
			type,
			...(tool !== undefined ? { tool } : {}),
			outcome: decision === "approved" ? "ok" : "blocked",
			detail: decision ?? (typeof payload.mode === "string" ? payload.mode : "deny"),
			...(reason !== undefined ? { reason } : {}),
		};
	}
	if (type === "clio_coder_run_outcome") {
		const code = boundedText(payload.outcomeCode) ?? "unknown";
		const reason = boundedText(payload.detail);
		return { at, type, detail: code, ...(reason !== undefined ? { reason } : {}) };
	}
	if (type === "clio_coder_steer_received") {
		const chars = finiteCount(payload.chars);
		return { at, type, ...(chars !== undefined ? { detail: `${chars} chars` } : {}) };
	}
	return runTailEntryFromEvent(normalized, at);
}

/** Prose waiting to be written as one line, and what the run is doing between lines. */
interface RunFeedState {
	text: string;
	textBytes: number;
	/** Monotonic instant the first buffered delta arrived. */
	since: number;
	/** A reasoning block is open; its line was written when it opened. */
	thinking: boolean;
	/** Prose deltas were written since the last `message_end`. */
	streamed: boolean;
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
	const nowMs = options.nowMs ?? (() => performance.now());
	const opened = new Set<string>();
	const feeds = new Map<string, RunFeedState>();

	const ensureOpen = (runId: string, agentId: string): void => {
		if (opened.has(runId)) return;
		opened.add(runId);
		while (opened.size > OPENED_RUN_LIMIT) {
			const oldest = opened.values().next();
			if (oldest.done === true) break;
			opened.delete(oldest.value);
			feeds.delete(oldest.value);
		}
		journal.open(runId, agentId);
	};

	const feedFor = (runId: string): RunFeedState => {
		let feed = feeds.get(runId);
		if (feed === undefined) {
			feed = { text: "", textBytes: 0, since: 0, thinking: false, streamed: false };
			feeds.set(runId, feed);
		}
		return feed;
	};

	const flushText = (runId: string): void => {
		const feed = feeds.get(runId);
		if (feed === undefined || feed.text.length === 0) return;
		journal.append(runId, { at: new Date().toISOString(), type: "text", detail: feed.text });
		feed.text = "";
		feed.textBytes = 0;
		feed.streamed = true;
	};

	const bufferText = (runId: string, delta: string): void => {
		const feed = feedFor(runId);
		const now = nowMs();
		if (feed.text.length === 0) feed.since = now;
		feed.text += delta;
		feed.textBytes += Buffer.byteLength(delta, "utf8");
		feed.thinking = false;
		if (now - feed.since >= TEXT_COALESCE_MS || feed.textBytes >= TEXT_CHUNK_MAX_BYTES) flushText(runId);
	};

	/**
	 * Write the receipt facts and close the run. Read defensively for the same
	 * reason the registry's seal is: a terminal payload that is missing a field
	 * it is typed to have must degrade the transcript, never throw back into the
	 * finalizer that emitted it.
	 */
	const seal = (outcome: string, detail: string | null | undefined, payload: unknown): void => {
		const identity = runIdentity(payload);
		if (identity === null || options.acceptRun?.(identity.runId) === false) return;
		ensureOpen(identity.runId, identity.agentId);
		flushText(identity.runId);
		feeds.delete(identity.runId);
		const exitCode = isRecord(payload) && typeof payload.exitCode === "number" ? payload.exitCode : null;
		journal.receipt(identity.runId, { outcome, exitCode });
		journal.terminal(identity.runId, outcome, detail ?? undefined);
		opened.delete(identity.runId);
	};

	const unsubscribes = [
		bus.on(BusChannels.DispatchProgress, (payload: DispatchProgressPayload) => {
			const identity = runIdentity(payload);
			if (identity === null || options.acceptRun?.(identity.runId) === false) return;
			const { runId } = identity;
			const event = payload.event;
			const delta = workerTextDelta(event);
			if (delta.length > 0) {
				ensureOpen(runId, identity.agentId);
				bufferText(runId, delta);
				return;
			}
			if (isRecord(event) && isThinkingEvent(event)) {
				// The block opening is the state change worth a line; its content
				// is never read, and every later delta of it is the same fact.
				const feed = feedFor(runId);
				if (feed.thinking) return;
				ensureOpen(runId, identity.agentId);
				flushText(runId);
				feed.thinking = true;
				journal.append(runId, { at: new Date().toISOString(), type: "thinking" });
				return;
			}
			const feed = feeds.get(runId);
			// Opening the run only once an event survives the feed's filter keeps
			// a heartbeat-only run from creating an empty journal directory.
			const entry = runFeedEntryFromEvent(event, feed?.streamed === true, new Date().toISOString());
			if (entry === null) return;
			ensureOpen(runId, identity.agentId);
			flushText(runId);
			if (feed !== undefined) {
				feed.thinking = false;
				if (entry.type === "message_end") feed.streamed = false;
			}
			// Route resolution warnings use `message`, while worker transcript
			// events generally project their text through `detail`. Preserve the
			// warning at this dispatch-owned durability seam so fleet view does not
			// render a content-free `route_warning` line.
			const message = isRecord(event) && typeof event.message === "string" ? event.message : undefined;
			journal.append(runId, entry.detail === undefined && message !== undefined ? { ...entry, detail: message } : entry);
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
			for (const runId of feeds.keys()) flushText(runId);
			feeds.clear();
			opened.clear();
		},
	};
}
