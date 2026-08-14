import {
	describeTaskMemoryActivity,
	type MemoryRecord,
	type TaskMemoryEntry,
	type TaskMemoryOperatorStatus,
	type TaskMemoryTelemetryDecision,
} from "../domains/memory/index.js";
import {
	type Component,
	matchesKey,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "../engine/tui.js";
import { buildHint, showClioOverlayFrame } from "./overlay-frame.js";
import { clioTheme, fitUnits, rule, screenTitle } from "./theme/index.js";

const DEFAULT_CONTENT_WIDTH = 84;
const REFRESH_MS = 1_000;

export const MEMORY_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

function fitLine(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "…", true);
}

function entryLines(entry: TaskMemoryEntry, width: number): string[] {
	const theme = clioTheme();
	const lines: string[] = [];
	// Metadata line is typically short; fit to width.
	lines.push(fitLine(`${theme.fg("accent", entry.id)} ${theme.fg("dim", `injected ${entry.injectionCount}`)}`, width));
	// Wrap the content across multiple lines, preserving all text and applying muted style to each wrapped line.
	const content = entry.content;
	const wrapped = wrapTextWithAnsi(content, Math.max(1, width - 2));
	for (const line of wrapped) {
		lines.push(`  ${theme.fg("muted", line)}`);
	}
	return lines;
}

function taskClassLines(label: string, entries: ReadonlyArray<TaskMemoryEntry>, width: number): string[] {
	const theme = clioTheme();
	const lines = [screenTitle(theme, `${label} (${entries.length})`)];
	if (entries.length === 0) return [...lines, theme.fg("dim", "  none")];
	for (const entry of entries) lines.push(...entryLines(entry, width));
	return lines;
}

function approvedLessonLines(records: ReadonlyArray<MemoryRecord>, width: number): string[] {
	const theme = clioTheme();
	const approved = records.filter((record) => record.approved && record.rejectedAt === undefined);
	const lines = [screenTitle(theme, `Approved lessons (${approved.length})`)];
	if (approved.length === 0) return [...lines, theme.fg("dim", "  none")];
	for (const record of approved) {
		lines.push(fitLine(`${theme.fg("accent", record.id)} ${theme.fg("dim", `${record.scope}:${record.key}`)}`, width));
		lines.push(fitLine(`  ${theme.fg("muted", record.lesson)}`, width));
	}
	return lines;
}

/** Pure formatter used by the interactive overlay and contract tests. */
export function formatMemoryOverlayBodyLines(
	status: TaskMemoryOperatorStatus,
	records: ReadonlyArray<MemoryRecord>,
	contentWidth = DEFAULT_CONTENT_WIDTH,
): string[] {
	const theme = clioTheme();
	const width = Math.max(1, Math.floor(contentWidth));
	const statusLine = fitUnits(
		theme,
		"",
		[
			theme.fg(status.enabled ? "success" : "dim", `memory ${status.enabled ? "on" : "off"}`),
			theme.fg(status.tier === "llm" ? "reason" : "muted", `tier ${status.tier === "llm" ? "LLM" : "rules"}`),
			theme.fg("muted", `bank ${status.size}`),
			theme.fg("muted", `last ${status.lastDecision ?? "none"}`),
		],
		width,
	);
	const bank = status.bank;
	return [
		statusLine,
		rule(theme, width),
		...approvedLessonLines(records, width),
		"",
		screenTitle(theme, `Task bank (${status.size})`),
		...taskClassLines("status (private)", bank.status === null ? [] : [bank.status], width),
		...taskClassLines("knowledge", bank.knowledge, width),
		...taskClassLines("procedural", bank.procedural, width),
		"",
		...activityLines(status, width),
	];
}

/**
 * Memory steps are otherwise invisible: a capture, a gate, or a timeout leaves
 * no transcript trace, and only an injection reaches the operator. This is the
 * record of what the memory agent has actually been doing.
 */
function activityLines(status: TaskMemoryOperatorStatus, width: number): string[] {
	const theme = clioTheme();
	const lines = [screenTitle(theme, `Recent steps (${status.activity.length})`)];
	if (status.stepInFlight) lines.push(fitLine(theme.fg("reason", "  a background step is running"), width));
	if (status.activity.length === 0) {
		return [...lines, theme.fg("dim", status.stepInFlight ? "  no completed step yet" : "  none")];
	}
	for (const event of status.activity) {
		lines.push(
			fitLine(
				`  ${theme.fg("dim", event.at.slice(11, 19))} ${theme.fg(
					decisionToken(event.decision),
					describeTaskMemoryActivity(event),
				)} ${theme.fg("dim", `${event.tier} ${Math.round(event.latencyMs)}ms`)}`,
				width,
			),
		);
	}
	return lines;
}

function decisionToken(decision: TaskMemoryTelemetryDecision): "success" | "warning" | "muted" {
	if (decision === "injected") return "success";
	return decision === "silent" ? "muted" : "warning";
}

interface OpenMemoryOverlayOptions {
	onClose?: () => void;
}

class MemoryOverlayBody implements Component {
	constructor(
		private readonly getStatus: () => TaskMemoryOperatorStatus,
		private readonly getRecords: () => ReadonlyArray<MemoryRecord>,
		private readonly options: OpenMemoryOverlayOptions,
	) {}

	render(width: number): string[] {
		return formatMemoryOverlayBodyLines(this.getStatus(), this.getRecords(), width);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "esc")) this.options.onClose?.();
	}

	invalidate(): void {}
}

/** Mount the read-only durable-lessons and live task-bank view. */
export function openMemoryOverlay(
	tui: TUI,
	getStatus: () => TaskMemoryOperatorStatus,
	getRecords: () => ReadonlyArray<MemoryRecord>,
	options: OpenMemoryOverlayOptions = {},
): OverlayHandle {
	const body = new MemoryOverlayBody(getStatus, getRecords, options);
	const handle = showClioOverlayFrame(tui, body, {
		anchor: "center",
		width: MEMORY_OVERLAY_WIDTH,
		title: () => "Memory",
		footerHint: () => buildHint([]),
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
