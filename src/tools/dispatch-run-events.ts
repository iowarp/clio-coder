import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { durableAssistantTextFromEvent } from "../domains/dispatch/event-pump.js";
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
	const text = assistantTextFromEvent(event);
	if (text.length > 0) return truncateUtf8(text, RUN_TAIL_TEXT_LIMIT, "...");
	if (!isRecord(event)) return undefined;
	if (event.type === "clio_tool_finish" && isRecord(event.payload)) {
		const tool = typeof event.payload.tool === "string" ? event.payload.tool : "tool";
		const outcome = typeof event.payload.outcome === "string" ? event.payload.outcome : "";
		return `${tool} ${outcome}`.trim();
	}
	if (event.type === "attempt_start") {
		const attempt = typeof event.attempt === "number" ? event.attempt : "?";
		const runId = typeof event.runId === "string" ? event.runId : "?";
		const reason = typeof event.reason === "string" ? event.reason : "retry";
		return truncateUtf8(`attempt ${attempt} -> ${runId}: ${reason}`, RUN_TAIL_TEXT_LIMIT, "...");
	}
	return undefined;
}

export function createDispatchRunEventRegistry(): DispatchRunEventRegistry {
	const runTails = new Map<string, RunTailState>();
	const activeRuns = new Set<string>();
	const activeBatches = new Set<string>();

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
		const type = isRecord(event) && typeof event.type === "string" ? event.type : "unknown";
		if (type === "heartbeat" || type === "message_update") return;
		const state = runTails.get(runId) ?? { agentId, entries: [], lastSeenAt: Date.now() };
		state.lastSeenAt = Date.now();
		const entry: RunTailEntry = { at: new Date().toISOString(), type };
		const detail = eventDetail(event);
		if (detail !== undefined) entry.detail = detail;
		state.entries.push(entry);
		if (state.entries.length > RUN_TAIL_ENTRY_LIMIT) {
			state.entries.splice(0, state.entries.length - RUN_TAIL_ENTRY_LIMIT);
		}
		runTails.set(runId, state);
		pruneRunTails();
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
			const summaryPromise = drainSingle(handle.runId, agentId, handle.events, bus);
			const completion = Promise.allSettled([summaryPromise, handle.finalPromise]).then(
				([summaryResult, receiptResult]) => {
					if (summaryResult.status === "rejected") throw summaryResult.reason;
					if (receiptResult.status === "rejected") throw receiptResult.reason;
					return { receipt: receiptResult.value, summary: summaryResult.value };
				},
			);
			void completion
				.finally(() => {
					activeRuns.delete(handle.runId);
					pruneRunTails();
				})
				.catch(() => {});
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
			const completion = Promise.allSettled([drainBatch(handle.batchId, handle.events, bus), handle.finalPromise]).then(
				([summariesResult, receiptsResult]) => {
					if (summariesResult.status === "rejected") throw summariesResult.reason;
					if (receiptsResult.status === "rejected") throw receiptsResult.reason;
					return { receipts: receiptsResult.value, summaries: summariesResult.value };
				},
			);
			void completion
				.finally(() => {
					activeBatches.delete(handle.batchId);
					for (const runId of handle.assignmentIds) activeRuns.delete(runId);
					pruneRunTails();
				})
				.catch(() => {});
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
