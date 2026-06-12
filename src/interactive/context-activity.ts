import {
	BusChannels,
	type ContextActivityKind,
	type ContextActivityPayload,
	type ContextActivityPhase,
	type ContextActivityStatus,
} from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { truncateToWidth, visibleWidth } from "../engine/tui.js";
import { type ClioTheme, clioTheme, GLYPH, spinnerFrame } from "./theme/index.js";

export interface ContextActivitySnapshot {
	kind: ContextActivityKind;
	phase: ContextActivityPhase;
	status: ContextActivityStatus;
	message: string;
	startedAtMs: number;
	updatedAtMs: number;
	completedAtMs: number | null;
	current: number | null;
	total: number | null;
	detail: string | null;
}

interface ContextActivityEntry extends ContextActivitySnapshot {}

export const CONTEXT_ISLAND_WIDTH = 52;
const PHASES: ReadonlyArray<ContextActivityPhase> = [
	"scan",
	"codewiki",
	"generate",
	"clio-md",
	"state",
	"handoff",
	"done",
];
const PHASE_LABELS: Record<ContextActivityPhase, string> = {
	scan: "scan",
	codewiki: "wiki",
	generate: "scout",
	"clio-md": "CLIO.md",
	state: "state",
	handoff: "handoff",
	done: "done",
};
const TERMINAL_RETENTION_MS = 4_000;

const KINDS: ReadonlySet<string> = new Set<ContextActivityKind>([
	"context-init",
	"context-clear",
	"context-prime",
	"context-handoff",
	"compaction",
]);
const PHASE_SET: ReadonlySet<string> = new Set<ContextActivityPhase>(PHASES);
const STATUSES: ReadonlySet<string> = new Set<ContextActivityStatus>(["started", "running", "completed", "failed"]);

function isContextActivityPayload(value: unknown): value is ContextActivityPayload {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<Record<keyof ContextActivityPayload, unknown>>;
	return (
		typeof record.kind === "string" &&
		KINDS.has(record.kind) &&
		typeof record.phase === "string" &&
		PHASE_SET.has(record.phase) &&
		typeof record.status === "string" &&
		STATUSES.has(record.status) &&
		typeof record.message === "string" &&
		typeof record.at === "number"
	);
}

function padAnsi(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function formatElapsed(startedAtMs: number, now: number): string {
	const elapsed = Math.max(0, now - startedAtMs);
	if (elapsed < 1000) return `${Math.round(elapsed)}ms`;
	return `${(elapsed / 1000).toFixed(elapsed < 10_000 ? 1 : 0)}s`;
}

function phaseIndex(phase: ContextActivityPhase): number {
	const index = PHASES.indexOf(phase);
	return index >= 0 ? index : 0;
}

function activityProgress(activity: ContextActivitySnapshot): number {
	if (activity.status === "completed" && activity.phase === "done") return 1;
	if (activity.total !== null && activity.total > 0 && activity.current !== null) {
		const withinPhase = Math.max(0, Math.min(1, activity.current / activity.total));
		return Math.min(1, (phaseIndex(activity.phase) + withinPhase) / PHASES.length);
	}
	return Math.min(1, phaseIndex(activity.phase) / Math.max(1, PHASES.length - 1));
}

function progressBar(theme: ClioTheme, activity: ContextActivitySnapshot, width: number): string {
	const pct = activityProgress(activity);
	const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
	const empty = Math.max(0, width - filled);
	return `${theme.fg("accent", "▰".repeat(filled))}${theme.fg("dim", "▱".repeat(empty))}`;
}

function phaseTrail(theme: ClioTheme, activity: ContextActivitySnapshot, width: number): string {
	const currentIndex = phaseIndex(activity.phase);
	const parts = PHASES.slice(0, -1).map((phase, index) => {
		const label = PHASE_LABELS[phase];
		if (index < currentIndex) return theme.fg("success", label);
		if (index === currentIndex && activity.status !== "completed") return theme.fg("accent", label);
		return theme.fg("dim", label);
	});
	return padAnsi(parts.join(theme.fg("frame", " › ")), width);
}

function statusLabel(theme: ClioTheme, activity: ContextActivitySnapshot, tick: number): string {
	if (activity.status === "failed") return theme.fg("error", `${GLYPH.error} failed`);
	if (activity.status === "completed") return theme.fg("success", `${GLYPH.ok} done`);
	return theme.fg("accent", `${spinnerFrame(tick)} ${PHASE_LABELS[activity.phase]}`);
}

function frame(theme: ClioTheme, title: string, body: string[], width: number): string[] {
	const bodyWidth = Math.max(1, width - 4);
	const label = title.length > 0 ? `─ ${title} ` : "─ ";
	const fill = Math.max(0, bodyWidth - visibleWidth(label) + 1);
	const top = `${theme.fg("frame", "┌─")}${theme.style("title", label, { bold: true })}${theme.fg("frame", "─".repeat(fill))}${theme.fg("frame", "┐")}`;
	const formattedBody = body.map(
		(line) => `${theme.fg("frame", "│")} ${padAnsi(line, bodyWidth)} ${theme.fg("frame", "│")}`,
	);
	const bottom = `${theme.fg("frame", "└")}${theme.fg("frame", "─".repeat(bodyWidth + 2))}${theme.fg("frame", "┘")}`;
	return [top, ...formattedBody, bottom];
}

export function formatContextActivityIslandLines(
	activity: ContextActivitySnapshot,
	width = CONTEXT_ISLAND_WIDTH,
	now = Date.now(),
	tick = Math.floor(now / 100),
): string[] {
	const theme = clioTheme();
	const bodyWidth = Math.max(1, width - 4);
	const title =
		activity.kind === "context-init" ? "Context Init" : activity.kind === "compaction" ? "Context Compact" : "Context";
	const topLine = `${theme.style("accent", title, { bold: true })} ${theme.fg("dim", "•")} ${statusLabel(theme, activity, tick)} ${theme.fg("dim", "•")} ${theme.fg("info", formatElapsed(activity.startedAtMs, activity.completedAtMs ?? now))}`;
	const barWidth = Math.max(8, Math.min(24, bodyWidth - 10));
	const percent = `${Math.round(activityProgress(activity) * 100)}%`.padStart(4);
	const progressLine = `${progressBar(theme, activity, barWidth)} ${theme.fg("dim", percent)}`;
	const message = theme.fg(activity.status === "failed" ? "error" : "muted", activity.message);
	const body = [
		padAnsi(topLine, bodyWidth),
		padAnsi(progressLine, bodyWidth),
		phaseTrail(theme, activity, bodyWidth),
		padAnsi(message, bodyWidth),
	];
	if (activity.detail) body.push(padAnsi(theme.fg("dim", activity.detail), bodyWidth));
	return frame(theme, "Context", body, width);
}

export function createContextActivityStore(bus: SafeEventBus): {
	current(now?: number): ContextActivitySnapshot | null;
	active(now?: number): boolean;
	unsubscribe(): void;
} {
	let current: ContextActivityEntry | null = null;
	const snapshot = (now = Date.now()): ContextActivitySnapshot | null => {
		if (!current) return null;
		if (current.completedAtMs !== null && now - current.completedAtMs > TERMINAL_RETENTION_MS) return null;
		return { ...current };
	};
	const unsubscribe = bus.on(BusChannels.ContextActivity, (raw) => {
		if (!isContextActivityPayload(raw)) return;
		const now = raw.at;
		const startsNewRun = raw.phase === "scan" && raw.status === "started";
		const startedAtMs = startsNewRun || !current ? now : current.startedAtMs;
		current = {
			kind: raw.kind,
			phase: raw.phase,
			status: raw.status,
			message: raw.message,
			startedAtMs,
			updatedAtMs: now,
			completedAtMs: raw.status === "completed" && raw.phase === "done" ? now : raw.status === "failed" ? now : null,
			current: typeof raw.current === "number" && Number.isFinite(raw.current) ? raw.current : null,
			total: typeof raw.total === "number" && Number.isFinite(raw.total) ? raw.total : null,
			detail: typeof raw.detail === "string" && raw.detail.length > 0 ? raw.detail : null,
		};
	});
	return {
		current: snapshot,
		active(now = Date.now()) {
			return snapshot(now) !== null;
		},
		unsubscribe,
	};
}
