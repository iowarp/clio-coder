import { ToolNames } from "../../core/tool-names.js";
import type { LiveBudgetView } from "../../domains/context/budget/live-view.js";
import type { LocalCapacity } from "../../domains/scheduling/local-capacity.js";
import type { ContextUsageBreakdown } from "../../domains/session/context-accounting.js";
import type { ContextLedger } from "../../domains/session/context-ledger.js";
import type { TaskBoardSnapshot } from "../../domains/session/task-board.js";
import { taskBoardCounts } from "../../domains/session/task-board.js";
import type { TokenThroughputSnapshot } from "../../domains/telemetry/index.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { finiteNonNegative } from "../context-bar.js";
import { contextPercentRole } from "../context-meter.js";
import type { DispatchBoardRow } from "../dispatch-board.js";
import { fitFooterText, formatFooterTokens } from "../footer-panel.js";
import type { AgentStatus, TurnSummary } from "../status/index.js";
import { formatReasoningChip, type ReasoningUsageView, spinnerFrame } from "../status/index.js";
import type { ClioTheme, ClioToken } from "../theme/index.js";
import {
	FUNCTION_ROLES,
	formatCompactMs,
	formatContextPercent,
	GLYPH,
	joinChips,
	padAnsi,
	toolFunction,
} from "../theme/index.js";
import { type ContextOccupancyFacts, contextUsagePercent } from "./context-rail.js";
import type { FooterTelemetry } from "./spend.js";

export interface ToolTallySnapshot {
	tools: Readonly<Record<string, number>>;
	errors: number;
	active?: number;
	truncatedResults?: number;
}

/** Live workspace facts. Owned by the footer (the welcome header no longer repeats the branch). */
export interface WorkspaceFacts {
	cwd: string;
	branch: string | null;
	/** The first probe has not landed, so a missing branch means unknown rather than no Git. */
	branchPending?: boolean;
	dirty: boolean | null;
	projectType: string | null;
	remote: string | null;
}

export interface SessionFacts {
	name?: string | null;
	target: string | null;
	/** Raw route fields for boundary-aware fitting in the compact footer. */
	targetId?: string | null;
	modelId?: string | null;
	/**
	 * Ctrl+G armed the portable leader and is waiting for the next key. Shown
	 * because the frame between the two keystrokes was otherwise identical to
	 * the idle frame, on the fallback whose users have no working Alt to check
	 * it against.
	 */
	leaderArmed?: boolean;
	/**
	 * A Ctrl+C landed on an idle empty prompt and the 500ms window that quits is
	 * open. Shown for the same reason as the leader above: the arming press left
	 * the frame identical to the idle frame, so the operator had no way to learn
	 * that a second press quits, and no way to tell the first press registered.
	 */
	/** A string is the exact line to show, with the time left and what happens to a draft. */
	shutdownArmed?: boolean | string;
	/**
	 * Skills whose tool surface stays armed across turns. Shown on the compact
	 * line while it lasts, so a narrowed tool set is never implicit.
	 */
	duckBadge?: boolean;
	activeSkills?: ReadonlyArray<string>;
	/** Explicit mode remains readable after transient setting feedback expires. */
	autonomy?: string;
	/** Proactive-memory status; kept as one atomic fact row in the expanded dashboard. */
	memoryIntervention?: {
		enabled: boolean;
		tier: "rules" | "llm";
		size: number;
		stepInFlight?: boolean;
		lastDecision?: string | null;
		/** Always-on guardian state; absent on surfaces that do not run it. */
		guardian?: "off" | "idle" | "reviewing" | "waiting-capacity" | "unavailable";
	} | null;
}

/** Context engine telemetry. */
export interface ContextEngineFacts {
	/** Identifies the published accounting used by the meter; ledger stays diagnostic. */
	budget?: Pick<LiveBudgetView, "revision" | "historical" | "inputSource">;
	label: string | null;
	used: number | null;
	contextWindow: number | null;
	toolSchemaTokens: number | null;
	compactionThreshold: number | null;
	compactionAuto: boolean | null;
	compactionActive?: boolean;
	clioMd: string | null;
	memory: string | null;
	extensions: { active: number; installed: number } | null;
	breakdown?: ContextUsageBreakdown | null;
	/** Full categorized ledger; when present the quadrant renders the richer meter. */
	ledger?: ContextLedger | null;
}

/** Dynamic agent work: the live action quadrant. */
export interface AgentWorkFacts {
	statusText: string | null;
	dispatchSummary: string | null;
	toolTally: string;
	dispatchRows: ReadonlyArray<DispatchBoardRow>;
	contextActivity?: {
		message: string;
		detail: string | null;
		status: "started" | "running" | "completed" | "failed";
	} | null;
	/** Metrics for the most recent completed turn, surfaced when the agent is idle. */
	lastTurn: TurnSummary | null;
	/** Session task board declared through the tasks tool; null before any plan. */
	taskBoard?: TaskBoardSnapshot | null;
	/** Local node worker limit and what bound it; null when unknown. */
	localCapacity?: LocalCapacity | null;
}

/**
 * The `visibleWidth` guard looks redundant against `truncateToWidth`, which
 * measures internally, but it is not: dropping it pads wide-char truncations
 * with a trailing space and strips a bare ANSI reset at width 0. Both are
 * visible output, so the extra measurement stays.
 */
export function fitDashboardLine(line: string, width: number): string {
	return fitFooterText(line, width, GLYPH.ellipsis);
}

/**
 * Pad or truncate an already styled string to an exact column width. A cut is
 * marked with an ellipsis so a clipped value ("proj 1.", "read 14 · bash 9 ")
 * never reads as a complete fact.
 */
function cell(text: string, width: number): string {
	return padAnsi(text, width, GLYPH.ellipsis);
}

/**
 * The tools row answers two different questions and used to answer only the
 * second: what the model can reach, and what it has called. `registered` is the
 * count of tool schemas sent to the provider this turn, so a session that has
 * only dispatched still reports the tools it holds instead of reading "none",
 * which said the model had no tools at all.
 */
export function formatToolTally(snapshot: ToolTallySnapshot | null | undefined, registered?: number | null): string {
	const available =
		typeof registered === "number" && Number.isFinite(registered) && registered > 0
			? `${Math.floor(registered)} avail`
			: null;
	if (!snapshot) return `${available ?? "none"} · 0${GLYPH.error}`;
	const entries = Object.entries(snapshot.tools)
		.filter(([name, count]) => count > 0 && name.toLowerCase() !== "dispatch")
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 4)
		.map(([name, count]) => `${name} ${formatFooterTokens(count)}`);
	const called = entries.length > 0 ? entries.join(" · ") : available !== null ? null : "none";
	const prefix = [available, called].filter((part): part is string => part !== null).join(" · ");
	const active =
		typeof snapshot.active === "number" && snapshot.active > 0 ? ` · active ${formatFooterTokens(snapshot.active)}` : "";
	const truncated =
		typeof snapshot.truncatedResults === "number" && snapshot.truncatedResults > 0
			? ` · trunc ${formatFooterTokens(snapshot.truncatedResults)}`
			: "";
	return `${prefix}${active}${truncated} · ${formatFooterTokens(snapshot.errors)}${GLYPH.error}`;
}

/** Short truthful occupancy label shared by compact and expanded surfaces. */
export function contextUsageText(context: ContextEngineFacts): string {
	const used = context.budget ? context.used : (context.ledger?.usedTokens ?? context.used);
	const window = context.budget ? context.contextWindow : (context.ledger?.contextWindow ?? context.contextWindow);
	const source = context.budget?.inputSource === "historical" ? "saved " : context.budget && used !== null ? "~" : "";
	return `${source}${used === null ? "?" : formatFooterTokens(used)} / ${window ? formatFooterTokens(window) : "unknown"}`;
}

/** Compact counts and occupancy; source details remain in the expanded dashboard. */
export function compactContextUsage(
	context: ContextOccupancyFacts,
	theme: ClioTheme,
	room = Number.POSITIVE_INFINITY,
): string {
	const used = context.budget ? context.used : (context.ledger?.usedTokens ?? context.used);
	const window = context.budget ? context.contextWindow : (context.ledger?.contextWindow ?? context.contextWindow);
	// Before the first measured turn only the window is known; question marks
	// read as a fault, so the row names the window alone.
	if (used === null && window) return theme.fg("counter", `${formatFooterTokens(window).toUpperCase()} ctx`);
	// Neither figure is known yet (the first seconds after launch): show nothing
	// rather than `?/unknown`.
	if (used === null) return "";
	const counts = `${formatFooterTokens(used).toUpperCase()}/${window ? formatFooterTokens(window).toUpperCase() : "unknown"}`;
	const percent = contextUsagePercent(context);
	if (!window) return theme.fg("counter", counts);
	const full = `${theme.fg("counter", counts)} ${theme.fg(contextPercentRole(percent), `(${formatContextPercent(percent)})`)}`;
	if (visibleWidth(full) <= room) return full;
	// A narrow row keeps the counts and drops the percent, then states the percent
	// whole rather than cut either mid-figure.
	return visibleWidth(counts) <= room
		? theme.fg("counter", counts)
		: `${theme.fg("counter", "ctx")} ${theme.fg(contextPercentRole(percent), formatContextPercent(percent))}`;
}

function stopReasonStyle(reason: TurnSummary["stopReason"]): { glyph: string; token: ClioToken } {
	if (reason === "error") return { glyph: GLYPH.error, token: "error" };
	if (reason === "aborted" || reason === "cancelled") return { glyph: GLYPH.cancelled, token: "annotation" };
	if (reason === "length" || reason === "generation_guard") return { glyph: GLYPH.warn, token: "warning" };
	return { glyph: GLYPH.ok, token: "success" };
}

/** The streaming turn's live rate, or else the newest settled main call's rate and TTFT from the read model (#434). */
export function formattedThroughput(
	theme: ClioTheme,
	throughput: TokenThroughputSnapshot | null | undefined,
	telemetry: FooterTelemetry | undefined,
): string | null {
	const settled = throughput ? null : telemetry?.kind === "ready" ? telemetry.speed : null;
	const tps = finiteNonNegative(throughput ? throughput.tokensPerSecond : settled?.tokensPerSecond);
	const estimated = throughput ? throughput.estimated === true : settled?.estimated === true;
	const rounded = tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10;
	const parts = [
		tps > 0
			? `${theme.fg("metricValue", `${GLYPH.speed}${estimated ? "≈" : ""}${rounded}`)} ${theme.fg("metricUnit", "Tk/s")}`
			: null,
		settled?.ttft ? `${theme.fg("fieldName", "ttft")} ${theme.fg("counter", settled.ttft)}` : null,
	];
	const joined = joinChips(theme, parts);
	return joined.length > 0 ? joined : null;
}

/**
 * The streaming run's live chip: output as it streams, and the prompt it sent, from the context meter or else the
 * read model's newest turn, never a tally of the run's own messages (#434 §11.3).
 */
export function liveTokenValue(
	theme: ClioTheme,
	throughput: TokenThroughputSnapshot | null | undefined,
	telemetry: FooterTelemetry | undefined,
	contextUsed: number | null | undefined,
): string | null {
	const output = finiteNonNegative(throughput?.outputTokens);
	const context = finiteNonNegative(contextUsed);
	const turnInput = telemetry?.kind === "ready" ? (telemetry.turn?.input ?? null) : null;
	const input = context > 0 ? formatFooterTokens(context) : turnInput;
	const parts = [
		output > 0
			? theme.fg("counter", `${GLYPH.down} ${throughput?.estimated ? "≈" : ""}${formatFooterTokens(output)}`)
			: null,
		input !== null ? theme.fg("counter", `${GLYPH.up} ${input}`) : null,
	];
	const joined = joinChips(theme, parts);
	return joined.length > 0 ? joined : null;
}

/**
 * The newest turn's reasoning chip, or null when the turn spent none. Every
 * surface that shows reasoning reads the turn's journaled reasoning through the
 * same projection, so the transcript, this footer, and the receipt cannot
 * disagree about the count or whether it is provider-attested.
 */
function reasoningChip(theme: ClioTheme, reasoning: ReasoningUsageView): string | null {
	const chip = formatReasoningChip(reasoning, formatFooterTokens);
	return chip === null ? null : theme.fg("counter", chip);
}

export function lastTurnOutcome(theme: ClioTheme, lastTurn: TurnSummary): string {
	const stop = stopReasonStyle(lastTurn.stopReason);
	return `${theme.fg(stop.token, stop.glyph)} ${theme.fg("counter", formatCompactMs(lastTurn.elapsedMs))}`;
}

/** Tokens are the journal's for the whole turn, workers included; timing and tools are the turn's own status. */
export function lastTurnDetails(
	theme: ClioTheme,
	lastTurn: TurnSummary,
	telemetry: FooterTelemetry | undefined,
): string {
	const turn = telemetry?.kind === "ready" ? telemetry.turn : null;
	const parts: Array<string | null> = [
		turn ? theme.fg("counter", `${GLYPH.up} ${turn.input} ${GLYPH.down} ${turn.output}`) : null,
		turn ? reasoningChip(theme, turn.reasoning) : null,
		turn && !(turn.cacheRead === "0" && turn.cacheWrite === "0")
			? theme.fg("annotation", `cache ${turn.cacheRead}/${turn.cacheWrite}`)
			: null,
	];
	if (lastTurn.toolCount > 0) {
		const label = `${lastTurn.toolCount} tool${lastTurn.toolCount === 1 ? "" : "s"}`;
		const errors = lastTurn.toolErrorCount > 0 ? theme.fg("error", ` ${lastTurn.toolErrorCount}${GLYPH.error}`) : "";
		parts.push(`${theme.fg("counter", label)}${errors}`);
	}
	if (lastTurn.watchdogPeak >= 2) parts.push(theme.fg("warning", "slow"));
	if (lastTurn.truncated) parts.push(theme.fg("warning", "trunc"));
	return joinChips(theme, parts);
}

export function meaningfulToolTally(value: string): string | null {
	const text = value.trim();
	return text === "none" || text === `none · 0${GLYPH.error}` || text === `0${GLYPH.error}` ? null : value;
}

/** Task-board progress chips: `2/5 done`, with a warning chip when tasks are blocked. */
export function taskBoardValue(theme: ClioTheme, board: TaskBoardSnapshot): string {
	const counts = taskBoardCounts(board);
	const progress = theme.fg(counts.open > 0 ? "counter" : "success", `${counts.completed}/${counts.total} done`);
	const blocked = counts.blocked > 0 ? theme.fg("warning", `${counts.blocked} blocked`) : null;
	return joinChips(theme, [progress, blocked]);
}

/** The board's current focus: the single active task, glyph-led like a worker row. */
export function activeTaskLine(theme: ClioTheme, board: TaskBoardSnapshot): string | null {
	const active = board.tasks.find((task) => task.status === "active");
	if (!active) return null;
	return `${theme.fg("activity", GLYPH.running)} ${theme.fg("annotation", active.id)} ${theme.fg("counter", active.title)}`;
}

/**
 * Zip two quadrant blocks into a side-by-side row, padding the shorter block so
 * both columns stay aligned, and clamping each cell to its column width.
 */
export function zipColumns(
	left: string[],
	right: string[],
	leftWidth: number,
	rightWidth: number,
	sep: string,
): string[] {
	left = left.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, leftWidth)));
	right = right.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, rightWidth)));
	const rowCount = Math.max(left.length, right.length);
	const lines: string[] = [];
	for (let i = 0; i < rowCount; i += 1) {
		lines.push(`${cell(left[i] ?? "", leftWidth)}${sep}${cell(right[i] ?? "", rightWidth)}`);
	}
	return lines;
}

type HarnessPhasePresentation = {
	glyph: string;
	label: string;
	token: ClioToken;
	live: boolean;
};

function shortToolLabel(status: AgentStatus, width: number): string {
	const name = status.tool?.toolName?.trim();
	if (name === ToolNames.AskUser) return "Needs input";
	if (name === ToolNames.Dispatch) return "Waiting for worker";
	if (!name || width < 72) return "Running tool";
	const nameWidth = width >= 100 ? 18 : 12;
	// The pill label is never padded; truncate without pad so the tool name is
	// followed by a single space before the badge, not a column of blanks.
	return `Running ${truncateToWidth(name, nameWidth, GLYPH.ellipsis, false)}`;
}

function footerPhasePresentation(status: AgentStatus, width: number, now: number): HarnessPhasePresentation {
	const ultraNarrow = width < 48;
	switch (status.phase) {
		case "idle":
			return { glyph: GLYPH.queued, label: "Ready", token: "counter", live: false };
		case "preparing":
			return { glyph: GLYPH.phaseWaiting, label: "Preparing", token: "harnessAction", live: true };
		case "waiting_model":
			return { glyph: GLYPH.phaseWaiting, label: "Waiting for model", token: "harnessAction", live: true };
		case "thinking":
			return { glyph: GLYPH.phaseThinking, label: "Thinking", token: "harnessAction", live: true };
		case "writing":
			return {
				glyph: GLYPH.phaseWriting,
				label: status.preparingToolCall ? "Preparing tool call" : "Writing",
				token: "harnessAction",
				live: true,
			};
		case "tool_running":
			return {
				glyph: GLYPH.phaseTool,
				label: shortToolLabel(status, width),
				token:
					status.tool?.toolName === ToolNames.AskUser
						? "warning"
						: FUNCTION_ROLES[toolFunction(status.tool?.toolName ?? "tool")],
				live: status.tool?.toolName !== ToolNames.AskUser,
			};
		case "tool_blocked":
			// Attention states hold a static glyph rather than spinning: the work
			// has paused for a human, so the pill should not read as live progress.
			// The phase fires only on PermissionRequested, so the pill names the
			// wait for confirmation; "blocked" would contradict the ask overlay.
			return { glyph: GLYPH.phaseBlocked, label: "Needs approval", token: "warning", live: false };
		case "retrying": {
			const attempt = status.retry?.attempt ?? 0;
			const maxAttempts = status.retry?.maxAttempts ?? 0;
			return {
				glyph: GLYPH.phaseRetry,
				label: ultraNarrow ? "Retrying" : `Retrying ${attempt}/${maxAttempts}`,
				token: "warning",
				live: false,
			};
		}
		case "compacting":
			return { glyph: GLYPH.phaseCompact, label: "Compacting context", token: "harnessAction", live: true };
		case "dispatching":
			return { glyph: GLYPH.phaseDispatch, label: "Waiting for worker", token: "harnessAction", live: true };
		case "stuck": {
			const seconds = Math.max(0, Math.floor((now - status.lastMeaningfulAt) / 1000));
			return {
				glyph: GLYPH.warn,
				label: ultraNarrow ? "No output" : `No output · ${seconds}s`,
				token: "warning",
				live: false,
			};
		}
		case "ended": {
			const stop = status.summary?.stopReason;
			if (stop === "error") return { glyph: GLYPH.error, label: "Failed", token: "error", live: false };
			if (stop === "generation_guard")
				return { glyph: GLYPH.warn, label: "Generation stopped", token: "warning", live: false };
			if (stop === "aborted" || stop === "cancelled")
				return { glyph: GLYPH.cancelled, label: "Cancelled", token: "counter", live: false };
			if (stop === "length") return { glyph: GLYPH.warn, label: "Output limit", token: "warning", live: false };
			return { glyph: GLYPH.ok, label: "Done", token: "success", live: false };
		}
	}
}

const COMPOSER_TOOL_ACTIVITY: Readonly<Record<string, string>> = {
	[ToolNames.Write]: "is writing a file",
	[ToolNames.Edit]: "is editing a file",
	[ToolNames.Read]: "is reading a file",
	[ToolNames.Bash]: "is running a command",
	[ToolNames.RunScript]: "is running a script",
	[ToolNames.Grep]: "is searching",
	[ToolNames.Find]: "is finding files",
	[ToolNames.CodeNav]: "is navigating code",
	[ToolNames.Dispatch]: "is waiting for a worker",
	[ToolNames.AskUser]: "needs input",
};

/** Subject-aware activity phrases for the model named on the composer rail. */
export function composerPhasePresentation(status: AgentStatus, width: number, now: number): HarnessPhasePresentation {
	const phase = footerPhasePresentation(status, width, now);
	let label: string;
	switch (status.phase) {
		case "idle":
			label = "is ready";
			break;
		case "preparing":
			label = "is preparing";
			break;
		case "waiting_model":
			label = "is waiting for a response";
			break;
		case "thinking":
			label = "is thinking";
			break;
		case "writing":
			label = status.preparingToolCall ? "is preparing a tool" : "is writing";
			break;
		case "tool_running": {
			const name = status.tool?.toolName ?? "tool";
			const activity = Object.hasOwn(COMPOSER_TOOL_ACTIVITY, name) ? COMPOSER_TOOL_ACTIVITY[name] : undefined;
			label = activity ?? `is running ${truncateToWidth(name, width >= 100 ? 18 : 12, GLYPH.ellipsis, false)}`;
			break;
		}
		case "tool_blocked":
			label = "needs approval";
			break;
		case "retrying":
			label = `is retrying ${status.retry?.attempt ?? 0}/${status.retry?.maxAttempts ?? 0}`;
			break;
		case "compacting":
			label = "is compacting context";
			break;
		case "dispatching":
			label = "is waiting for a worker";
			break;
		case "stuck":
			label = `has no output · ${Math.max(0, Math.floor((now - status.lastMeaningfulAt) / 1000))}s`;
			break;
		case "ended": {
			const stop = status.summary?.stopReason;
			label =
				stop === "error"
					? "failed"
					: stop === "generation_guard"
						? "stopped generating tool arguments"
						: stop === "cancelled" || stop === "aborted"
							? "was cancelled"
							: stop === "length"
								? "reached the output limit"
								: "finished";
			break;
		}
	}
	return { ...phase, label };
}

export function buildHarnessStatePill(
	theme: ClioTheme,
	status: AgentStatus,
	toolCounts: ToolTallySnapshot,
	tick: number,
	now: number,
	width: number,
): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const activeTools = finiteNonNegative(toolCounts.active);
	const badge = activeTools > 0 ? theme.fg("activity", `tools ${activeTools}`) : "";
	// Idleness is absence of work, not a phase worth narrating. If a tool
	// remains live while the harness settles, keep that activity without
	// prefixing it with an idle glyph.
	if (status.phase === "idle") {
		const idle = theme.fg("counter", `${GLYPH.queued} Ready`);
		return badge ? `${idle} ${theme.fg("annotation", "·")} ${badge}` : idle;
	}
	const phase = footerPhasePresentation(status, safeWidth, now);
	// A live phase leads with the animated spinner; the spinner stands in for the
	// static phase glyph rather than sitting beside it. Static glyphs render only
	// for the attention states and ended forms; idle returned quietly above.
	const lead = phase.live ? spinnerFrame(tick) : phase.glyph;
	const mainPill = theme.style(phase.token, `${lead} ${phase.label}`);
	return badge ? `${mainPill} ${theme.fg("annotation", "·")} ${badge}` : mainPill;
}
