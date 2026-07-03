import {
	BusChannels,
	type DispatchCompletedPayload,
	type DispatchFailedPayload,
	type DispatchProgressPayload,
	type DispatchRunIdentity,
} from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { AgentAudience } from "../domains/agents/spec.js";
import type { DispatchRequestOrigin, RunKind, RunStatus } from "../domains/dispatch/types.js";
import { truncateToWidth, visibleWidth } from "../engine/tui.js";
import { formatUsd } from "./footer/widgets.js";
import { formatFooterTokens } from "./footer-panel.js";
import {
	type ClioTheme,
	type ClioToken,
	clioTheme,
	dotSep,
	formatCompactMs,
	frame,
	GLYPH,
	innerDivider,
	spinnerFrame,
} from "./theme/index.js";

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
	targetId: string;
	wireModelId: string;
	status: DispatchBoardStatus;
	elapsedMs: number;
	tokenCount: number;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	ttftMs: number | null;
	outcomeDetail?: string | null;
}

interface DispatchBoardEntry extends Omit<DispatchBoardRow, "elapsedMs"> {
	sequence: number;
	enqueuedAtMs: number;
	startedAtMs: number | null;
	finishedAtMs: number | null;
	durationMs: number | null;
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

export function agentDisplayLabel(row: Pick<DispatchBoardRow, "agentId" | "agentAudience">): string {
	if (row.agentAudience === "shadow") return `sh:${row.agentId}`;
	if (row.agentAudience === "internal") return `in:${row.agentId}`;
	return row.agentId;
}

export interface DispatchStatusPresentation {
	glyph: string;
	label: string;
	token: ClioToken;
}

/**
 * One presentation per run status, shared by the dispatch cards, the task
 * island, and the footer worker lines so a status never changes glyph or color
 * between surfaces. `compact` shortens labels for narrow rows; a `tick`
 * animates the running glyph.
 */
export function dispatchStatusPresentation(
	status: DispatchBoardStatus,
	options: { compact?: boolean; tick?: number } = {},
): DispatchStatusPresentation {
	const compact = options.compact === true;
	switch (status) {
		case "running":
			// Running fleet work is Clio acting, so it joins queued work under the
			// action token rather than the old teal-running/orange-queued split.
			return {
				glyph: options.tick !== undefined ? spinnerFrame(options.tick) : GLYPH.running,
				label: "running",
				token: "action",
			};
		case "completed":
			return { glyph: GLYPH.ok, label: compact ? "done" : "completed", token: "success" };
		case "failed":
			return { glyph: GLYPH.error, label: compact ? "fail" : "failed", token: "error" };
		case "dead":
			return { glyph: GLYPH.error, label: "dead", token: "error" };
		case "aborted":
			return { glyph: GLYPH.cancelled, label: compact ? "abort" : "aborted", token: "dim" };
		case "stale":
			return { glyph: GLYPH.warnInline, label: "stale", token: "warning" };
		case "enqueued":
			return { glyph: GLYPH.queued, label: "queued", token: "action" };
	}
}

// Dispatch card rows follow the footer dashboard key-value grammar: a dim key
// padded to a shared column, then one trailing space before the value. The
// widest key ("telemetry") sets the column so every value starts aligned.
const CARD_KV_KEY_WIDTH = "telemetry".length;

function cardKvKey(theme: ClioTheme, key: string): string {
	return theme.fg("dim", `${key.padEnd(CARD_KV_KEY_WIDTH)} `);
}

export function renderDispatchCard(row: DispatchBoardRow, width: number): string[] {
	const theme = clioTheme();
	const agentLabel = agentDisplayLabel(row);
	const elapsed = formatCompactMs(row.elapsedMs);
	const cost = formatUsd(row.costUsd);
	const detail = terminalDetail(row);
	const dot = dotSep(theme);

	const presentation = dispatchStatusPresentation(row.status, {
		...(row.status === "running" ? { tick: Math.floor(Date.now() / 100) } : {}),
	});
	// The status value (glyph plus word) is the single status-colored element on
	// the card. Cost and TTFT are neutral telemetry, so they render muted rather
	// than amber or the accentDeep structure color.
	const statusStr = theme.fg(presentation.token, `${presentation.glyph} ${presentation.label}`);

	const ttft = row.ttftMs !== null ? `${row.ttftMs}ms` : row.status === "running" ? "waiting..." : "n/a";
	const target = `${theme.fg("muted", `${row.runtimeKind}:${row.targetId}`)} ${theme.fg("dim", "▸")} ${theme.fg("muted", row.wireModelId)}`;

	// The agent label is the frame title and can be arbitrarily long (agent ids
	// are user data); clamp it so the title plus the elapsed meta never pushes
	// the right corner past the card width.
	const labelBudget = Math.max(1, width - visibleWidth(elapsed) - 10);
	const clampedLabel = truncateToWidth(agentLabel, labelBudget, "...", false);

	const elapsedSec = row.elapsedMs / 1000;
	const tokensPerSec = elapsedSec > 0.1 ? Math.round(row.outputTokens / elapsedSec) : 0;
	// A queued run has produced nothing yet, so it never carries a throughput.
	const showRate = row.status !== "enqueued" && tokensPerSec > 0;
	const up = theme.fg("muted", `${GLYPH.up} ${formatFooterTokens(row.inputTokens)}`);
	const down = theme.fg(
		"muted",
		`${GLYPH.down} ${formatFooterTokens(row.outputTokens)}${showRate ? ` (${tokensPerSec}/s)` : ""}`,
	);
	const total = theme.fg("muted", `total ${formatFooterTokens(row.tokenCount)}`);

	const bodyLines = [
		`${cardKvKey(theme, "target")}${target}`,
		`${cardKvKey(theme, "status")}${statusStr}${dot}${theme.fg("dim", "ttft")} ${theme.fg("muted", ttft)}${dot}${theme.fg("dim", "cost")} ${theme.fg("muted", cost)}`,
		`${cardKvKey(theme, "telemetry")}${up}${dot}${down}${dot}${total}`,
	];
	if (detail !== null) bodyLines.push(`${cardKvKey(theme, "detail")}${theme.fg("dim", detail)}`);

	return frame(theme, clampedLabel, bodyLines, width, { rightMeta: elapsed });
}

function renderTaskIslandRow(row: DispatchBoardRow, width: number): string[] {
	const theme = clioTheme();
	const agentLabel = agentDisplayLabel(row);
	const elapsed = formatCompactMs(row.elapsedMs);
	const cost = formatUsd(row.costUsd);

	const dot = dotSep(theme);
	const presentation = dispatchStatusPresentation(row.status, {
		compact: true,
		...(row.status === "running" ? { tick: Math.floor(Date.now() / 100) } : {}),
	});
	const glyph = theme.fg(presentation.token, presentation.glyph);
	const statusStr = theme.fg(presentation.token, presentation.label);

	// The agent label drops its accent color for plain bold; the status word is
	// the only status-colored element on the row, with dim middot separators.
	const line1 = `${glyph} ${theme.paint(agentLabel, { bold: true })}${dot}${statusStr}${dot}${theme.fg("muted", elapsed)}`;

	const elapsedSec = row.elapsedMs / 1000;
	const tokensPerSec = elapsedSec > 0.1 ? Math.round(row.outputTokens / elapsedSec) : 0;
	// A queued run has produced nothing yet, so it never carries a throughput.
	const showRate = row.status !== "enqueued" && tokensPerSec > 0;
	const up = theme.fg("muted", `${GLYPH.up} ${formatFooterTokens(row.inputTokens)}`);
	const down = theme.fg(
		"muted",
		`${GLYPH.down} ${formatFooterTokens(row.outputTokens)}${showRate ? ` (${tokensPerSec}/s)` : ""}`,
	);
	const telemetry = `  ${up}${dot}${down}${dot}${theme.fg("muted", cost)}`;

	return [padAnsi(line1, width), padAnsi(telemetry, width)];
}

export function formatDispatchBoardLines(rows: ReadonlyArray<DispatchBoardRow>, width = 76): string[] {
	if (rows.length === 0) {
		const theme = clioTheme();
		const lines = ["", "No active dispatches", "Delegated runs appear here with live status and telemetry.", ""];
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
				body.push(innerDivider(clioTheme(), TASK_ISLAND_WIDTH));
			}
			body.push(...renderTaskIslandRow(row, TASK_ISLAND_WIDTH));
		}
		const hidden = rows.length - visibleRows.length;
		if (hidden > 0) {
			body.push(innerDivider(clioTheme(), TASK_ISLAND_WIDTH));
			body.push(clioTheme().fg("dim", `+ ${hidden} more`));
		}
	}

	// Body rows are already ANSI-padded to TASK_ISLAND_WIDTH by the row renderer
	// (or are fixed-width dividers/empty-state lines). The canonical frame re-pads
	// each row ANSI-aware, so passing the styled lines through is safe.
	return frame(clioTheme(), "Tasks", body, TASK_ISLAND_WIDTH + 4);
}

function parseRunId(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function parseText(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function parseRuntimeKind(value: unknown): RunKind {
	if (value === "sdk" || value === "subprocess" || value === "acp-delegation") return value;
	return "http";
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

function parseOptionalDetail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const detail = value.replace(/\s+/g, " ").trim();
	return detail.length > 0 ? detail : null;
}

function terminalDetail(row: DispatchBoardRow): string | null {
	if (row.status !== "failed" && row.status !== "dead" && row.status !== "aborted") return null;
	return parseOptionalDetail(row.outcomeDetail);
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
	if (reason === "dead" || reason === "stalled") return "dead";
	if (reason === "interrupted" || reason === "canceled") return "aborted";
	return "failed";
}

function resolveFailureDetail(
	payload: Partial<DispatchFailedPayload>,
	fallback: string | null | undefined,
): string | null {
	const detail = parseOptionalDetail(payload.outcomeDetail);
	if (detail !== null) return detail;
	if (payload.reason === "timed_out") return "turn timeout exceeded";
	return fallback ?? null;
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
		targetId: entry.targetId,
		wireModelId: entry.wireModelId,
		status: entry.status,
		elapsedMs: resolveElapsedMs(entry, now),
		tokenCount: entry.tokenCount,
		costUsd: entry.costUsd,
		inputTokens: entry.inputTokens,
		outputTokens: entry.outputTokens,
		ttftMs: entry.ttftMs,
		...(entry.outcomeDetail !== undefined ? { outcomeDetail: entry.outcomeDetail } : {}),
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

	// Payloads arrive typed off the bus, but the board keeps its runtime
	// parsing (parse* helpers) because events are not validated at runtime.
	const upsertBase = (
		raw: Partial<DispatchRunIdentity>,
		status: DispatchBoardStatus,
		now: number,
	): DispatchBoardEntry | null => {
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
			targetId: parseText(raw.targetId, previous?.targetId ?? "-"),
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
			outcomeDetail: previous?.outcomeDetail ?? null,
		};
		entries.set(runId, entry);
		pruneEntries(entries);
		return entry;
	};

	const unsubscribers = [
		bus.on(BusChannels.DispatchEnqueued, (raw) => {
			upsertBase(raw ?? {}, "enqueued", Date.now());
		}),
		bus.on(BusChannels.DispatchStarted, (raw) => {
			const now = Date.now();
			const entry = upsertBase(raw ?? {}, "running", now);
			if (!entry) return;
			entry.startedAtMs ??= now;
			entry.finishedAtMs = null;
			entry.durationMs = null;
		}),
		bus.on(BusChannels.DispatchCompleted, (raw) => {
			const now = Date.now();
			const payload: Partial<DispatchCompletedPayload> = raw ?? {};
			const entry = upsertBase(payload, "completed", now);
			if (!entry) return;
			entry.startedAtMs ??= entry.enqueuedAtMs;
			entry.finishedAtMs = now;
			entry.durationMs = parseFiniteNumber(payload.durationMs, Math.max(0, now - entry.startedAtMs));
			entry.tokenCount = parseFiniteNumber(payload.tokenCount, entry.tokenCount);
			entry.costUsd = parseFiniteNumber(payload.costUsd, entry.costUsd);
			entry.outcomeDetail = null;
			if (typeof payload.inputTokenCount === "number") {
				entry.inputTokens = payload.inputTokenCount;
			}
			if (typeof payload.outputTokenCount === "number") {
				entry.outputTokens = payload.outputTokenCount;
			}
		}),
		bus.on(BusChannels.DispatchFailed, (raw) => {
			const now = Date.now();
			const payload: Partial<DispatchFailedPayload> = raw ?? {};
			const runId = parseRunId(payload.runId);
			const previousStatus = runId !== null ? entries.get(runId)?.status : undefined;
			const resolvedStatus = resolveFailedStatus(payload.reason);
			const status = previousStatus === "dead" && resolvedStatus === "failed" ? "dead" : resolvedStatus;
			const entry = upsertBase(payload, status, now);
			if (!entry) return;
			entry.startedAtMs ??= entry.enqueuedAtMs;
			entry.finishedAtMs = now;
			entry.durationMs = parseFiniteNumber(payload.durationMs, Math.max(0, now - entry.startedAtMs));
			entry.tokenCount = parseFiniteNumber(payload.tokenCount, entry.tokenCount);
			entry.costUsd = parseFiniteNumber(payload.costUsd, entry.costUsd);
			entry.outcomeDetail = resolveFailureDetail(payload, entry.outcomeDetail);
			if (typeof payload.inputTokenCount === "number") {
				entry.inputTokens = payload.inputTokenCount;
			}
			if (typeof payload.outputTokenCount === "number") {
				entry.outputTokens = payload.outputTokenCount;
			}
		}),
		bus.on(BusChannels.DispatchProgress, (raw) => {
			const payload: Partial<DispatchProgressPayload> = raw ?? {};
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
