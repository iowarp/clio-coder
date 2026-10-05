import type {
	ContextActivityKind,
	ContextActivityPayload,
	ContextActivityPhase,
	ContextActivityStatus,
} from "../core/bus-events.js";
import { BusChannels } from "../core/bus-events.js";
import type { ContextOperationOutcome } from "../core/context-operation.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { Component } from "../engine/tui.js";
import { visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { CONTEXT_KIND_TITLES, outcomeTone, outcomeWord, plain } from "./context-operation-view.js";
import { animationStep, clioTheme, formatCompactMs, GLYPH, padAnsi, spinnerFrame } from "./theme/index.js";

export interface ContextActivitySnapshot {
	operation?: ContextActivityPayload["operation"];
	/** The operation's own conclusion once it has one; stage events never carry it. */
	outcome?: ContextOperationOutcome;
	/** Other operations still running behind the one this snapshot describes. */
	otherRunning?: number;
	kind: ContextActivityKind;
	phase: ContextActivityPhase;
	status: ContextActivityStatus;
	message: string;
	startedAtMs: number;
	phaseStartedAtMs?: number;
	timing?: ContextActivityPayload["timing"];
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
const TERMINAL_RETENTION_MS = 6000;
/** More than a handful of concurrent context operations means a leak, not work. */
const MAX_TRACKED_RUNS = 8;

function phasesFor(activity: ContextActivitySnapshot): ReadonlyArray<ContextActivityPhase> {
	if (activity.stages?.length) return activity.stages.filter((phase) => phase !== "done");
	if (activity.kind === "compaction") return ["compact", "summarize", "state"];
	if (activity.kind === "context-clear" || activity.kind === "context-recall" || activity.kind === "context-recover")
		return ["state"];
	if (activity.kind === "context-refresh") return ["codewiki", "state"];
	return PHASES.slice(0, -1);
}

export interface ContextRailOptions {
	/** What Enter does with a message typed right now; shown only while the operation runs. */
	admission?: string | null;
}

/** A full-width, three-row instrument immediately above the input rails. */
export function formatContextActivityRailLines(
	activity: ContextActivitySnapshot,
	width: number,
	now = Date.now(),
	tick = animationStep(now),
	options: ContextRailOptions = {},
): string[] {
	if (width <= 0) return [];
	const theme = clioTheme();
	const outcome = activity.outcome;
	const settled = activity.completedAtMs !== null;
	const done = settled && activity.status === "completed";
	const failed = activity.status === "failed";
	const cancelled = outcome === "cancelled";
	const stages = phasesFor(activity);
	const index = done ? stages.length : Math.max(0, stages.indexOf(activity.phase));
	const elapsed = formatCompactMs(Math.max(0, (activity.completedAtMs ?? now) - activity.startedAtMs));
	const tone = outcome ? outcomeTone(outcome) : failed ? "error" : done ? "success" : "contextAction";
	const glyph = cancelled ? GLYPH.warn : failed ? GLYPH.error : done ? GLYPH.ok : spinnerFrame(tick);
	const title = theme.fg(tone, `${glyph} ${CONTEXT_KIND_TITLES[activity.kind]}`);
	const step = settled
		? outcome
			? outcomeWord(outcome)
			: failed
				? "failed"
				: "complete"
		: `${Math.min(stages.length, index + 1)}/${stages.length} ${PHASE_LABELS[activity.phase]}`;
	let header = `${title} ${theme.fg("annotation", `· ${step}`)}`;
	const clock = theme.fg("toolMetadata", elapsed);
	if (width >= 72 && !settled) {
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
	// The bar measures the running stage only. Stage position is already in the
	// trail and the step label; weighting stages equally filled 40% of the bar
	// before a four-minute draft began (index finishes in under a second).
	// Known counts fill the bar. Unknown work advances an unfilled marker
	// monotonically within the stage without claiming a percentage (flywheel r4/1).
	const known =
		activity.total !== null && activity.total > 0 && activity.current !== null
			? Math.max(0, Math.min(1, activity.current / activity.total))
			: activity.status === "completed"
				? 1
				: null;
	const filled = done ? width : known === null ? 0 : Math.min(width - 1, Math.floor(known * width));
	const stageElapsed = Math.max(0, now - (activity.phaseStartedAtMs ?? activity.startedAtMs));
	const marker =
		known === null && !done && !failed ? Math.floor(((width - 1) * stageElapsed) / (stageElapsed + 30_000)) : filled;
	const remaining = width - marker;
	rows.push(
		theme.fg(tone, GLYPH.barFull.repeat(known === null ? 0 : filled)) +
			theme.fg("meterFree", GLYPH.barEmpty.repeat(known === null ? marker : 0)) +
			(!done ? theme.fg(tone, failed ? GLYPH.error : "▸") : "") +
			theme.fg("meterFree", GLYPH.barEmpty.repeat(Math.max(0, remaining - (done ? 0 : 1)))),
	);
	const counts = activity.current !== null && activity.total !== null ? ` · ${activity.current}/${activity.total}` : "";
	const timing = activity.timing;
	const detail = timing
		? ` · ${Math.max(0, Math.floor(((activity.completedAtMs ?? now) - timing.startedAtMs) / 1000))}s / ${Math.round(timing.timeoutMs / 1000)}s limit · run ${plain(timing.runId)}`
		: activity.detail
			? ` · ${plain(activity.detail)}`
			: "";
	const others = !settled && activity.otherRunning ? ` · +${activity.otherRunning} more running` : "";
	const text = `${plain(activity.message)}${counts}${detail}${others}`;
	const message = theme.fg(failed ? tone : "annotation", text);
	if (failed) {
		rows.push(...wrapTextWithAnsi(message, Math.max(1, width)).map((line) => padAnsi(line, width)));
		return rows;
	}
	// The admission hint is the one fact a person typing needs while the harness
	// is busy, so a narrow rail gives it the row before the progress detail.
	const hint = !settled && options.admission ? plain(options.admission) : "";
	const hintRoom = hint ? visibleWidth(hint) + 3 : 0;
	if (hint && width - hintRoom >= 16) {
		rows.push(
			`${padAnsi(message, width - hintRoom, GLYPH.ellipsis)}${theme.fg("border", " · ")}${theme.fg("harnessAction", hint)}`,
		);
	} else if (hint) {
		rows.push(padAnsi(theme.fg("harnessAction", hint), width, GLYPH.ellipsis));
	} else {
		rows.push(padAnsi(message, width, GLYPH.ellipsis));
	}
	return rows;
}

export function createContextProgressRail(
	getActivity: () => ContextActivitySnapshot | null,
	getAdmission?: (activity: ContextActivitySnapshot) => string | null,
): Component {
	return {
		render(width) {
			const activity = getActivity();
			if (!activity) return [];
			const admission = getAdmission?.(activity) ?? null;
			return formatContextActivityRailLines(activity, width, Date.now(), animationStep(Date.now()), { admission });
		},
		invalidate() {},
	};
}

/**
 * Tracks every context operation the harness reports for this session and
 * folder. Runs are keyed by operation id so a late event from an older
 * operation never overwrites a newer one; events without an operation (legacy
 * emitters) share one run per kind.
 */
export function createContextActivityStore(
	bus: SafeEventBus,
	getSessionId?: () => string | null,
): {
	current(now?: number): ContextActivitySnapshot | null;
	active(now?: number): boolean;
	unsubscribe(): void;
} {
	// Map order is start order: `set` on an existing key keeps its position.
	const runs = new Map<string, ContextActivitySnapshot>();
	const owned = (operation: ContextActivitySnapshot["operation"]): boolean =>
		!operation ||
		(operation.cwd === process.cwd() && (getSessionId === undefined || operation.sessionId === getSessionId()));
	const snapshot = (now = Date.now()): ContextActivitySnapshot | null => {
		for (const [key, run] of runs) {
			if (!owned(run.operation) || (run.completedAtMs !== null && now - run.completedAtMs > TERMINAL_RETENTION_MS))
				runs.delete(key);
		}
		const running = [...runs.values()].filter((run) => run.completedAtMs === null);
		const chosen =
			running[0] ??
			[...runs.values()].reduce<ContextActivitySnapshot | null>(
				(latest, run) => (latest === null || (run.completedAtMs ?? 0) >= (latest.completedAtMs ?? 0) ? run : latest),
				null,
			);
		if (!chosen) return null;
		return { ...chosen, ...(running.length > 1 && chosen === running[0] ? { otherRunning: running.length - 1 } : {}) };
	};
	const unsubscribe = bus.on(BusChannels.ContextActivity, (raw: ContextActivityPayload) => {
		if (
			!raw ||
			!Object.hasOwn(CONTEXT_KIND_TITLES, raw.kind) ||
			!Object.hasOwn(PHASE_LABELS, raw.phase) ||
			!["started", "running", "completed", "failed"].includes(raw.status) ||
			typeof raw.message !== "string" ||
			!Number.isFinite(raw.at)
		)
			return;
		if (!owned(raw.operation)) return;
		const key = raw.operation?.id ?? `legacy:${raw.kind}`;
		const previous = runs.get(key);
		const stages = Array.isArray(raw.stages)
			? [...new Set(raw.stages.filter((phase) => Object.hasOwn(PHASE_LABELS, phase) && phase !== "done"))]
			: undefined;
		// An operation id names one run. Legacy emitters have no id, so a fresh
		// `scan` start or a start after completion begins a new run of that kind.
		const startsNewRun =
			!previous ||
			(raw.operation === undefined &&
				raw.status === "started" &&
				(raw.phase === "scan" || previous.completedAtMs !== null));
		const outcome = raw.operation?.outcome;
		const terminal =
			outcome !== undefined || (raw.phase === "done" && raw.status === "completed") || raw.status === "failed";
		const next: ContextActivitySnapshot = {
			...(raw.operation ? { operation: raw.operation } : {}),
			...(outcome ? { outcome } : {}),
			kind: raw.kind,
			phase: raw.phase,
			status: raw.status,
			message: raw.message,
			startedAtMs: startsNewRun || !previous ? raw.at : previous.startedAtMs,
			phaseStartedAtMs:
				startsNewRun || !previous || previous.phase !== raw.phase
					? raw.at
					: (previous.phaseStartedAtMs ?? previous.startedAtMs),
			updatedAtMs: raw.at,
			completedAtMs: terminal ? raw.at : null,
			current: typeof raw.current === "number" && Number.isFinite(raw.current) ? raw.current : null,
			total: typeof raw.total === "number" && Number.isFinite(raw.total) ? raw.total : null,
			detail: typeof raw.detail === "string" && raw.detail.length > 0 ? raw.detail : null,
			...(raw.timing &&
			Number.isFinite(raw.timing.startedAtMs) &&
			Number.isFinite(raw.timing.timeoutMs) &&
			typeof raw.timing.runId === "string"
				? { timing: { ...raw.timing } }
				: {}),
			...(stages?.length ? { stages } : !startsNewRun && previous?.stages ? { stages: previous.stages } : {}),
		};
		// A legacy run that restarts leaves its old entry behind it in start order.
		if (startsNewRun) runs.delete(key);
		runs.set(key, next);
		while (runs.size > MAX_TRACKED_RUNS) {
			const oldest = runs.keys().next().value;
			if (oldest === undefined) break;
			runs.delete(oldest);
		}
	});
	// A switched session or branch owns none of these runs.
	const clears = [BusChannels.SessionParked, BusChannels.SessionResumed, BusChannels.SessionTurnSwitched].map(
		(channel) => bus.on(channel, () => runs.clear()),
	);
	return {
		current: snapshot,
		active: (now = Date.now()) => snapshot(now) !== null,
		unsubscribe: () => {
			unsubscribe();
			for (const clear of clears) clear();
		},
	};
}
