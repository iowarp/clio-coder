import type {
	ContextActivityKind,
	ContextActivityPayload,
	ContextActivityPhase,
	ContextActivityStatus,
} from "../core/bus-events.js";
import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { Component } from "../engine/tui.js";
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { animationStep, clioTheme, formatCompactMs, GLYPH, padAnsi, spinnerFrame } from "./theme/index.js";

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
	stages?: ReadonlyArray<ContextActivityPhase>;
}

const PHASES: ReadonlyArray<ContextActivityPhase> = ["scan", "codewiki", "generate", "clio-md", "state", "done"];
const PHASE_LABELS: Record<ContextActivityPhase, string> = {
	scan: "scan",
	codewiki: "index",
	generate: "draft",
	"clio-md": "handbook",
	state: "save",
	compact: "prepare",
	summarize: "summarize",
	done: "done",
};
const TITLES: Record<ContextActivityKind, string> = {
	"context-init": "Context init",
	"context-clear": "Context reset",
	"context-refresh": "Context refresh",
	compaction: "Context compact",
};
const TERMINAL_RETENTION_MS = 6000;

function phasesFor(activity: ContextActivitySnapshot): ReadonlyArray<ContextActivityPhase> {
	if (activity.stages?.length) return activity.stages.filter((phase) => phase !== "done");
	if (activity.kind === "compaction") return ["compact", "summarize", "state"];
	if (activity.kind === "context-clear") return ["state"];
	if (activity.kind === "context-refresh") return ["codewiki", "state"];
	return PHASES.slice(0, -1);
}

function plain(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: progress includes untrusted filenames and provider error text.
	const cleaned = stripTerminalSequences(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
	return cleaned.replace(/\s+/g, " ").trim();
}

/** A full-width, three-row instrument immediately above the input rails. */
export function formatContextActivityRailLines(
	activity: ContextActivitySnapshot,
	width: number,
	now = Date.now(),
	tick = animationStep(now),
): string[] {
	if (width <= 0) return [];
	const theme = clioTheme();
	const done = activity.completedAtMs !== null && activity.status === "completed";
	const failed = activity.status === "failed";
	const stages = phasesFor(activity);
	const index = done ? stages.length : Math.max(0, stages.indexOf(activity.phase));
	const elapsed = formatCompactMs(Math.max(0, (activity.completedAtMs ?? now) - activity.startedAtMs));
	const tone = failed ? "error" : done ? "success" : "contextAction";
	const glyph = failed ? GLYPH.error : done ? GLYPH.ok : spinnerFrame(tick);
	const title = theme.fg(tone, `${glyph} ${TITLES[activity.kind]}`);
	const step = done
		? "complete"
		: failed
			? "failed"
			: `${Math.min(stages.length, index + 1)}/${stages.length} ${PHASE_LABELS[activity.phase]}`;
	let header = `${title} ${theme.fg("annotation", `· ${step}`)}`;
	const clock = theme.fg("toolMetadata", elapsed);
	if (width >= 72 && !done && !failed) {
		const trail = stages
			.map((phase, position) =>
				theme.fg(position < index ? "success" : position === index ? "contextAction" : "annotation", PHASE_LABELS[phase]),
			)
			.join(theme.fg("border", " › "));
		header = `${title}  ${trail}`;
	}
	const rows = [
		padAnsi(
			`${padAnsi(header, Math.max(0, width - visibleWidth(clock) - 1), GLYPH.ellipsis)} ${clock}`,
			width,
			GLYPH.ellipsis,
		),
	];
	// Stage completion determines filled length. A moving marker inside the
	// current stage signals unknown work; it never invents an ETA or percentage.
	const fraction =
		activity.total !== null && activity.total > 0 && activity.current !== null
			? Math.max(0, Math.min(1, activity.current / activity.total))
			: activity.status === "completed"
				? 1
				: 0;
	const filled = done ? width : Math.min(width - 1, Math.floor(((index + fraction) / stages.length) * width));
	const remaining = width - filled;
	const pulse =
		!done && !failed && fraction === 0
			? Math.min(remaining - 1, tick % Math.max(1, Math.floor(width / stages.length)))
			: 0;
	rows.push(
		theme.fg(tone, GLYPH.barFull.repeat(filled)) +
			theme.fg("meterFree", GLYPH.barEmpty.repeat(pulse)) +
			(!done ? theme.fg(tone, failed ? GLYPH.error : "▸") : "") +
			theme.fg("meterFree", GLYPH.barEmpty.repeat(Math.max(0, remaining - pulse - (done ? 0 : 1)))),
	);
	const counts = activity.current !== null && activity.total !== null ? ` · ${activity.current}/${activity.total}` : "";
	const detail = activity.detail ? ` · ${plain(activity.detail)}` : "";
	const message = theme.fg(failed ? "error" : "annotation", `${plain(activity.message)}${counts}${detail}`);
	if (failed) rows.push(...wrapTextWithAnsi(message, Math.max(1, width)).map((line) => padAnsi(line, width)));
	else rows.push(padAnsi(message, width, GLYPH.ellipsis));
	return rows;
}

export function createContextProgressRail(getActivity: () => ContextActivitySnapshot | null): Component {
	return {
		render(width) {
			const activity = getActivity();
			return activity ? formatContextActivityRailLines(activity, width) : [];
		},
		invalidate() {},
	};
}

export function createContextActivityStore(bus: SafeEventBus): {
	current(now?: number): ContextActivitySnapshot | null;
	active(now?: number): boolean;
	unsubscribe(): void;
} {
	let current: ContextActivitySnapshot | null = null;
	const snapshot = (now = Date.now()): ContextActivitySnapshot | null => {
		if (!current || (current.completedAtMs !== null && now - current.completedAtMs > TERMINAL_RETENTION_MS)) return null;
		return { ...current };
	};
	const unsubscribe = bus.on(BusChannels.ContextActivity, (raw: ContextActivityPayload) => {
		if (
			!raw ||
			!Object.hasOwn(TITLES, raw.kind) ||
			!Object.hasOwn(PHASE_LABELS, raw.phase) ||
			!["started", "running", "completed", "failed"].includes(raw.status) ||
			typeof raw.message !== "string" ||
			!Number.isFinite(raw.at)
		)
			return;
		const stages = Array.isArray(raw.stages)
			? [...new Set(raw.stages.filter((phase) => Object.hasOwn(PHASE_LABELS, phase) && phase !== "done"))]
			: undefined;
		const startsNewRun =
			raw.status === "started" &&
			(raw.phase === "scan" || !current || current.completedAtMs !== null || current.kind !== raw.kind);
		current = {
			kind: raw.kind,
			phase: raw.phase,
			status: raw.status,
			message: raw.message,
			startedAtMs: startsNewRun || !current ? raw.at : current.startedAtMs,
			updatedAtMs: raw.at,
			completedAtMs: (raw.phase === "done" && raw.status === "completed") || raw.status === "failed" ? raw.at : null,
			current: typeof raw.current === "number" && Number.isFinite(raw.current) ? raw.current : null,
			total: typeof raw.total === "number" && Number.isFinite(raw.total) ? raw.total : null,
			detail: typeof raw.detail === "string" && raw.detail.length > 0 ? raw.detail : null,
			...(stages?.length ? { stages } : !startsNewRun && current?.stages ? { stages: current.stages } : {}),
		};
	});
	return { current: snapshot, active: (now = Date.now()) => snapshot(now) !== null, unsubscribe };
}
