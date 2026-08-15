import {
	describeTaskMemoryActivity,
	type MemoryRecord,
	type TaskMemoryActivityEvent,
	type TaskMemoryEntry,
	type TaskMemoryOperatorStatus,
	type TaskMemorySnapshot,
	type TaskMemoryTelemetryDecision,
} from "../domains/memory/index.js";
import type { Component, OverlayHandle, TUI } from "../engine/tui.js";
import { showClioOverlayFrame } from "./overlay-frame.js";
import { type ListOverlayItem, ListOverlayView } from "./overlays/list-overlay.js";
import { clioTheme, fitUnits, rule } from "./theme/index.js";

const DEFAULT_CONTENT_WIDTH = 96;
const REFRESH_MS = 1_000;

export const MEMORY_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

const EMPTY_MESSAGE = "no approved lessons, task-bank entries, or memory steps captured yet.";

/**
 * The one-line header that stays above the list.
 *
 * `step running` rides here rather than in a row because a detached step has no
 * row of its own until it finishes, and an operator who cannot see it in flight
 * reads an unchanged bank as an idle memory agent.
 */
export function formatMemoryStatusLine(status: TaskMemoryOperatorStatus, contentWidth: number): string {
	const theme = clioTheme();
	const width = Math.max(1, Math.floor(contentWidth));
	const units = [
		theme.fg(status.enabled ? "success" : "dim", `memory ${status.enabled ? "on" : "off"}`),
		theme.fg(status.tier === "llm" ? "reason" : "muted", `tier ${status.tier === "llm" ? "LLM" : "rules"}`),
		theme.fg("muted", `bank ${status.size}`),
		theme.fg("muted", `last ${status.lastDecision ?? "none"}`),
	];
	if (status.stepInFlight) units.push(theme.fg("reason", "step running"));
	return fitUnits(theme, "", units, width);
}

function bankEntries(snapshot: TaskMemorySnapshot): TaskMemoryEntry[] {
	return [...(snapshot.status === null ? [] : [snapshot.status]), ...snapshot.knowledge, ...snapshot.procedural];
}

function firstLine(content: string): string {
	return content.replace(/\s+/gu, " ").trim();
}

function entryClassLabel(entry: TaskMemoryEntry): string {
	return entry.kind === "status" ? "status (private)" : entry.kind;
}

function lessonItems(records: ReadonlyArray<MemoryRecord>, group: string): ListOverlayItem[] {
	const theme = clioTheme();
	return records.map((record) => ({
		id: `lesson:${record.id}`,
		label: firstLine(record.lesson),
		meta: theme.fg("dim", `${record.scope}:${record.key}`),
		group,
		detail: () => [
			`# ${record.id}`,
			`**Scope:** ${record.scope}:${record.key}`,
			`**Confidence:** ${record.confidence}`,
			`**Created:** ${record.createdAt}`,
			...(record.evidenceRefs.length > 0 ? [`**Evidence:** ${record.evidenceRefs.join(", ")}`] : []),
			...(record.appliesWhen.length > 0 ? [`**Applies when:** ${record.appliesWhen.join("; ")}`] : []),
			...(record.avoidWhen.length > 0 ? [`**Avoid when:** ${record.avoidWhen.join("; ")}`] : []),
			"",
			"---",
			"",
			record.lesson,
		],
	}));
}

function bankItems(entries: ReadonlyArray<TaskMemoryEntry>, group: string): ListOverlayItem[] {
	const theme = clioTheme();
	return entries.map((entry) => ({
		id: `bank:${entry.id}`,
		label: firstLine(entry.content),
		meta: theme.fg("dim", `${entryClassLabel(entry)} · injected ${entry.injectionCount}`),
		group,
		detail: () => [
			`# ${entry.id}`,
			`**Class:** ${entryClassLabel(entry)}`,
			`**Injected:** ${entry.injectionCount}`,
			`**Created:** ${entry.createdAt}`,
			`**Last touched:** ${entry.lastTouchedAt}`,
			"",
			"---",
			"",
			entry.content,
		],
	}));
}

/**
 * The row clock, in the timezone the operator's own clock is in.
 *
 * `event.at` is an ISO-8601 UTC instant, so slicing `HH:MM:SS` out of it
 * printed a UTC clock with no marker saying so: a step captured at 06:18 CDT
 * rendered as 11:18 and read as five hours stale. The detail pane keeps the
 * ISO string, so converting here is what makes the two surfaces agree.
 */
function rowClock(at: string): string {
	const instant = new Date(at);
	if (Number.isNaN(instant.getTime())) return at;
	return instant.toLocaleTimeString("en-GB", {
		hourCycle: "h23",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function activityItems(events: ReadonlyArray<TaskMemoryActivityEvent>, group: string): ListOverlayItem[] {
	const theme = clioTheme();
	return events.map((event, index) => ({
		id: `step:${index}:${event.at}`,
		label: `${theme.fg("dim", rowClock(event.at))} ${theme.fg(
			decisionToken(event.decision),
			describeTaskMemoryActivity(event),
		)}`,
		meta: theme.fg("dim", `${event.tier} ${Math.round(event.latencyMs)}ms`),
		group,
		detail: () => [
			`# ${event.at}`,
			`**Decision:** ${event.decision} (${event.reason})`,
			`**Triggers:** ${event.triggerReasons.join(", ")}`,
			`**Tier:** ${event.tier}`,
			`**Latency:** ${Math.round(event.latencyMs)}ms`,
			`**Bank writes:** ${event.bankWrites}`,
			`**Cited entries:** ${event.citedEntries}`,
		],
	}));
}

/**
 * Every memory row the operator can reach, as one grouped list.
 *
 * The counts live in the group headers because the static dump printed them as
 * section titles and they are the only place a reader learns that a class is
 * empty: a group with no rows renders no header at all.
 */
export function buildMemoryOverlayItems(
	status: TaskMemoryOperatorStatus,
	records: ReadonlyArray<MemoryRecord>,
): ListOverlayItem[] {
	const approved = records.filter((record) => record.approved && record.rejectedAt === undefined);
	const entries = bankEntries(status.bank);
	return [
		...lessonItems(approved, `approved lessons (${approved.length})`),
		...bankItems(entries, `task bank (${status.size})`),
		...activityItems(status.activity, `recent steps (${status.activity.length})`),
	];
}

function decisionToken(decision: TaskMemoryTelemetryDecision): "success" | "warning" | "muted" {
	if (decision === "injected") return "success";
	return decision === "silent" ? "muted" : "warning";
}

/**
 * A signature of everything the rows are built from.
 *
 * The overlay repaints once a second whether or not memory moved. Rebuilding
 * the item array on every one of those frames would hand the list a fresh
 * array each time, which resets nothing by itself but defeats both the list's
 * render memo and the frame's identity cache; keying the rebuild on the data
 * means an idle second costs one string compare.
 */
function memorySignature(status: TaskMemoryOperatorStatus, records: ReadonlyArray<MemoryRecord>): string {
	const parts = [
		status.enabled ? "on" : "off",
		status.tier,
		String(status.size),
		status.lastDecision ?? "none",
		status.stepInFlight ? "running" : "idle",
	];
	for (const record of records) parts.push(`r:${record.id}:${record.approved}:${record.rejectedAt ?? ""}`);
	for (const entry of bankEntries(status.bank)) {
		parts.push(`e:${entry.id}:${entry.lastTouchedAt}:${entry.injectionCount}`);
	}
	for (const event of status.activity) parts.push(`a:${event.at}:${event.decision}`);
	return parts.join("|");
}

interface OpenMemoryOverlayOptions {
	onClose?: () => void;
}

/** Master-detail memory view: status header, grouped list, scrollable detail pane. */
export class MemoryOverlayView implements Component {
	private readonly list: ListOverlayView;
	private signature: string | null = null;
	private renderMemo: { width: number; status: string; listLines: string[]; lines: string[] } | null = null;

	constructor(
		private readonly getStatus: () => TaskMemoryOperatorStatus,
		private readonly getRecords: () => ReadonlyArray<MemoryRecord>,
		onClose: () => void,
		onChange: () => void,
	) {
		this.list = new ListOverlayView(
			{
				title: "Memory",
				items: [],
				filterable: true,
				layout: "split",
				emptyMessage: EMPTY_MESSAGE,
				onClose,
			},
			onChange,
		);
	}

	getHint(): string {
		this.sync();
		return this.list.getHint();
	}

	render(width: number): string[] {
		const status = this.sync();
		const statusLine = formatMemoryStatusLine(status, width);
		const listLines = this.list.render(width);
		const memo = this.renderMemo;
		if (memo && memo.width === width && memo.status === statusLine && memo.listLines === listLines) return memo.lines;
		const lines = [statusLine, rule(clioTheme(), width), ...listLines];
		this.renderMemo = { width, status: statusLine, listLines, lines };
		return lines;
	}

	handleInput(data: string): void {
		// A key that lands between the refresh and the repaint must act on the rows
		// the operator is looking at, so the sync happens before the routing.
		this.sync();
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.renderMemo = null;
		this.list.invalidate();
	}

	private sync(): TaskMemoryOperatorStatus {
		const status = this.getStatus();
		const records = this.getRecords();
		const signature = memorySignature(status, records);
		if (signature !== this.signature) {
			this.signature = signature;
			this.list.setItems(buildMemoryOverlayItems(status, records));
		}
		return status;
	}
}

/** Mount the read-only durable-lessons and live task-bank view. */
export function openMemoryOverlay(
	tui: TUI,
	getStatus: () => TaskMemoryOperatorStatus,
	getRecords: () => ReadonlyArray<MemoryRecord>,
	options: OpenMemoryOverlayOptions = {},
): OverlayHandle {
	const view = new MemoryOverlayView(
		getStatus,
		getRecords,
		() => options.onClose?.(),
		() => tui.requestRender(),
	);
	const handle = showClioOverlayFrame(tui, view, {
		anchor: "center",
		width: MEMORY_OVERLAY_WIDTH,
		title: () => "Memory",
		footerHint: () => view.getHint(),
	});
	const timer = setInterval(() => tui.requestRender(), REFRESH_MS);
	timer.unref?.();
	return {
		...handle,
		hide(): void {
			clearInterval(timer);
			handle.hide();
		},
	};
}
