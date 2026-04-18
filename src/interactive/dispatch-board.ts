import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { RunKind, RunStatus } from "../domains/dispatch/types.js";

export type DispatchBoardStatus = Extract<RunStatus, "running" | "completed" | "failed"> | "aborted" | "enqueued";

export interface DispatchBoardRow {
	runId: string;
	agentId: string;
	runtimeKind: RunKind;
	runtimeId: string;
	endpointId: string;
	wireModelId: string;
	status: DispatchBoardStatus;
	elapsedMs: number;
	tokenCount: number;
	costUsd: number;
}

interface DispatchBoardEntry extends Omit<DispatchBoardRow, "elapsedMs"> {
	sequence: number;
	enqueuedAtMs: number;
	startedAtMs: number | null;
	finishedAtMs: number | null;
	durationMs: number | null;
}

interface DispatchEventBase {
	runId?: unknown;
	agentId?: unknown;
	endpointId?: unknown;
	wireModelId?: unknown;
	runtimeId?: unknown;
	runtimeKind?: unknown;
}

interface DispatchTerminalPayload extends DispatchEventBase {
	tokenCount?: unknown;
	costUsd?: unknown;
	durationMs?: unknown;
	reason?: unknown;
}

interface DispatchProgressPayload extends DispatchEventBase {
	event?: unknown;
}

interface WorkerEventShape {
	type?: unknown;
	message?: {
		role?: unknown;
		usage?: {
			input?: unknown;
			output?: unknown;
			cacheRead?: unknown;
			cacheWrite?: unknown;
		};
	};
	messages?: unknown;
}

interface AssistantMessageShape {
	role?: unknown;
	stopReason?: unknown;
}

const AGENT_WIDTH = 10;
const RUNTIME_WIDTH = 10;
const ENDPOINT_MODEL_WIDTH = 28;
const STATUS_WIDTH = 9;
const ELAPSED_WIDTH = 9;
const TOKENS_WIDTH = 10;
const USD_WIDTH = 10;

const EMPTY_MESSAGE = "No dispatch runs yet.";
const HINT_MESSAGE = "[Esc] close";

const STATUS_ORDER: Record<DispatchBoardStatus, number> = {
	running: 0,
	enqueued: 1,
	failed: 2,
	aborted: 3,
	completed: 4,
};
const MAX_DISPATCH_BOARD_ROWS = 50;

function leftCell(text: string, width: number): string {
	if (text.length <= width) return text.padEnd(width);
	if (width <= 3) return text.slice(0, width);
	return `${text.slice(0, width - 3)}...`;
}

function rightCell(text: string, width: number): string {
	if (text.length <= width) return text.padStart(width);
	if (width <= 3) return text.slice(text.length - width);
	return `...${text.slice(text.length - (width - 3))}`;
}

function buildContentLine(parts: ReadonlyArray<string>): string {
	return parts.join(" ");
}

function buildHeaderLine(): string {
	return buildContentLine([
		leftCell("agent", AGENT_WIDTH),
		leftCell("runtime", RUNTIME_WIDTH),
		leftCell("endpoint/model", ENDPOINT_MODEL_WIDTH),
		leftCell("status", STATUS_WIDTH),
		rightCell("elapsed", ELAPSED_WIDTH),
		rightCell("tokens", TOKENS_WIDTH),
		rightCell("usd", USD_WIDTH),
	]);
}

function buildSeparatorLine(): string {
	return buildContentLine([
		"-".repeat(AGENT_WIDTH),
		"-".repeat(RUNTIME_WIDTH),
		"-".repeat(ENDPOINT_MODEL_WIDTH),
		"-".repeat(STATUS_WIDTH),
		"-".repeat(ELAPSED_WIDTH),
		"-".repeat(TOKENS_WIDTH),
		"-".repeat(USD_WIDTH),
	]);
}

const HEADER_LINE = buildHeaderLine();
const SEPARATOR_LINE = buildSeparatorLine();
const CONTENT_WIDTH = Math.max(HEADER_LINE.length, EMPTY_MESSAGE.length, HINT_MESSAGE.length);

function frameLine(content: string): string {
	return `| ${content.padEnd(CONTENT_WIDTH)} |`;
}

function borderLine(title?: string): string {
	const innerWidth = CONTENT_WIDTH + 2;
	if (!title) return `+${"-".repeat(innerWidth)}+`;
	const label = ` ${title} `;
	return `+${label}${"-".repeat(Math.max(0, innerWidth - label.length))}+`;
}

function formatElapsedMs(value: number): string {
	return `${Math.max(0, Math.round(value))}ms`;
}

function formatTokenCount(value: number): string {
	return String(Math.max(0, Math.round(value)));
}

function formatUsd(value: number): string {
	return `$${Math.max(0, value).toFixed(6)}`;
}

function endpointModelCell(row: DispatchBoardRow): string {
	return `${row.endpointId}/${row.wireModelId}`;
}

function renderRowContent(row: DispatchBoardRow): string {
	return buildContentLine([
		leftCell(row.agentId, AGENT_WIDTH),
		leftCell(`${row.runtimeKind}:${row.runtimeId}`, RUNTIME_WIDTH),
		leftCell(endpointModelCell(row), ENDPOINT_MODEL_WIDTH),
		leftCell(row.status, STATUS_WIDTH),
		rightCell(formatElapsedMs(row.elapsedMs), ELAPSED_WIDTH),
		rightCell(formatTokenCount(row.tokenCount), TOKENS_WIDTH),
		rightCell(formatUsd(row.costUsd), USD_WIDTH),
	]);
}

function parseRunId(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function parseText(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function parseRuntimeKind(value: unknown): RunKind {
	if (value === "http" || value === "subprocess") return value;
	return "http";
}

function parseFiniteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseFiniteNumberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function resolveAgentEndStatus(rawMessages: unknown): DispatchBoardStatus | null {
	if (!Array.isArray(rawMessages)) return null;
	for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
		const message = (rawMessages[index] ?? {}) as AssistantMessageShape;
		if (message.role !== "assistant") continue;
		if (message.stopReason === "stop") return "completed";
		if (message.stopReason === "error") return "failed";
		if (message.stopReason === "aborted") return "aborted";
		return null;
	}
	return null;
}

function resolveFailedStatus(reason: unknown): DispatchBoardStatus {
	return reason === "interrupted" ? "aborted" : "failed";
}

function resolveElapsedMs(entry: DispatchBoardEntry, now: number): number {
	const startedAtMs = entry.startedAtMs ?? entry.enqueuedAtMs;
	if (entry.durationMs !== null) return entry.durationMs;
	const endMs = entry.finishedAtMs ?? now;
	return Math.max(0, endMs - startedAtMs);
}

function toRow(entry: DispatchBoardEntry, now: number): DispatchBoardRow {
	return {
		runId: entry.runId,
		agentId: entry.agentId,
		runtimeKind: entry.runtimeKind,
		runtimeId: entry.runtimeId,
		endpointId: entry.endpointId,
		wireModelId: entry.wireModelId,
		status: entry.status,
		elapsedMs: resolveElapsedMs(entry, now),
		tokenCount: entry.tokenCount,
		costUsd: entry.costUsd,
	};
}

function sortEntries(a: DispatchBoardEntry, b: DispatchBoardEntry): number {
	const rank = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
	if (rank !== 0) return rank;
	const aTime = a.finishedAtMs ?? a.startedAtMs ?? a.enqueuedAtMs;
	const bTime = b.finishedAtMs ?? b.startedAtMs ?? b.enqueuedAtMs;
	if (aTime !== bTime) return bTime - aTime;
	return a.sequence - b.sequence;
}

function pruneEntries(entries: Map<string, DispatchBoardEntry>): void {
	if (entries.size <= MAX_DISPATCH_BOARD_ROWS) return;
	const terminalEntries = [...entries.values()]
		.filter((entry) => entry.status === "completed" || entry.status === "failed")
		.sort((a, b) => a.sequence - b.sequence);
	const evictionQueue =
		terminalEntries.length > 0 ? terminalEntries : [...entries.values()].sort((a, b) => a.sequence - b.sequence);
	for (const entry of evictionQueue) {
		if (entries.size <= MAX_DISPATCH_BOARD_ROWS) break;
		entries.delete(entry.runId);
	}
}

export function formatDispatchBoardLines(rows: ReadonlyArray<DispatchBoardRow>): string[] {
	const body = rows.length > 0 ? rows.map(renderRowContent) : [EMPTY_MESSAGE];
	return [
		borderLine("Dispatch Board"),
		frameLine(HEADER_LINE),
		frameLine(SEPARATOR_LINE),
		...body.map((line) => frameLine(line)),
		frameLine(HINT_MESSAGE),
		borderLine(),
	];
}

export function createDispatchBoardStore(bus: SafeEventBus): {
	rows(): ReadonlyArray<DispatchBoardRow>;
	unsubscribe(): void;
} {
	const entries = new Map<string, DispatchBoardEntry>();
	let nextSequence = 0;

	const upsertBase = (raw: DispatchEventBase, status: DispatchBoardStatus, now: number): DispatchBoardEntry | null => {
		const runId = parseRunId(raw.runId);
		if (!runId) return null;
		const previous = entries.get(runId);
		const entry: DispatchBoardEntry = {
			runId,
			agentId: parseText(raw.agentId, previous?.agentId ?? "-"),
			runtimeKind: parseRuntimeKind(raw.runtimeKind ?? previous?.runtimeKind),
			runtimeId: parseText(raw.runtimeId, previous?.runtimeId ?? "-"),
			endpointId: parseText(raw.endpointId, previous?.endpointId ?? "-"),
			wireModelId: parseText(raw.wireModelId, previous?.wireModelId ?? "-"),
			status,
			tokenCount: previous?.tokenCount ?? 0,
			costUsd: previous?.costUsd ?? 0,
			sequence: previous?.sequence ?? nextSequence++,
			enqueuedAtMs: previous?.enqueuedAtMs ?? now,
			startedAtMs: previous?.startedAtMs ?? null,
			finishedAtMs: previous?.finishedAtMs ?? null,
			durationMs: previous?.durationMs ?? null,
		};
		entries.set(runId, entry);
		pruneEntries(entries);
		return entry;
	};

	const unsubscribers = [
		bus.on(BusChannels.DispatchEnqueued, (raw) => {
			upsertBase((raw ?? {}) as DispatchEventBase, "enqueued", Date.now());
		}),
		bus.on(BusChannels.DispatchStarted, (raw) => {
			const now = Date.now();
			const entry = upsertBase((raw ?? {}) as DispatchEventBase, "running", now);
			if (!entry) return;
			entry.startedAtMs ??= now;
			entry.finishedAtMs = null;
			entry.durationMs = null;
		}),
		bus.on(BusChannels.DispatchCompleted, (raw) => {
			const now = Date.now();
			const payload = (raw ?? {}) as DispatchTerminalPayload;
			const entry = upsertBase(payload, "completed", now);
			if (!entry) return;
			entry.startedAtMs ??= entry.enqueuedAtMs;
			entry.finishedAtMs = now;
			entry.durationMs = parseFiniteNumber(payload.durationMs, Math.max(0, now - entry.startedAtMs));
			entry.tokenCount = parseFiniteNumber(payload.tokenCount, entry.tokenCount);
			entry.costUsd = parseFiniteNumber(payload.costUsd, entry.costUsd);
		}),
		bus.on(BusChannels.DispatchFailed, (raw) => {
			const now = Date.now();
			const payload = (raw ?? {}) as DispatchTerminalPayload;
			const entry = upsertBase(payload, resolveFailedStatus(payload.reason), now);
			if (!entry) return;
			entry.startedAtMs ??= entry.enqueuedAtMs;
			entry.finishedAtMs = now;
			entry.durationMs = parseFiniteNumber(payload.durationMs, Math.max(0, now - entry.startedAtMs));
			entry.tokenCount = parseFiniteNumber(payload.tokenCount, entry.tokenCount);
			entry.costUsd = parseFiniteNumber(payload.costUsd, entry.costUsd);
		}),
		bus.on(BusChannels.DispatchProgress, (raw) => {
			const payload = (raw ?? {}) as DispatchProgressPayload;
			const runId = parseRunId(payload.runId);
			if (!runId) return;
			const entry = entries.get(runId);
			// Progress events before we've seen DispatchEnqueued/Started are out of
			// order; leave them alone so the row reflects the lifecycle the
			// dispatch domain actually emitted.
			if (!entry) return;
			const workerEvent = (payload.event ?? {}) as WorkerEventShape;
			const type = typeof workerEvent.type === "string" ? workerEvent.type : "";
			if (type === "message_end" && workerEvent.message?.role === "assistant") {
				const usage = workerEvent.message.usage;
				entry.tokenCount +=
					parseFiniteNumberOrZero(usage?.input) +
					parseFiniteNumberOrZero(usage?.output) +
					parseFiniteNumberOrZero(usage?.cacheRead) +
					parseFiniteNumberOrZero(usage?.cacheWrite);
			}
			if (type === "agent_end") {
				const status = resolveAgentEndStatus(workerEvent.messages);
				if (!status) return;
				entry.status = status;
				entry.finishedAtMs ??= Date.now();
			}
		}),
	];

	let closed = false;

	return {
		rows() {
			const now = Date.now();
			return [...entries.values()].sort(sortEntries).map((entry) => toRow(entry, now));
		},
		unsubscribe() {
			if (closed) return;
			closed = true;
			for (const unsubscribe of unsubscribers) unsubscribe();
		},
	};
}
