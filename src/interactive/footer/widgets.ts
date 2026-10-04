import { formatUsd } from "../../core/display-units.js";
import { ToolNames } from "../../core/tool-names.js";
import type { LiveBudgetView } from "../../domains/context/budget/live-view.js";
import type { CostAggregate, TokenThroughputSnapshot, UsageBreakdown } from "../../domains/observability/index.js";
import { formatCostAggregate } from "../../domains/observability/index.js";
import type { LocalCapacity } from "../../domains/scheduling/local-capacity.js";
import type { ContextUsageBreakdown } from "../../domains/session/context-accounting.js";
import type { ContextLedger, ContextLedgerCategory } from "../../domains/session/context-ledger.js";
import type { TaskBoardSnapshot } from "../../domains/session/task-board.js";
import { taskBoardCounts } from "../../domains/session/task-board.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { CONTEXT_BAR_LABEL_WIDTH, finiteNonNegative } from "../context-bar.js";
import { contextCategorySwatch, contextPercentRole, renderContextMeterBar } from "../context-meter.js";
import type { DispatchBoardRow } from "../dispatch-board.js";
import { fitFooterText, formatFooterTokens } from "../footer-panel.js";
import type { AgentStatus, TurnSummary } from "../status/index.js";
import { formatReasoningChip, reasoningFromSummary, spinnerFrame } from "../status/index.js";
import type { ClioTheme, ClioToken } from "../theme/index.js";
import {
	clioTheme,
	FUNCTION_ROLES,
	formatCompactMs,
	formatContextPercent,
	GLYPH,
	joinChips,
	padAnsi,
	sectionTag,
	toolFunction,
} from "../theme/index.js";
import {
	type ContextOccupancyFacts,
	contextBreakdownForBar,
	contextOccupancyBar,
	contextUsagePercent,
} from "./context-rail.js";

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
	shutdownArmed?: boolean;
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

export { formatUsd };

function contextComposition(context: ContextEngineFacts): {
	system: number;
	tools: number;
	chat: number;
	free: number | null;
} {
	const used = finiteNonNegative(context.used);
	const window = finiteNonNegative(context.contextWindow);
	const breakdown = contextBreakdownForBar(context);
	return {
		system: finiteNonNegative(breakdown?.systemPromptTokens),
		tools: finiteNonNegative(breakdown?.toolSchemaTokens),
		chat: finiteNonNegative(breakdown?.messageTokens) + finiteNonNegative(breakdown?.pendingUserTokens),
		free:
			window > 0 && typeof context.used === "number" && Number.isFinite(context.used) ? Math.max(0, window - used) : null,
	};
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

type DashboardRow =
	| { kind: "kv"; key: string; value: string | null | undefined; valueToken?: ClioToken; styled?: boolean }
	| { kind: "status"; value: string | null | undefined }
	| { kind: "legend"; value: string | null | undefined };

interface ExpandedQuadrantOptions {
	width?: number;
}

function renderDashboardRow(theme: ClioTheme, row: DashboardRow, keyWidth: number): string | null {
	if (!row.value) return null;
	if (row.kind !== "kv") return row.value;
	const key = theme.fg("fieldName", `${row.key.padEnd(keyWidth)} `);
	const value = row.styled ? row.value : theme.fg(row.valueToken ?? "fieldValue", row.value);
	return `${key}${value}`;
}

function dashboardBlock(
	theme: ClioTheme,
	label: string,
	rows: ReadonlyArray<DashboardRow>,
	width = Number.POSITIVE_INFINITY,
): string[] {
	const keyWidth = rows.reduce((max, row) => (row.kind === "kv" ? Math.max(max, row.key.length) : max), 0);
	const body = rows.flatMap((row) => {
		const rendered = renderDashboardRow(theme, row, keyWidth);
		if (!rendered) return [];
		if (!Number.isFinite(width)) return [rendered];
		if (row.kind !== "kv") return wrapTextWithAnsi(rendered, Math.max(1, width));
		const prefixWidth = Math.min(keyWidth + 1, Math.max(0, width - 1));
		const value = row.styled ? (row.value ?? "") : theme.fg(row.valueToken ?? "fieldValue", row.value ?? "");
		return wrapTextWithAnsi(value, Math.max(1, width - prefixWidth)).map(
			(line, index) =>
				`${index === 0 ? theme.fg("fieldName", `${row.key.padEnd(keyWidth)} `.slice(0, prefixWidth)) : " ".repeat(prefixWidth)}${line}`,
		);
	});
	return [sectionTag(theme, "harnessHeading", label.toUpperCase(), 0), ...body];
}

function kv(key: string, value: string | null | undefined, valueToken: ClioToken = "fieldValue"): DashboardRow {
	return { kind: "kv", key, value, valueToken };
}

function styledKv(key: string, value: string | null | undefined): DashboardRow {
	return { kind: "kv", key, value, styled: true };
}

function statusRow(value: string | null | undefined): DashboardRow {
	return { kind: "status", value };
}

function legendRow(value: string | null | undefined): DashboardRow {
	return { kind: "legend", value };
}

function expandedContextBarCells(width: number | undefined): number {
	if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return 12;
	const budget = Math.max(6, Math.floor(width) - CONTEXT_BAR_LABEL_WIDTH - 1);
	// A wider quadrant earns a finer meter: every extra cell is real resolution,
	// up to 24 cells so the bar never dwarfs the facts beneath it.
	const desired = width >= 48 ? 24 : width >= 36 ? 16 : width >= 32 ? 14 : 12;
	return Math.max(8, Math.min(24, desired, budget));
}

function formatUsedWindow(used: number | null, contextWindow: number | null): string | null {
	if (used === null || !contextWindow) return null;
	return `${formatFooterTokens(used)} / ${formatFooterTokens(contextWindow)}`;
}

function formatCompaction(facts: ContextEngineFacts): string | null {
	if (!facts.contextWindow) return "on server overflow";
	if (facts.compactionThreshold === null) return null;
	const mode = facts.compactionAuto ? "auto" : "manual";
	const threshold = Math.round(facts.compactionThreshold * 100);
	return `${facts.compactionActive ? "active " : ""}${mode} @${threshold}%`;
}

function sourceState(theme: ClioTheme, facts: ContextEngineFacts): string | null {
	const value = joinChips(theme, [
		facts.clioMd ? theme.fg("counter", facts.clioMd) : null,
		facts.memory ? theme.fg("counter", facts.memory) : null,
	]);
	return value.length > 0 ? value : null;
}

/** Short labels for the dense footer; the overlay carries the full names. */
const CONTEXT_SHORT_LABEL: Readonly<Record<ContextLedgerCategory, string>> = {
	system: "sys",
	tools: "tools",
	toolResults: "results",
	agents: "agt",
	skills: "skl",
	memory: "mem",
	project: "proj",
	messages: "chat",
	pending: "input",
	reserve: "rsv",
	free: "free",
	streaming: "stream",
};

/** Static-side cost chips (system prompt, tools, agents, skills, memory, project), heaviest first. */
function ledgerSystemChips(theme: ClioTheme, ledger: ContextLedger): string {
	const statics = new Set<ContextLedgerCategory>(["system", "tools", "agents", "skills", "memory", "project"]);
	const chips = ledger.groups
		.filter((group) => statics.has(group.category))
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, 4)
		.map((group) => theme.fg("counter", `${CONTEXT_SHORT_LABEL[group.category]} ${formatFooterTokens(group.tokens)}`));
	return joinChips(theme, chips);
}

/** Conversation, autocompact reserve, and free-space chips. */
function ledgerChatChips(theme: ClioTheme, ledger: ContextLedger): string {
	const chat = ledger.groups.find((group) => group.category === "messages")?.tokens ?? 0;
	return joinChips(theme, [
		theme.fg("counter", `chat ${formatFooterTokens(chat)}`),
		ledger.groups.some((group) => group.category === "toolResults")
			? theme.fg(
					"counter",
					`results ${formatFooterTokens(ledger.groups.find((group) => group.category === "toolResults")?.tokens ?? 0)}`,
				)
			: null,
		ledger.reserveTokens > 0 ? theme.fg("annotation", `rsv ${formatFooterTokens(ledger.reserveTokens)}`) : null,
		ledger.contextWindow > 0 ? theme.fg("annotation", `free ${formatFooterTokens(ledger.freeTokens)}`) : null,
	]);
}

/**
 * Swatch legend covering exactly the categories present in the meter, packed
 * into as many rows as the quadrant needs. A ledger can carry ten categories,
 * more than one quadrant row holds, and dropping tail entries would hide
 * whole categories, so the legend wraps by whole chips instead of clipping.
 */
function ledgerLegendRows(theme: ClioTheme, ledger: ContextLedger, width: number | undefined): string[] {
	const chips = ledger.meter.map((group) => {
		return `${contextCategorySwatch(group.category, theme)} ${theme.fg("legend", CONTEXT_SHORT_LABEL[group.category])}`;
	});
	const budget =
		typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.floor(width) : Number.POSITIVE_INFINITY;
	const rows: string[] = [];
	let current = "";
	for (const chip of chips) {
		const candidate = current.length > 0 ? `${current} ${chip}` : chip;
		if (current.length > 0 && visibleWidth(candidate) > budget) {
			rows.push(current);
			current = chip;
		} else {
			current = candidate;
		}
	}
	if (current.length > 0) rows.push(current);
	return rows;
}

function ledgerBar(theme: ClioTheme, ledger: ContextLedger, cells: number): string {
	const bar = renderContextMeterBar(ledger, cells, theme);
	return ledger.percent === null
		? bar
		: `${bar}  ${theme.fg(contextPercentRole(ledger.percent), formatContextPercent(ledger.percent))}`;
}

export function contextQuadrant(facts: ContextEngineFacts, options: ExpandedQuadrantOptions = {}): string[] {
	const theme = clioTheme();
	const ledger = facts.ledger ?? null;
	const hasLedger = !facts.budget && ledger !== null && ledger.contextWindow > 0;
	const barCells = expandedContextBarCells(options.width);

	let bar: string;
	let fill: string;
	let chatFree: string;
	let legendRows: string[];
	if (hasLedger && ledger) {
		bar = ledgerBar(theme, ledger, barCells);
		fill = ledgerSystemChips(theme, ledger);
		chatFree = ledgerChatChips(theme, ledger);
		legendRows = ledgerLegendRows(theme, ledger, options.width);
	} else {
		const composition = contextComposition(facts);
		fill = joinChips(theme, [
			composition.system > 0 ? theme.fg("counter", `sys ${formatFooterTokens(composition.system)}`) : null,
			composition.tools > 0 ? theme.fg("counter", `tools ${formatFooterTokens(composition.tools)}`) : null,
		]);
		chatFree = joinChips(theme, [
			composition.chat > 0 ? theme.fg("counter", formatFooterTokens(composition.chat)) : null,
			composition.free !== null ? theme.fg("annotation", `free ${formatFooterTokens(composition.free)}`) : null,
		]);
		bar = facts.contextWindow ? contextOccupancyBar(facts, barCells, theme) : theme.fg("unknownValue", "window unknown");
		const filledChar = visibleWidth(GLYPH.contextFull) === 1 ? GLYPH.contextFull : GLYPH.barFull;
		const freeChar = visibleWidth(GLYPH.contextFree) === 1 ? GLYPH.contextFree : GLYPH.barEmpty;
		legendRows = [
			`${theme.fg("meterSystem", filledChar)} ${theme.fg("legend", "sys")} ${theme.fg("meterTools", filledChar)} ${theme.fg("legend", "tools")} ${theme.fg("meterConversation", filledChar)} ${theme.fg("legend", "chat")} ${theme.fg("meterFree", freeChar)} ${theme.fg("legend", "free")}`,
		];
	}

	const usedTokens = hasLedger && ledger ? ledger.usedTokens : facts.used;
	const windowTokens = hasLedger && ledger ? ledger.contextWindow : facts.contextWindow;
	return dashboardBlock(
		theme,
		"Context",
		[
			statusRow(bar),
			kv("used", facts.budget ? contextUsageText(facts) : formatUsedWindow(usedTokens, windowTokens)),
			fill ? styledKv("fill", fill) : statusRow(null),
			chatFree ? styledKv("budget", chatFree) : statusRow(null),
			kv("compact", formatCompaction(facts)),
			styledKv("source", sourceState(theme, facts)),
			facts.extensions && facts.extensions.installed > 0
				? kv("ext", `${facts.extensions.active}/${facts.extensions.installed}`)
				: statusRow(null),
			...legendRows.map((row) => legendRow(row)),
		],
		options.width,
	);
}

function stopReasonStyle(reason: TurnSummary["stopReason"]): { glyph: string; token: ClioToken } {
	if (reason === "error") return { glyph: GLYPH.error, token: "error" };
	if (reason === "aborted" || reason === "cancelled") return { glyph: GLYPH.cancelled, token: "annotation" };
	if (reason === "length" || reason === "generation_guard") return { glyph: GLYPH.warn, token: "warning" };
	return { glyph: GLYPH.ok, token: "success" };
}

interface ActivityQuadrantOptions extends ExpandedQuadrantOptions {
	status?: AgentStatus;
	toolCounts?: ToolTallySnapshot;
	throughput?: TokenThroughputSnapshot | null;
	sessionTokens?: UsageBreakdown | null;
	sessionCost?: CostAggregate | null;
	contextUsed?: number | null;
	tick?: number;
	now?: number;
}

function defaultIdleStatus(): AgentStatus {
	return {
		phase: "idle",
		since: 0,
		lastMeaningfulAt: 0,
		watchdogTier: 0,
		watchdogPeak: 0,
		localRuntime: false,
	};
}

function formattedThroughput(theme: ClioTheme, throughput: TokenThroughputSnapshot | null | undefined): string | null {
	const tps = finiteNonNegative(throughput?.tokensPerSecond);
	if (tps <= 0) return null;
	const rounded = tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10;
	const parts = [
		`${theme.fg("metricValue", `${GLYPH.speed}${throughput?.estimated ? "≈" : ""}${rounded}`)} ${theme.fg("metricUnit", "Tk/s")}`,
	];
	const ttft = finiteNonNegative(throughput?.ttftMs);
	if (ttft > 0) parts.push(`${theme.fg("fieldName", "ttft")} ${theme.fg("counter", formatCompactMs(ttft))}`);
	return joinChips(theme, parts);
}

function liveTokenValue(
	theme: ClioTheme,
	status: AgentStatus,
	throughput: TokenThroughputSnapshot | null | undefined,
	lastTurn: TurnSummary | null,
	sessionTokens: UsageBreakdown | null | undefined,
	contextUsed: number | null | undefined,
): string | null {
	const output = finiteNonNegative(throughput?.outputTokens);
	const input =
		finiteNonNegative(contextUsed) ||
		finiteNonNegative(status.summary?.inputTokens) ||
		finiteNonNegative(lastTurn?.inputTokens) ||
		finiteNonNegative(sessionTokens?.input);
	const parts = [
		output > 0
			? theme.fg("counter", `${GLYPH.down} ${throughput?.estimated ? "≈" : ""}${formatFooterTokens(output)}`)
			: null,
		input > 0 ? theme.fg("counter", `${GLYPH.up} ${formatFooterTokens(input)}`) : null,
	];
	const joined = joinChips(theme, parts);
	return joined.length > 0 ? joined : null;
}

/**
 * The last turn's reasoning chip, or null when the turn spent none. Every
 * surface that shows reasoning reads the same projection, so the transcript,
 * this footer, and the receipt cannot disagree about the count or whether it
 * is provider-attested.
 */
function reasoningChip(theme: ClioTheme, lastTurn: TurnSummary): string | null {
	const chip = formatReasoningChip(reasoningFromSummary(lastTurn), formatFooterTokens);
	return chip === null ? null : theme.fg("counter", chip);
}

function lastTurnOutcome(theme: ClioTheme, lastTurn: TurnSummary): string {
	const stop = stopReasonStyle(lastTurn.stopReason);
	return `${theme.fg(stop.token, stop.glyph)} ${theme.fg("counter", formatCompactMs(lastTurn.elapsedMs))}`;
}

function lastTurnDetails(theme: ClioTheme, lastTurn: TurnSummary): string {
	const estimate = lastTurn.estimated ? "≈" : "";
	const parts: Array<string | null> = [
		theme.fg(
			"counter",
			`${GLYPH.up} ${estimate}${formatFooterTokens(lastTurn.inputTokens)} ${GLYPH.down} ${estimate}${formatFooterTokens(lastTurn.outputTokens)}`,
		),
		reasoningChip(theme, lastTurn),
		lastTurn.cacheReadTokens > 0 || lastTurn.cacheWriteTokens > 0
			? theme.fg(
					"annotation",
					`cache ${formatFooterTokens(lastTurn.cacheReadTokens)}/${formatFooterTokens(lastTurn.cacheWriteTokens)}`,
				)
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

function cumulativeTokens(sessionTokens: UsageBreakdown | null | undefined): number {
	const fallback = finiteNonNegative(sessionTokens?.input) + finiteNonNegative(sessionTokens?.output);
	return finiteNonNegative(sessionTokens?.totalTokens) || fallback;
}

function meaningfulToolTally(value: string): string | null {
	const text = value.trim();
	return text === "none" || text === `none · 0${GLYPH.error}` || text === `0${GLYPH.error}` ? null : value;
}

/** Task-board progress chips: `2/5 done`, with a warning chip when tasks are blocked. */
function taskBoardValue(theme: ClioTheme, board: TaskBoardSnapshot): string {
	const counts = taskBoardCounts(board);
	const progress = theme.fg(counts.open > 0 ? "counter" : "success", `${counts.completed}/${counts.total} done`);
	const blocked = counts.blocked > 0 ? theme.fg("warning", `${counts.blocked} blocked`) : null;
	return joinChips(theme, [progress, blocked]);
}

/** The board's current focus: the single active task, glyph-led like a worker row. */
function activeTaskLine(theme: ClioTheme, board: TaskBoardSnapshot): string | null {
	const active = board.tasks.find((task) => task.status === "active");
	if (!active) return null;
	return `${theme.fg("activity", GLYPH.running)} ${theme.fg("annotation", active.id)} ${theme.fg("counter", active.title)}`;
}

export function activityQuadrant(facts: AgentWorkFacts, options: ActivityQuadrantOptions = {}): string[] {
	const theme = clioTheme();
	const status = options.status ?? defaultIdleStatus();
	const toolCounts = options.toolCounts ?? { tools: {}, errors: 0 };
	const statusWidth = Math.max(options.width ?? 120, 40);
	const isStreaming = status.phase !== "idle" && status.phase !== "ended";
	const fleetSummaryIsAction = facts.dispatchSummary !== null && status.phase !== "dispatching";
	const rows: DashboardRow[] = [
		statusRow(
			buildHarnessStatePill(theme, status, toolCounts, options.tick ?? 0, options.now ?? Date.now(), statusWidth),
		),
	];
	if (facts.contextActivity) {
		const token =
			facts.contextActivity.status === "failed"
				? "error"
				: facts.contextActivity.status === "completed"
					? "success"
					: "activity";
		rows.push(kv("context", facts.contextActivity.message, token));
		if (facts.contextActivity.detail) rows.push(kv("ctx detail", facts.contextActivity.detail, "secondaryDescription"));
	}
	if (isStreaming && facts.statusText) rows.push(kv("state", facts.statusText, "activity"));
	if (isStreaming) {
		rows.push(styledKv("speed", formattedThroughput(theme, options.throughput)));
		rows.push(
			styledKv(
				"live",
				liveTokenValue(theme, status, options.throughput, facts.lastTurn, options.sessionTokens, options.contextUsed),
			),
		);
	} else if (facts.lastTurn) {
		rows.push(styledKv("last", lastTurnOutcome(theme, facts.lastTurn)));
		rows.push(styledKv("turn", lastTurnDetails(theme, facts.lastTurn)));
		rows.push(styledKv("speed", formattedThroughput(theme, options.throughput)));
	}
	const total = cumulativeTokens(options.sessionTokens);
	rows.push(total > 0 ? styledKv("totals", theme.fg("counter", `Σ${formatFooterTokens(total)}`)) : statusRow(null));
	// Null until something has actually been priced, and an absent row is the
	// only honest rendering of that. See formatCostAggregate.
	const cost = formatCostAggregate(options.sessionCost);
	rows.push(cost === null ? statusRow(null) : styledKv("cost", theme.fg("counter", cost)));
	rows.push(
		kv("fleet", facts.dispatchSummary?.replace(/^dispatch\s+/, ""), fleetSummaryIsAction ? "activity" : "annotation"),
	);
	if (facts.taskBoard && facts.taskBoard.tasks.length > 0) {
		rows.push(styledKv("tasks", taskBoardValue(theme, facts.taskBoard)));
		rows.push(statusRow(activeTaskLine(theme, facts.taskBoard)));
	}
	rows.push(kv("tools", meaningfulToolTally(facts.toolTally)));
	return dashboardBlock(theme, "Activity", rows, options.width);
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

function buildHarnessStatePill(
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
	if (status.phase === "idle") return badge;
	const phase = footerPhasePresentation(status, safeWidth, now);
	// A live phase leads with the animated spinner; the spinner stands in for the
	// static phase glyph rather than sitting beside it. Static glyphs render only
	// for the attention states and ended forms; idle returned quietly above.
	const lead = phase.live ? spinnerFrame(tick) : phase.glyph;
	const mainPill = theme.style(phase.token, `${lead} ${phase.label}`);
	return badge ? `${mainPill} ${theme.fg("annotation", "·")} ${badge}` : mainPill;
}
