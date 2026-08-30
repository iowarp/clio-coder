import {
	BusChannels,
	type ContextActivityKind,
	type ContextActivityPayload,
	type ContextActivityPhase,
	type ContextActivityStatus,
} from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { type ClioTheme, clioTheme, formatCompactMs, frame, GLYPH, padAnsi, spinnerFrame } from "./theme/index.js";

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
const PHASES: ReadonlyArray<ContextActivityPhase> = ["scan", "codewiki", "generate", "clio-md", "state", "done"];
/**
 * A wiki run only ever emits codewiki, generate, state, and done. Trailing the
 * bootstrap phases it never reaches would leave `scan` and `CLIO-CODER.md` dimmed for
 * the whole run and would stretch the progress bar across steps that cannot
 * happen.
 */
const WIKI_PHASES: ReadonlyArray<ContextActivityPhase> = ["codewiki", "generate", "state", "done"];
/** Compaction is one bounded operation, not the five-stage context-init pipeline. */
const COMPACTION_PHASES: ReadonlyArray<ContextActivityPhase> = ["compact", "done"];
const PHASE_LABELS: Record<ContextActivityPhase, string> = {
	scan: "scan",
	// "index" rather than "wiki": this phase is the codewiki index build, and
	// `context-wiki` runs made the old label ambiguous with the Markdown wiki.
	codewiki: "index",
	generate: "draft",
	"clio-md": "CLIO-CODER.md",
	state: "state",
	compact: "compact",
	done: "done",
};
const WIKI_PHASE_LABELS: Partial<Record<ContextActivityPhase, string>> = {
	generate: "pages",
	state: "promote",
};
const TERMINAL_RETENTION_MS = 4_000;

const KINDS: ReadonlySet<string> = new Set<ContextActivityKind>([
	"context-init",
	"context-clear",
	"context-refresh",
	"context-wiki",
	"compaction",
]);
const PHASE_SET: ReadonlySet<string> = new Set<ContextActivityPhase>([...PHASES, ...COMPACTION_PHASES]);

function phasesFor(kind: ContextActivityKind): ReadonlyArray<ContextActivityPhase> {
	if (kind === "compaction") return COMPACTION_PHASES;
	return kind === "context-wiki" ? WIKI_PHASES : PHASES;
}

function phaseLabel(kind: ContextActivityKind, phase: ContextActivityPhase): string {
	if (kind === "context-wiki") return WIKI_PHASE_LABELS[phase] ?? PHASE_LABELS[phase];
	return PHASE_LABELS[phase];
}
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

function phaseIndex(kind: ContextActivityKind, phase: ContextActivityPhase): number {
	const index = phasesFor(kind).indexOf(phase);
	return index >= 0 ? index : 0;
}

function activityProgress(activity: ContextActivitySnapshot): number {
	if (activity.status === "completed" && activity.phase === "done") return 1;
	const phases = phasesFor(activity.kind);
	const index = phaseIndex(activity.kind, activity.phase);
	if (activity.total !== null && activity.total > 0 && activity.current !== null) {
		const withinPhase = Math.max(0, Math.min(1, activity.current / activity.total));
		return Math.min(1, (index + withinPhase) / phases.length);
	}
	return Math.min(1, index / Math.max(1, phases.length - 1));
}

function progressBar(theme: ClioTheme, activity: ContextActivitySnapshot, width: number): string {
	const pct = activityProgress(activity);
	const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
	const empty = Math.max(0, width - filled);
	return `${theme.fg("accent", "▰".repeat(filled))}${theme.fg("dim", "▱".repeat(empty))}`;
}

function phaseTrail(theme: ClioTheme, activity: ContextActivitySnapshot, width: number): string {
	const currentIndex = phaseIndex(activity.kind, activity.phase);
	const parts = phasesFor(activity.kind)
		.slice(0, -1)
		.map((phase, index) => {
			const label = phaseLabel(activity.kind, phase);
			if (index < currentIndex) return theme.fg("success", label);
			if (index === currentIndex && activity.status !== "completed") return theme.fg("accent", label);
			return theme.fg("dim", label);
		});
	return padAnsi(parts.join(theme.fg("frame", " › ")), width, GLYPH.ellipsis);
}

function statusLabel(theme: ClioTheme, activity: ContextActivitySnapshot, tick: number): string {
	if (activity.status === "failed") return theme.fg("error", `${GLYPH.error} failed`);
	if (activity.status === "completed") return theme.fg("success", `${GLYPH.ok} done`);
	return theme.fg("accent", `${spinnerFrame(tick)} ${phaseLabel(activity.kind, activity.phase)}`);
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
		activity.kind === "context-init"
			? "Context Init"
			: activity.kind === "context-refresh"
				? "Context Refresh"
				: activity.kind === "context-wiki"
					? "Context Wiki"
					: activity.kind === "compaction"
						? "Context Compact"
						: "Context";
	const elapsedMs = Math.max(0, (activity.completedAtMs ?? now) - activity.startedAtMs);
	const topLine = `${theme.style("accent", title, { bold: true })} ${theme.fg("dim", "·")} ${statusLabel(theme, activity, tick)} ${theme.fg("dim", "·")} ${theme.fg("info", formatCompactMs(elapsedMs))}`;
	const barWidth = Math.max(8, Math.min(24, bodyWidth - 10));
	const percent = `${Math.round(activityProgress(activity) * 100)}%`.padStart(4);
	const progressLine = `${progressBar(theme, activity, barWidth)} ${theme.fg("dim", percent)}`;
	const message = theme.fg(activity.status === "failed" ? "error" : "muted", activity.message);
	// Every row here can outrun a narrow island: at 40 columns the trail stopped
	// at "sta" and the message at "refreshed pr", each reading as the whole
	// value. padAnsi's default marker is empty, so the marker is passed
	// explicitly. The progress bar is sized to fit and never cuts.
	const body = [
		padAnsi(topLine, bodyWidth, GLYPH.ellipsis),
		padAnsi(progressLine, bodyWidth),
		phaseTrail(theme, activity, bodyWidth),
		padAnsi(message, bodyWidth, GLYPH.ellipsis),
	];
	if (activity.detail) body.push(padAnsi(theme.fg("dim", activity.detail), bodyWidth, GLYPH.ellipsis));
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
		const startsNewRun =
			raw.status === "started" &&
			(raw.phase === "scan" || !current || current.completedAtMs !== null || current.kind !== raw.kind);
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
