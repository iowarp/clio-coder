import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { RunStatus } from "../domains/dispatch/types.js";

export type DispatchBoardRuntime = "native" | "sdk" | "cli";
export type DispatchBoardStatus = Extract<RunStatus, "running" | "completed" | "failed"> | "enqueued";

export interface DispatchBoardRow {
	runId: string;
	agentId: string;
	runtime: DispatchBoardRuntime;
	providerId: string;
	modelId: string;
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
	providerId?: unknown;
	modelId?: unknown;
	runtime?: unknown;
}

interface DispatchTerminalPayload extends DispatchEventBase {
	tokenCount?: unknown;
	costUsd?: unknown;
	durationMs?: unknown;
}

const AGENT_WIDTH = 10;
const RUNTIME_WIDTH = 7;
const PROVIDER_MODEL_WIDTH = 24;
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
	completed: 3,
};

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
		leftCell("provider/model", PROVIDER_MODEL_WIDTH),
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
		"-".repeat(PROVIDER_MODEL_WIDTH),
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

function providerModel(row: DispatchBoardRow): string {
	return `${row.providerId}/${row.modelId}`;
}

function renderRowContent(row: DispatchBoardRow): string {
	return buildContentLine([
		leftCell(row.agentId, AGENT_WIDTH),
		leftCell(row.runtime, RUNTIME_WIDTH),
		leftCell(providerModel(row), PROVIDER_MODEL_WIDTH),
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

function parseRuntime(value: unknown): DispatchBoardRuntime {
	if (value === "native" || value === "sdk" || value === "cli") return value;
	return "native";
}

function parseFiniteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
		runtime: entry.runtime,
		providerId: entry.providerId,
		modelId: entry.modelId,
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
			runtime: parseRuntime(raw.runtime ?? previous?.runtime),
			providerId: parseText(raw.providerId, previous?.providerId ?? "-"),
			modelId: parseText(raw.modelId, previous?.modelId ?? "-"),
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
			const entry = upsertBase(payload, "failed", now);
			if (!entry) return;
			entry.startedAtMs ??= entry.enqueuedAtMs;
			entry.finishedAtMs = now;
			entry.durationMs = parseFiniteNumber(payload.durationMs, Math.max(0, now - entry.startedAtMs));
			entry.tokenCount = parseFiniteNumber(payload.tokenCount, entry.tokenCount);
			entry.costUsd = parseFiniteNumber(payload.costUsd, entry.costUsd);
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
