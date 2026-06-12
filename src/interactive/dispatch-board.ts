import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { AgentAudience } from "../domains/agents/spec.js";
import type { DispatchRequestOrigin, RunKind, RunStatus } from "../domains/dispatch/types.js";
import { truncateToWidth, visibleWidth } from "../engine/tui.js";
import { formatUsd } from "./footer/widgets.js";
import { type ClioTheme, clioTheme, GLYPH, spinnerFrame } from "./theme/index.js";

export type DispatchBoardStatus =
	| Extract<RunStatus, "running" | "completed" | "failed" | "stale" | "dead">
	| "aborted"
	| "enqueued";

export interface DispatchBoardRow {
	runId: string;
	agentId: string;
	agentAudience?: AgentAudience;
	requestOrigin?: DispatchRequestOrigin;
	runtimeKind: RunKind;
	runtimeId: string;
	endpointId: string;
	wireModelId: string;
	status: DispatchBoardStatus;
	elapsedMs: number;
	tokenCount: number;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	ttftMs: number | null;
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
	agentAudience?: unknown;
	requestOrigin?: unknown;
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
	inputTokenCount?: unknown;
	outputTokenCount?: unknown;
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

export const TASK_ISLAND_WIDTH = 44;
const _EMPTY_MESSAGE = "No dispatch runs yet.";

const STATUS_ORDER: Record<DispatchBoardStatus, number> = {
	running: 0,
	stale: 1,
	enqueued: 2,
	dead: 3,
	failed: 4,
	aborted: 5,
	completed: 6,
};
const MAX_DISPATCH_BOARD_ROWS = 50;

function padAnsi(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

/** Compact duration, matching the footer's turn-summary style. */
function formatElapsedMs(value: number): string {
	const ms = Math.max(0, Math.round(value));
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	return seconds < 60
		? `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`
		: `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

function _formatTokenCount(value: number): string {
	return String(Math.max(0, Math.round(value)));
}

export function agentDisplayLabel(row: Pick<DispatchBoardRow, "agentId" | "agentAudience">): string {
	if (row.agentAudience === "shadow") return `sh:${row.agentId}`;
	if (row.agentAudience === "internal") return `in:${row.agentId}`;
	return row.agentId;
}

export function renderDispatchCard(row: DispatchBoardRow, width: number): string[] {
	const theme = clioTheme();
	const agentLabel = agentDisplayLabel(row);
	const elapsed = formatElapsedMs(row.elapsedMs);
	const cost = formatUsd(row.costUsd);

	let statusStr = "";
	if (row.status === "running") {
		const spinner = spinnerFrame(Math.floor(Date.now() / 100));
		statusStr = theme.style("accent", `${spinner} running`);
	} else if (row.status === "completed") {
		statusStr = theme.fg("success", `${GLYPH.ok} completed`);
	} else if (row.status === "failed") {
		statusStr = theme.fg("error", `${GLYPH.error} failed`);
	} else if (row.status === "aborted") {
		statusStr = theme.fg("dim", `${GLYPH.cancelled} aborted`);
	} else if (row.status === "stale") {
		statusStr = theme.fg("warning", `! stale`);
	} else {
		statusStr = theme.fg("dim", `+ ${row.status}`);
	}

	const ttft = row.ttftMs !== null ? `${row.ttftMs}ms` : row.status === "running" ? "waiting..." : "n/a";
	const target = `${row.runtimeKind}:${row.endpointId} ${theme.fg("dim", "▸")} ${row.wireModelId}`;

	const suffix = ` ${elapsed} ──┐`;
	// The label can be arbitrarily long (agent ids are user data); clamp it so
	// prefix + suffix never exceed the card width.
	const labelBudget = Math.max(1, width - visibleWidth(suffix) - visibleWidth("┌──  "));
	const clampedLabel = truncateToWidth(agentLabel, labelBudget, "...", true);
	const prefix = `┌── ${clampedLabel} `;
	const middleWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
	const topBorder = `${theme.fg("frame", prefix)}${theme.fg("frame", "─".repeat(middleWidth))}${theme.fg("frame", suffix)}`;

	const targetLineContent = `Target: ${target}`;
	const targetLine = `${theme.fg("frame", "│")} ${padAnsi(targetLineContent, width - 4)} ${theme.fg("frame", "│")}`;

	const statusLineContent = `Status: ${statusStr}  ${theme.fg("dim", "•")}  TTFT: ${theme.fg("accentDeep", ttft)}  ${theme.fg("dim", "•")}  Cost: ${theme.fg("warning", cost)}`;
	const statusLine = `${theme.fg("frame", "│")} ${padAnsi(statusLineContent, width - 4)} ${theme.fg("frame", "│")}`;

	const elapsedSec = row.elapsedMs / 1000;
	const tokensPerSec = elapsedSec > 0.1 ? Math.round(row.outputTokens / elapsedSec) : 0;
	const telemetryContent = `Telemetry: ${theme.fg("dim", `${GLYPH.up} ${row.inputTokens}`)}  ${theme.fg("dim", "•")}  ${theme.fg("success", `${GLYPH.down} ${row.outputTokens}`)}${tokensPerSec > 0 ? theme.fg("accentDeep", ` (${tokensPerSec}/s)`) : ""}  ${theme.fg("dim", "•")}  Total: ${theme.fg("info", String(row.tokenCount))}`;
	const telemetryLine = `${theme.fg("frame", "│")} ${padAnsi(telemetryContent, width - 4)} ${theme.fg("frame", "│")}`;

	const bottomBorder = `${theme.fg("frame", "└")}${theme.fg("frame", "─".repeat(width - 2))}${theme.fg("frame", "┘")}`;

	return [topBorder, targetLine, statusLine, telemetryLine, bottomBorder];
}

function renderTaskIslandRow(row: DispatchBoardRow, width: number): string[] {
	const theme = clioTheme();
	const agentLabel = agentDisplayLabel(row);
	const elapsed = formatElapsedMs(row.elapsedMs);
	const cost = formatUsd(row.costUsd);

	let statusStr = "";
	if (row.status === "running") {
		const spinner = spinnerFrame(Math.floor(Date.now() / 100));
		statusStr = theme.style("accent", `${spinner} running`);
	} else if (row.status === "completed") {
		statusStr = theme.fg("success", `${GLYPH.ok} done`);
	} else if (row.status === "failed") {
		statusStr = theme.fg("error", `${GLYPH.error} fail`);
	} else if (row.status === "aborted") {
		statusStr = theme.fg("dim", `${GLYPH.cancelled} abort`);
	} else if (row.status === "stale") {
		statusStr = theme.fg("warning", `! stale`);
	} else {
		statusStr = theme.fg("dim", `+ ${row.status}`);
	}

	const line1 = `${theme.style("accent", agentLabel, { bold: true })} ${theme.fg("dim", "•")} ${statusStr} ${theme.fg("dim", "•")} ${theme.fg("info", elapsed)}`;

	const elapsedSec = row.elapsedMs / 1000;
	const tokensPerSec = elapsedSec > 0.1 ? Math.round(row.outputTokens / elapsedSec) : 0;
	const telemetry = `${theme.fg("dim", `${GLYPH.up} ${row.inputTokens}`)} ${theme.fg("dim", "•")} ${theme.fg("success", `${GLYPH.down} ${row.outputTokens}`)}${tokensPerSec > 0 ? theme.fg("accentDeep", ` (${tokensPerSec}/s)`) : ""} ${theme.fg("dim", "•")} ${theme.fg("warning", cost)}`;

	return [padAnsi(line1, width), padAnsi(telemetry, width)];
}

export function formatDispatchBoardLines(rows: ReadonlyArray<DispatchBoardRow>, width = 76): string[] {
	if (rows.length === 0) {
		const theme = clioTheme();
		const lines = [
			"",
			"                    No active dispatches                     ",
			"         Ready to orchestrate your agent workloads.          ",
			"",
			"       Run tasks in parallel, trace telemetry in real time,  ",
			"        or manage tool calls with safety-net admission.      ",
			"",
		];
		return lines.map((line) => {
			const padding = Math.max(0, Math.floor((width - 4 - visibleWidth(line)) / 2));
			return theme.fg("dim", " ".repeat(padding) + line);
		});
	}

	const cards = rows.map((row) => renderDispatchCard(row, width));
	const body: string[] = [];
	for (const card of cards) {
		if (body.length > 0) body.push("");
		body.push(...card);
	}
	return body;
}

export function formatTaskIslandLines(rows: ReadonlyArray<DispatchBoardRow>, maxRows = 4): string[] {
	const visibleRows = rows.slice(0, Math.max(1, maxRows));
	const body: string[] = [];

	if (visibleRows.length === 0) {
		const theme = clioTheme();
		body.push(theme.fg("dim", "No active tasks."));
		body.push(theme.fg("dim", "Use /run or /delegate to spawn agents."));
	} else {
		for (let i = 0; i < visibleRows.length; i++) {
			const row = visibleRows[i];
			if (!row) continue;
			if (i > 0) {
				body.push(clioTheme().fg("frame", "╌".repeat(TASK_ISLAND_WIDTH)));
			}
			body.push(...renderTaskIslandRow(row, TASK_ISLAND_WIDTH));
		}
		const hidden = rows.length - visibleRows.length;
		if (hidden > 0) {
			body.push(clioTheme().fg("frame", "╌".repeat(TASK_ISLAND_WIDTH)));
			body.push(clioTheme().fg("dim", `+ ${hidden} more`));
		}
	}

	// Body lines are already ANSI-padded to TASK_ISLAND_WIDTH by the row
	// renderer (or are fixed-width separators/empty-state lines). `frame`
	// re-pads each line ANSI-aware via padAnsi, so passing the styled lines
	// through directly avoids an escape-corrupting truncation pass.
	return frame(clioTheme(), "Tasks", body, TASK_ISLAND_WIDTH + 4);
}

function frame(theme: ClioTheme, title: string, body: string[], width: number): string[] {
	const bodyWidth = Math.max(1, width - 4);
	const label = title.length > 0 ? `─ ${title} ` : "─ ";
	// Total top width must equal the body rows (`│ … │` => bodyWidth + 4) and
	// the bottom border. `┌─` and `┐` contribute 3 columns, so the fill spans
	// bodyWidth + 1 - visibleWidth(label) to keep the right corners aligned.
	const fill = Math.max(0, bodyWidth - visibleWidth(label) + 1);
	const top = `${theme.fg("frame", "┌─")}${theme.style("title", label, { bold: true })}${theme.fg("frame", "─".repeat(fill))}${theme.fg("frame", "┐")}`;
	const formattedBody = body.map(
		(line) => `${theme.fg("frame", "│")} ${padAnsi(line, bodyWidth)} ${theme.fg("frame", "│")}`,
	);
	const bottom = `${theme.fg("frame", "└")}${theme.fg("frame", "─".repeat(bodyWidth + 2))}${theme.fg("frame", "┘")}`;
	return [top, ...formattedBody, bottom];
}

function parseRunId(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function parseText(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function parseRuntimeKind(value: unknown): RunKind {
	return value === "acp-delegation" ? "acp-delegation" : "http";
}

function parseAgentAudience(value: unknown, fallback: AgentAudience | undefined): AgentAudience | undefined {
	if (value === "base" || value === "shadow" || value === "custom" || value === "internal") return value;
	return fallback;
}

function parseRequestOrigin(
	value: unknown,
	fallback: DispatchRequestOrigin | undefined,
): DispatchRequestOrigin | undefined {
	if (value === "user" || value === "agent" || value === "internal") return value;
	return fallback;
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
	if (reason === "dead") return "dead";
	return reason === "interrupted" ? "aborted" : "failed";
}

function resolveHeartbeatStatus(status: unknown): DispatchBoardStatus | null {
	if (status === "alive") return "running";
	if (status === "stale" || status === "dead") return status;
	return null;
}

function isTerminalStatus(status: DispatchBoardStatus): boolean {
	return status === "completed" || status === "failed" || status === "aborted" || status === "dead";
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
		...(entry.agentAudience !== undefined ? { agentAudience: entry.agentAudience } : {}),
		...(entry.requestOrigin !== undefined ? { requestOrigin: entry.requestOrigin } : {}),
		runtimeKind: entry.runtimeKind,
		runtimeId: entry.runtimeId,
		endpointId: entry.endpointId,
		wireModelId: entry.wireModelId,
		status: entry.status,
		elapsedMs: resolveElapsedMs(entry, now),
		tokenCount: entry.tokenCount,
		costUsd: entry.costUsd,
		inputTokens: entry.inputTokens,
		outputTokens: entry.outputTokens,
		ttftMs: entry.ttftMs,
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
		.filter((entry) => isTerminalStatus(entry.status))
		.sort((a, b) => a.sequence - b.sequence);
	const evictionQueue =
		terminalEntries.length > 0 ? terminalEntries : [...entries.values()].sort((a, b) => a.sequence - b.sequence);
	for (const entry of evictionQueue) {
		if (entries.size <= MAX_DISPATCH_BOARD_ROWS) break;
		entries.delete(entry.runId);
	}
}

export function createDispatchBoardStore(bus: SafeEventBus): {
	rows(): ReadonlyArray<DispatchBoardRow>;
	activeRows(): ReadonlyArray<DispatchBoardRow>;
	unsubscribe(): void;
} {
	const entries = new Map<string, DispatchBoardEntry>();
	let nextSequence = 0;

	const upsertBase = (raw: DispatchEventBase, status: DispatchBoardStatus, now: number): DispatchBoardEntry | null => {
		const runId = parseRunId(raw.runId);
		if (!runId) return null;
		const previous = entries.get(runId);
		const agentAudience = parseAgentAudience(raw.agentAudience, previous?.agentAudience);
		const requestOrigin = parseRequestOrigin(raw.requestOrigin, previous?.requestOrigin);
		const entry: DispatchBoardEntry = {
			runId,
			agentId: parseText(raw.agentId, previous?.agentId ?? "-"),
			...(agentAudience !== undefined ? { agentAudience } : {}),
			...(requestOrigin !== undefined ? { requestOrigin } : {}),
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
			inputTokens: previous?.inputTokens ?? 0,
			outputTokens: previous?.outputTokens ?? 0,
			ttftMs: previous?.ttftMs ?? null,
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
			if (typeof payload.inputTokenCount === "number") {
				entry.inputTokens = payload.inputTokenCount;
			}
			if (typeof payload.outputTokenCount === "number") {
				entry.outputTokens = payload.outputTokenCount;
			}
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
			if (typeof payload.inputTokenCount === "number") {
				entry.inputTokens = payload.inputTokenCount;
			}
			if (typeof payload.outputTokenCount === "number") {
				entry.outputTokens = payload.outputTokenCount;
			}
		}),
		bus.on(BusChannels.DispatchProgress, (raw) => {
			const payload = (raw ?? {}) as DispatchProgressPayload;
			const runId = parseRunId(payload.runId);
			if (!runId) return;
			const entry = entries.get(runId);
			if (!entry) return;
			const workerEvent = (payload.event ?? {}) as WorkerEventShape;
			const type = typeof workerEvent.type === "string" ? workerEvent.type : "";
			if (type === "heartbeat_status") {
				if (isTerminalStatus(entry.status)) return;
				const status = resolveHeartbeatStatus((workerEvent as { status?: unknown }).status);
				if (!status) return;
				entry.status = status;
				if (status === "dead") entry.finishedAtMs ??= Date.now();
				return;
			}
			if (type === "agent_start") {
				entry.startedAtMs = Date.now();
			}
			if (type === "message_update") {
				// biome-ignore lint/suspicious/noExplicitAny: The assistantMessageEvent property is dynamic on workerEvent.
				const assistantEvent = (workerEvent as any).assistantMessageEvent || {};
				const hasDelta =
					assistantEvent.type === "text_delta" ||
					assistantEvent.type === "thinking_delta" ||
					assistantEvent.type === "toolcall_start" ||
					assistantEvent.type === "toolcall_delta";
				if (hasDelta && entry.ttftMs === null && entry.startedAtMs !== null) {
					entry.ttftMs = Date.now() - entry.startedAtMs;
				}
			}
			if (isTerminalStatus(entry.status)) return;
			if (type === "message_end" && workerEvent.message?.role === "assistant") {
				const usage = workerEvent.message.usage;
				const input = parseFiniteNumberOrZero(usage?.input) + parseFiniteNumberOrZero(usage?.cacheRead);
				const output = parseFiniteNumberOrZero(usage?.output);
				entry.inputTokens += input;
				entry.outputTokens += output;
				entry.tokenCount += input + output + parseFiniteNumberOrZero(usage?.cacheWrite);
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
		activeRows() {
			const now = Date.now();
			return [...entries.values()]
				.filter((entry) => !isTerminalStatus(entry.status))
				.sort(sortEntries)
				.map((entry) => toRow(entry, now));
		},
		unsubscribe() {
			if (closed) return;
			closed = true;
			for (const unsubscribe of unsubscribers) unsubscribe();
		},
	};
}
