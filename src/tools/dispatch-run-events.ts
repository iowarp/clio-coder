import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { normalizeClioCoderEventRecord, normalizeClioCoderEventType } from "../core/naming-events.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { durableAssistantTextFromEvent } from "../domains/dispatch/event-pump.js";
import { defaultRunEventJournal, type RunEventJournalSink } from "../domains/dispatch/run-event-journal.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import { assistantTextFromEvent } from "./dispatch-event-text.js";
import { truncateUtf8 } from "./truncate-utf8.js";

export interface DispatchEventSummary {
	count: number;
	types: string[];
	lastAssistantText: string;
	terminalAttemptRunId: string;
}

export interface RunTailEntry {
	at: string;
	type: string;
	detail?: string;
}

interface RunTailState {
	agentId: string;
	entries: RunTailEntry[];
	lastSeenAt: number;
}

interface RegisteredSingleDispatch {
	runId: string;
	completion: Promise<{ receipt: RunReceipt; summary: DispatchEventSummary }>;
}

interface RegisteredBatchDispatch {
	batchId: string;
	assignmentIds: ReadonlyArray<string>;
	completion: Promise<{ receipts: ReadonlyArray<RunReceipt>; summaries: Map<string, DispatchEventSummary> }>;
}

export interface DispatchRunEventRegistry {
	registerSingle(
		handle: Awaited<ReturnType<DispatchContract["dispatch"]>>,
		agentId: string,
		bus?: SafeEventBus,
	): RegisteredSingleDispatch;
	registerBatch(
		handle: Awaited<ReturnType<DispatchContract["dispatchBatch"]>>,
		agentIds: ReadonlyArray<string>,
		bus?: SafeEventBus,
	): RegisteredBatchDispatch;
	recordEvent(runId: string, agentId: string, event: unknown): void;
	eventTail(runId: string): { agentId: string; entries: ReadonlyArray<RunTailEntry> } | null;
}

const RUN_TAIL_ENTRY_LIMIT = 100;
const RUN_TAIL_RUN_LIMIT = 64;
const RUN_TAIL_TEXT_LIMIT = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventDetail(event: unknown): string | undefined {
	const normalized = isRecord(event) ? normalizeClioCoderEventRecord(event) : event;
	const text = assistantTextFromEvent(normalized);
	if (text.length > 0) return truncateUtf8(text, RUN_TAIL_TEXT_LIMIT, "...");
	if (!isRecord(normalized)) return undefined;
	if (normalized.type === "clio_coder_tool_finish" && isRecord(normalized.payload)) {
		const tool = typeof normalized.payload.tool === "string" ? normalized.payload.tool : "tool";
		const outcome = typeof normalized.payload.outcome === "string" ? normalized.payload.outcome : "";
		return `${tool} ${outcome}`.trim();
	}
	if (normalized.type === "attempt_start") {
		const attempt = typeof normalized.attempt === "number" ? normalized.attempt : "?";
		const runId = typeof normalized.runId === "string" ? normalized.runId : "?";
		const reason = typeof normalized.reason === "string" ? normalized.reason : "retry";
		return truncateUtf8(`attempt ${attempt} -> ${runId}: ${reason}`, RUN_TAIL_TEXT_LIMIT, "...");
	}
	return undefined;
}

/**
 * Project one worker/ACP event into the display tail, or null when the event is
 * not tail-visible. Heartbeats and streaming `message_update` increments are
 * noise on a transcript: the tail keeps message boundaries, not deltas.
 *
 * The durable journal writes exactly this projection, so a transcript read back
 * by `clio-coder fleet view` and the monitor's live peek cannot disagree about
 * what a run did. Both the registry below and the domain-owned journal bridge
 * (src/domains/dispatch/run-event-journal-bridge.ts) call it.
 */
export function runTailEntryFromEvent(event: unknown, at: string = new Date().toISOString()): RunTailEntry | null {
	const type = isRecord(event) && typeof event.type === "string" ? normalizeClioCoderEventType(event.type) : "unknown";
	if (type === "heartbeat" || type === "message_update") return null;
	const entry: RunTailEntry = { at, type };
	const detail = eventDetail(event);
	if (detail !== undefined) entry.detail = detail;
	return entry;
}

export interface DispatchRunEventRegistryOptions {
	/**
	 * Durable tee for the display tail. Omitted takes the process-wide default
	 * journal (settings-gated by `fleet.history.journal`); `null` turns it off for this
	 * registry. This is the one wiring choke point: every registry in the
	 * process is built by this factory, so the sink attaches here rather than at
	 * each of the three construction sites that call it.
	 */
	journal?: RunEventJournalSink | null;
}

/** Outcome recorded for a run whose completion rejected before a receipt existed. */
const REGISTRY_FAILURE_OUTCOME = "failed";
/** Outcome recorded when a receipt settled without a readable outcome field. */
const REGISTRY_UNKNOWN_OUTCOME = "unknown";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createDispatchRunEventRegistry(
	options: DispatchRunEventRegistryOptions = {},
): DispatchRunEventRegistry {
	const runTails = new Map<string, RunTailState>();
	const activeRuns = new Set<string>();
	const activeBatches = new Set<string>();
	const journal: RunEventJournalSink | null = options.journal === undefined ? defaultRunEventJournal() : options.journal;

	/**
	 * Seal one logical run in the journal. `logicalRunId` is the id an operator
	 * asked about; a retried run's receipt carries the terminal attempt's id
	 * instead, and that only ever appears as a field on the line.
	 */
	const journalSeal = (logicalRunId: string, receipt: RunReceipt): void => {
		if (journal === null || !isRecord(receipt)) return;
		// Every field is read defensively. The journal sits on the completion path
		// of every dispatch, and a receipt that is missing a block it is typed to
		// have (a stubbed contract, a truncated read) must degrade the transcript,
		// never reject the completion the caller is awaiting.
		const digest = receipt.integrity?.digest;
		const outcome = typeof receipt.outcome === "string" ? receipt.outcome : REGISTRY_UNKNOWN_OUTCOME;
		journal.receipt(logicalRunId, {
			outcome,
			exitCode: typeof receipt.exitCode === "number" ? receipt.exitCode : null,
			...(typeof digest === "string" ? { digest } : {}),
			...(receipt.runId !== logicalRunId ? { attemptRunId: receipt.runId } : {}),
		});
		journal.terminal(logicalRunId, outcome, receipt.outcomeDetail ?? undefined);
	};

	/**
	 * Seal a batch's journals. `assignmentIds` are the logical work ids in
	 * admission order and `dispatchBatch` resolves one receipt per request, so
	 * equal lengths pair by index. Anything else pairs by the receipt's own run
	 * id and leaves unmatched assignments without a terminal line rather than
	 * inventing an outcome for them.
	 */
	const sealBatchJournals = (assignmentIds: ReadonlyArray<string>, receipts: ReadonlyArray<RunReceipt>): void => {
		if (journal === null || !Array.isArray(receipts)) return;
		if (assignmentIds.length === receipts.length) {
			for (const [index, runId] of assignmentIds.entries()) {
				const receipt = receipts[index];
				if (receipt !== undefined) journalSeal(runId, receipt);
			}
			return;
		}
		for (const receipt of receipts) {
			if (receipt != null && typeof receipt.runId === "string") journalSeal(receipt.runId, receipt);
		}
	};

	const pruneRunTails = (): void => {
		while (runTails.size > RUN_TAIL_RUN_LIMIT) {
			let oldestKey: string | null = null;
			let oldestSeen = Number.POSITIVE_INFINITY;
			for (const [key, state] of runTails) {
				if (activeRuns.has(key) || state.lastSeenAt >= oldestSeen) continue;
				oldestKey = key;
				oldestSeen = state.lastSeenAt;
			}
			if (oldestKey === null) break;
			runTails.delete(oldestKey);
		}
	};

	const recordRunEvent = (runId: string, agentId: string, event: unknown): void => {
		const entry = runTailEntryFromEvent(event);
		if (entry === null) return;
		const state = runTails.get(runId) ?? { agentId, entries: [], lastSeenAt: Date.now() };
		state.lastSeenAt = Date.now();
		state.entries.push(entry);
		if (state.entries.length > RUN_TAIL_ENTRY_LIMIT) {
			state.entries.splice(0, state.entries.length - RUN_TAIL_ENTRY_LIMIT);
		}
		runTails.set(runId, state);
		pruneRunTails();
		// The journal is a tee of exactly this projection, appended after the
		// in-memory tail is already updated so a sink that degrades cannot change
		// what `eventTail` returns.
		journal?.append(runId, entry);
	};

	const drainSingle = async (
		runId: string,
		agentId: string,
		events: AsyncIterableIterator<unknown>,
		bus: SafeEventBus | undefined,
	): Promise<DispatchEventSummary> => {
		const summary: DispatchEventSummary = {
			count: 0,
			types: [],
			lastAssistantText: "",
			terminalAttemptRunId: runId,
		};
		for await (const event of events) {
			summary.count += 1;
			const type = isRecord(event) && typeof event.type === "string" ? event.type : "unknown";
			summary.types.push(type);
			if (type === "attempt_start") summary.lastAssistantText = "";
			const text = durableAssistantTextFromEvent(event);
			if (text.trim().length > 0) summary.lastAssistantText = text;
			recordRunEvent(runId, agentId, event);
			if (type !== "heartbeat") bus?.emit(BusChannels.DispatchProgress, { runId, agentId, event });
		}
		return summary;
	};

	const drainBatch = async (
		batchId: string,
		events: AsyncIterableIterator<unknown>,
		bus: SafeEventBus | undefined,
	): Promise<Map<string, DispatchEventSummary>> => {
		const summaries = new Map<string, DispatchEventSummary>();
		for await (const event of events) {
			if (!isRecord(event) || event.type !== "batch_run_event") continue;
			const runId = typeof event.runId === "string" ? event.runId : batchId;
			const agentId = typeof event.agentId === "string" ? event.agentId : "batch";
			const inner = event.event;
			const summary = summaries.get(runId) ?? {
				count: 0,
				types: [],
				lastAssistantText: "",
				terminalAttemptRunId: runId,
			};
			summary.count += 1;
			const type = isRecord(inner) && typeof inner.type === "string" ? inner.type : "unknown";
			summary.types.push(type);
			const text = durableAssistantTextFromEvent(inner);
			if (text.trim().length > 0) summary.lastAssistantText = text;
			summaries.set(runId, summary);
			recordRunEvent(runId, agentId, inner);
			if (type !== "heartbeat") bus?.emit(BusChannels.DispatchProgress, { runId, agentId, event: inner });
		}
		return summaries;
	};

	return {
		registerSingle(handle, agentId, bus) {
			if (activeRuns.has(handle.runId)) {
				throw new Error(`dispatch event registry: run '${handle.runId}' is already registered`);
			}
			activeRuns.add(handle.runId);
			journal?.open(handle.runId, agentId);
			const summaryPromise = drainSingle(handle.runId, agentId, handle.events, bus);
			const completion = Promise.allSettled([summaryPromise, handle.finalPromise]).then(
				([summaryResult, receiptResult]) => {
					if (summaryResult.status === "rejected") throw summaryResult.reason;
					if (receiptResult.status === "rejected") throw receiptResult.reason;
					return { receipt: receiptResult.value, summary: summaryResult.value };
				},
			);
			// One subscription, not a `.then().finally()` chain. Chaining pushes the
			// tail release a microtask later than it used to land, and a caller that
			// awaits `completion` and then reads `eventTail` observes the run as
			// still active. Journal and release settle together in this handler.
			const releaseSingle = (): void => {
				activeRuns.delete(handle.runId);
				pruneRunTails();
			};
			void completion.then(
				({ receipt }) => {
					journalSeal(handle.runId, receipt);
					releaseSingle();
				},
				(error: unknown) => {
					journal?.terminal(handle.runId, REGISTRY_FAILURE_OUTCOME, errorText(error));
					releaseSingle();
				},
			);
			return { runId: handle.runId, completion };
		},
		registerBatch(handle, agentIds, bus) {
			if (activeBatches.has(handle.batchId)) {
				throw new Error(`dispatch event registry: batch '${handle.batchId}' is already registered`);
			}
			const duplicateRunId = handle.assignmentIds.find((runId, index) =>
				handle.assignmentIds.slice(0, index).includes(runId),
			);
			if (duplicateRunId !== undefined) {
				throw new Error(`dispatch event registry: batch '${handle.batchId}' repeats run '${duplicateRunId}'`);
			}
			const activeRunId = handle.assignmentIds.find((runId) => activeRuns.has(runId));
			if (activeRunId !== undefined) {
				throw new Error(`dispatch event registry: run '${activeRunId}' is already registered`);
			}
			activeBatches.add(handle.batchId);
			for (const runId of handle.assignmentIds) activeRuns.add(runId);
			for (const [index, runId] of handle.assignmentIds.entries()) {
				journal?.open(runId, agentIds[index] ?? "unknown");
			}
			const completion = Promise.allSettled([drainBatch(handle.batchId, handle.events, bus), handle.finalPromise]).then(
				([summariesResult, receiptsResult]) => {
					if (summariesResult.status === "rejected") throw summariesResult.reason;
					if (receiptsResult.status === "rejected") throw receiptsResult.reason;
					return { receipts: receiptsResult.value, summaries: summariesResult.value };
				},
			);
			// Single subscription for the same reason as registerSingle above.
			const releaseBatch = (): void => {
				activeBatches.delete(handle.batchId);
				for (const runId of handle.assignmentIds) activeRuns.delete(runId);
				pruneRunTails();
			};
			void completion.then(
				({ receipts }) => {
					sealBatchJournals(handle.assignmentIds, receipts);
					releaseBatch();
				},
				(error: unknown) => {
					const detail = errorText(error);
					for (const runId of handle.assignmentIds) {
						journal?.terminal(runId, REGISTRY_FAILURE_OUTCOME, detail);
					}
					releaseBatch();
				},
			);
			for (const [index, runId] of handle.assignmentIds.entries()) {
				if (!runTails.has(runId)) {
					runTails.set(runId, {
						agentId: agentIds[index] ?? "unknown",
						entries: [],
						lastSeenAt: Date.now(),
					});
				}
			}
			return { batchId: handle.batchId, assignmentIds: handle.assignmentIds, completion };
		},
		recordEvent: recordRunEvent,
		eventTail(runId) {
			const state = runTails.get(runId);
			return state === undefined ? null : { agentId: state.agentId, entries: [...state.entries] };
		},
	};
}
