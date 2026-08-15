import type { OutputVerbosity } from "../../core/defaults.js";
import { ToolNames } from "../../core/tool-names.js";
import {
	type CostAggregate,
	formatCostAggregate,
	type TokenThroughputSnapshot,
	type UsageBreakdown,
} from "../../domains/observability/index.js";
import type { ContextUsageBreakdown } from "../../domains/session/context-accounting.js";
import type { ContextLedger, ContextLedgerCategory } from "../../domains/session/context-ledger.js";
import { type TaskBoardSnapshot, taskBoardCounts } from "../../domains/session/task-board.js";
import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { CONTEXT_CATEGORY_TOKEN, contextCategorySwatch, renderContextMeterBar } from "../context-meter.js";
import {
	agentAudiencePrefix,
	agentDisplayLabel,
	type DispatchBoardRow,
	dispatchStatusPresentation,
} from "../dispatch-board.js";
import { buildSegmentedContextBar, CONTEXT_BAR_LABEL_WIDTH, formatFooterTokens } from "../footer-panel.js";
import { type AgentStatus, spinnerFrame, type TurnSummary } from "../status/index.js";
import {
	type ClioTheme,
	type ClioToken,
	clioTheme,
	fitUnits,
	formatCompactMs,
	formatContextPercent,
	GLYPH,
	joinChips,
	joinSections,
	sectionTag,
} from "../theme/index.js";

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
	dirty: boolean | null;
	projectType: string | null;
	remote: string | null;
}

export interface SessionFacts {
	name: string | null;
	id: string | null;
	version: string;
	turns: number | null;
	tokens: string | null;
	throughput: string | null;
	throughputDetail: string | null;
	cost: string | null;
	target: string | null;
	thinking: string | null;
	capabilities: string[] | null;
	safety: string | null;
	toolProfile: string | null;
	/** Active transcript detail mode, shown in the dashboard so visibility is never implicit. */
	outputVerbosity?: OutputVerbosity | null;
	/**
	 * Ctrl+G armed the portable leader and is waiting for the next key. Shown
	 * because the frame between the two keystrokes was otherwise identical to
	 * the idle frame, on the fallback whose users have no working Alt to check
	 * it against.
	 */
	leaderArmed?: boolean;
	/** Proactive-memory status; kept as one atomic fact row in the expanded dashboard. */
	memoryIntervention?: {
		enabled: boolean;
		tier: "rules" | "llm";
		size: number;
		stepInFlight?: boolean;
		lastDecision?: string | null;
	} | null;
}

/** Context engine telemetry. */
export interface ContextEngineFacts {
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
}

/** Responsive bands for the expanded footer. */
export const EXPANDED_WIDE = 80;
export const EXPANDED_MID = 70;
export const EXPANDED_ULTRAWIDE = 120;

/** Compact footer shows the git section only when there is room for it. */
const COMPACT_GIT_MIN_WIDTH = 72;

/**
 * The `visibleWidth` guard looks redundant against `truncateToWidth`, which
 * measures internally, but it is not: dropping it pads wide-char truncations
 * with a trailing space and strips a bare ANSI reset at width 0. Both are
 * visible output, so the extra measurement stays.
 */
export function fitDashboardLine(line: string, width: number): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, "…", true) : line;
}

/**
 * Pad or truncate an already styled string to an exact column width. A cut is
 * marked with an ellipsis so a clipped value ("proj 1.", "read 14 · bash 9 ")
 * never reads as a complete fact.
 */
function cell(text: string, width: number): string {
	const safe = Math.max(0, width);
	const clipped = truncateToWidth(text, safe, "…", true);
	return `${clipped}${" ".repeat(Math.max(0, safe - visibleWidth(clipped)))}`;
}

function joinColumns(left: string, right: string, width: number): string {
	const safe = Math.max(0, Math.floor(width));
	if (safe === 0) return "";
	if (visibleWidth(right) === 0) return cell(left, safe);
	const rightWidth = visibleWidth(right);
	if (rightWidth >= safe) return cell(right, safe);
	const leftBudget = Math.max(0, safe - rightWidth - 1);
	const fittedLeft = visibleWidth(left) > leftBudget ? truncateToWidth(left, leftBudget, "…", true) : left;
	const gap = Math.max(1, safe - visibleWidth(fittedLeft) - rightWidth);
	return cell(`${fittedLeft}${" ".repeat(gap)}${right}`, safe);
}

function finiteNonNegative(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
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

export function formatUsd(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0.00";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

function gitMarker(theme: ClioTheme, dirty: boolean | null): string {
	if (dirty === false) return theme.fg("success", "✓");
	if (dirty === true) return theme.fg("warning", "!");
	return theme.fg("dim", "?");
}

/** Git chip carrying a `git` label so a version-shaped branch never reads as a duplicate version. */
function gitChip(theme: ClioTheme, branch: string | null, dirty: boolean | null): string | null {
	if (!branch) return null;
	return `${theme.fg("dim", "git ")}${theme.fg("success", branch)} ${gitMarker(theme, dirty)}`;
}

function gitValue(theme: ClioTheme, branch: string | null, dirty: boolean | null): string | null {
	if (!branch) return null;
	return `${theme.fg("success", branch)} ${gitMarker(theme, dirty)}`;
}

/** `github.com/owner/repo` → `owner/repo`; otherwise the host or the raw value, trimmed. */
function collapseRemote(remote: string | null): string | null {
	if (!remote) return null;
	const cleaned = remote
		.replace(/^git@/, "")
		.replace(/^[a-z]+:\/\//, "")
		.replace(/\.git$/, "");
	const parts = cleaned.split(/[/:]/).filter(Boolean);
	if (parts.length >= 2) return parts.slice(-2).join("/");
	return parts[0] ?? null;
}

/**
 * Compact primary row: workspace identity on the left and a meaningful work
 * phase on the right. The editor rail owns model and thinking labels. The
 * branch appears here, and only here, across the whole screen.
 */
export function compactPrimaryLine(
	workspace: WorkspaceFacts,
	_session: SessionFacts,
	width: number,
	theme: ClioTheme = clioTheme(),
	status: AgentStatus = {
		phase: "idle",
		since: 0,
		lastMeaningfulAt: 0,
		watchdogTier: 0,
		watchdogPeak: 0,
		localRuntime: false,
	},
	toolCounts: ToolTallySnapshot = { tools: {}, errors: 0 },
	dispatchRows: ReadonlyArray<DispatchBoardRow> = [],
	tick = 0,
	now = Date.now(),
): string {
	const safeWidth = Math.max(1, Math.floor(width));
	let git = safeWidth >= COMPACT_GIT_MIN_WIDTH ? gitChip(theme, workspace.branch, workspace.dirty) : null;
	let right = buildHarnessStatePill(theme, status, toolCounts, dispatchRows, tick, now, safeWidth, true);
	let left = joinSections(theme, [theme.fg("muted", workspace.cwd), git]);

	if (visibleWidth(left) + 1 + visibleWidth(right) > safeWidth) {
		right = buildHarnessStatePill(theme, status, toolCounts, dispatchRows, tick, now, safeWidth, false);
	}

	if (git && visibleWidth(left) + 1 + visibleWidth(right) > safeWidth) {
		git = null;
		left = theme.fg("muted", workspace.cwd);
	}

	if (visibleWidth(left) + 1 + visibleWidth(right) > safeWidth) {
		const maxCwdWidth = Math.max(1, safeWidth - visibleWidth(right) - 1);
		left = theme.fg("muted", truncateToWidth(workspace.cwd, maxCwdWidth, "…", true));
	}

	return joinColumns(left, right, safeWidth);
}

/**
 * Compact secondary row: context fill + the single most important activity on
 * the left, dispatch summary + tool tally on the right.
 */
function compactMetricChipLimit(width: number): number {
	if (width < 48) return 1;
	if (width < 72) return 2;
	if (width < 100) return 4;
	return 6;
}

function contextBarCellBounds(width: number): { min: number; max: number } {
	if (width < 48) return { min: 6, max: 6 };
	if (width < 72) return { min: 8, max: 8 };
	if (width < 100) return { min: 12, max: 12 };
	return { min: 14, max: 16 };
}

function compactContextBarWidth(width: number): number {
	const bounds = contextBarCellBounds(width);
	const leftHalfBudget = Math.max(0, Math.floor(width / 2));
	const budgetCells = Math.max(0, leftHalfBudget - CONTEXT_BAR_LABEL_WIDTH);
	const wideScale = width >= 100 ? 14 + Math.min(2, Math.max(0, Math.floor((width - 100) / 10))) : bounds.max;
	return Math.max(bounds.min, Math.min(bounds.max, budgetCells, wideScale));
}

function contextBreakdownForBar(context: ContextEngineFacts): ContextUsageBreakdown | undefined {
	const reportedUsed = finiteNonNegative(context.used);
	const toolTokens = finiteNonNegative(context.toolSchemaTokens);
	const source = context.breakdown;
	if (!source) {
		if (reportedUsed <= 0 && toolTokens <= 0) return undefined;
		return {
			systemPromptTokens: 0,
			toolSchemaTokens: Math.min(toolTokens, reportedUsed),
			messageTokens: Math.max(0, reportedUsed - toolTokens),
			pendingUserTokens: 0,
		};
	}
	const system = finiteNonNegative(source.systemPromptTokens);
	const tools = finiteNonNegative(source.toolSchemaTokens);
	const conversation = finiteNonNegative(source.messageTokens) + finiteNonNegative(source.pendingUserTokens);
	const total = system + tools + conversation;
	if (reportedUsed <= 0 || total <= 0) {
		return {
			systemPromptTokens: system,
			toolSchemaTokens: tools,
			messageTokens: conversation,
			pendingUserTokens: 0,
		};
	}
	if (reportedUsed >= total) {
		return {
			systemPromptTokens: system,
			toolSchemaTokens: tools,
			messageTokens: conversation + (reportedUsed - total),
			pendingUserTokens: 0,
		};
	}
	const scale = reportedUsed / total;
	return {
		systemPromptTokens: system * scale,
		toolSchemaTokens: tools * scale,
		messageTokens: conversation * scale,
		pendingUserTokens: 0,
	};
}

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
		free: window > 0 ? Math.max(0, window - used) : null,
	};
}

export function compactSecondaryLine(
	context: ContextEngineFacts,
	agent: AgentWorkFacts,
	width: number,
	theme: ClioTheme = clioTheme(),
	status: AgentStatus = {
		phase: "idle",
		since: 0,
		lastMeaningfulAt: 0,
		watchdogTier: 0,
		watchdogPeak: 0,
		localRuntime: false,
	},
	throughput: TokenThroughputSnapshot | null = null,
	sessionTokens: UsageBreakdown | null = null,
	sessionCost: CostAggregate | null = null,
	outputVerbosity?: OutputVerbosity | null,
	leaderArmed = false,
): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const barCells = compactContextBarWidth(safeWidth);
	let left = "";
	if (context.ledger) {
		// The row follows the kv grammar: dim key, muted value. An unmeasured
		// percent renders the ?% placeholder dim because it is scaffolding for a
		// number that has not arrived, not a measurement.
		const percent = theme.fg(
			context.ledger.percent !== null ? "muted" : "dim",
			formatContextPercent(context.ledger.percent),
		);
		left = `${theme.fg("dim", "ctx")} ${renderContextMeterBar(context.ledger, barCells, theme)} ${percent}`;
	} else {
		left = buildSegmentedContextBar(theme, barCells, context.contextWindow ?? 0, contextBreakdownForBar(context));
	}
	const maxRightWidth = Math.max(0, safeWidth - visibleWidth(left) - 1);
	const right = buildMetricStrip(
		theme,
		status,
		throughput,
		agent.lastTurn,
		sessionTokens,
		sessionCost,
		context.used ?? undefined,
		maxRightWidth,
		compactMetricChipLimit(safeWidth),
		outputVerbosity,
		leaderArmed,
	);
	// At the smallest widths the context meter consumes the entire secondary
	// row, so keep a compact mode marker on the left instead of silently hiding
	// the active transcript setting.
	if (outputVerbosity && outputVerbosity !== "default" && visibleWidth(right) === 0) {
		const marker = outputVerbosity === "minimal" ? "m" : outputVerbosity === "verbose" ? "v" : "d";
		left = `${left}${theme.fg("dim", ` out:${marker}`)}`;
	}
	return joinColumns(left, right, safeWidth);
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
	const key = theme.fg("dim", `${row.key.padEnd(keyWidth)} `);
	const value = row.styled ? row.value : theme.fg(row.valueToken ?? "muted", row.value);
	return `${key}${value}`;
}

function dashboardBlock(theme: ClioTheme, label: string, rows: ReadonlyArray<DashboardRow>): string[] {
	const keyWidth = rows.reduce((max, row) => (row.kind === "kv" ? Math.max(max, row.key.length) : max), 0);
	const body = rows
		.map((row) => renderDashboardRow(theme, row, keyWidth))
		.filter((row): row is string => typeof row === "string" && row.length > 0);
	// Every quadrant tag shares one structure color. The tag names the quadrant;
	// the color is not a per-quadrant signal, so all four render bold accentDeep
	// rather than the old info/accent/reason/success carnival.
	return [sectionTag(theme, "accentDeep", label.toUpperCase(), 0), ...body];
}

function kv(key: string, value: string | null | undefined, valueToken: ClioToken = "muted"): DashboardRow {
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

export function workspaceQuadrant(facts: WorkspaceFacts, _options: ExpandedQuadrantOptions = {}): string[] {
	const theme = clioTheme();
	const remote = collapseRemote(facts.remote);
	return dashboardBlock(theme, "Workspace", [
		kv("cwd", facts.cwd),
		styledKv("git", gitValue(theme, facts.branch, facts.dirty)),
		kv("type", facts.projectType),
		kv("remote", remote),
	]);
}

function sessionIdentity(facts: SessionFacts): { key: string; value: string } | null {
	if (facts.id) return { key: "id", value: facts.id };
	if (facts.name) return { key: "name", value: facts.name };
	return null;
}

function capabilitiesValue(theme: ClioTheme, capabilities: string[] | null): string | null {
	if (!capabilities || capabilities.length === 0) return null;
	return joinChips(
		theme,
		capabilities.map((capability) => theme.fg("muted", capability)),
	);
}

export function sessionQuadrant(facts: SessionFacts, options: ExpandedQuadrantOptions = {}): string[] {
	const theme = clioTheme();
	const identity = sessionIdentity(facts);
	const memory = facts.memoryIntervention;
	const memoryValue = memory
		? fitUnits(
				theme,
				"",
				[
					theme.fg(memory.enabled ? "success" : "dim", memory.enabled ? "on" : "off"),
					theme.fg(memory.tier === "llm" ? "reason" : "muted", `tier ${memory.tier === "llm" ? "LLM" : "rules"}`),
					theme.fg("muted", `bank ${memory.size}`),
					// A background step runs for tens of seconds on a small local model.
					// Saying so is the difference between a quiet feature and a dead one.
					...(memory.stepInFlight ? [theme.fg("reason", "working")] : []),
					...(memory.lastDecision ? [theme.fg("dim", memory.lastDecision)] : []),
				],
				Math.max(1, (options.width ?? Number.POSITIVE_INFINITY) - 9),
			)
		: null;
	return dashboardBlock(theme, "Session", [
		identity ? kv(identity.key, identity.value, "accent") : statusRow(null),
		kv("target", facts.target, "accent"),
		kv("think", facts.thinking, "reason"),
		styledKv("caps", capabilitiesValue(theme, facts.capabilities)),
		// accentDeep is a structure color reserved for the section tag; the autonomy
		// value is a plain fact and reads muted like the other neutral values.
		kv("autonomy", facts.safety),
		kv("profile", facts.toolProfile),
		kv(
			"output",
			facts.outputVerbosity && facts.outputVerbosity !== "default" ? facts.outputVerbosity : null,
			facts.outputVerbosity === "verbose" ? "accent" : "muted",
		),
		styledKv("memory", memoryValue),
	]);
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
	if (facts.compactionThreshold === null) return null;
	const mode = facts.compactionAuto ? "auto" : "manual";
	const threshold = Math.round(facts.compactionThreshold * 100);
	return `${facts.compactionActive ? "active " : ""}${mode} @${threshold}%`;
}

function sourceState(theme: ClioTheme, facts: ContextEngineFacts): string | null {
	const value = joinChips(theme, [
		facts.clioMd ? theme.fg("muted", facts.clioMd) : null,
		facts.memory ? theme.fg("muted", facts.memory) : null,
	]);
	return value.length > 0 ? value : null;
}

/** Short labels for the dense footer; the overlay carries the full names. */
const CONTEXT_SHORT_LABEL: Readonly<Record<ContextLedgerCategory, string>> = {
	system: "sys",
	tools: "tools",
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
		.map((group) =>
			theme.fg(
				CONTEXT_CATEGORY_TOKEN[group.category],
				`${CONTEXT_SHORT_LABEL[group.category]} ${formatFooterTokens(group.tokens)}`,
			),
		);
	return joinChips(theme, chips);
}

/** Conversation, autocompact reserve, and free-space chips. */
function ledgerChatChips(theme: ClioTheme, ledger: ContextLedger): string {
	const chat = ledger.groups.find((group) => group.category === "messages")?.tokens ?? 0;
	return joinChips(theme, [
		theme.fg("accent", `chat ${formatFooterTokens(chat)}`),
		ledger.reserveTokens > 0 ? theme.fg("dim", `rsv ${formatFooterTokens(ledger.reserveTokens)}`) : null,
		ledger.contextWindow > 0
			? theme.style("frame", `free ${formatFooterTokens(ledger.freeTokens)}`, { dim: true })
			: null,
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
		const labelToken: ClioToken = group.category === "free" || group.category === "reserve" ? "dim" : "muted";
		return `${contextCategorySwatch(group.category, theme)} ${theme.fg(labelToken, CONTEXT_SHORT_LABEL[group.category])}`;
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
	const percent = theme.fg(ledger.percent !== null ? "muted" : "dim", formatContextPercent(ledger.percent));
	return `${renderContextMeterBar(ledger, cells, theme)}  ${percent}`;
}

export function contextQuadrant(facts: ContextEngineFacts, options: ExpandedQuadrantOptions = {}): string[] {
	const theme = clioTheme();
	const ledger = facts.ledger ?? null;
	const hasLedger = ledger !== null && ledger.contextWindow > 0;
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
			composition.system > 0 ? theme.fg("info", `sys ${formatFooterTokens(composition.system)}`) : null,
			composition.tools > 0 ? theme.fg("warning", `tools ${formatFooterTokens(composition.tools)}`) : null,
		]);
		chatFree = joinChips(theme, [
			composition.chat > 0 ? theme.fg("accent", formatFooterTokens(composition.chat)) : null,
			composition.free !== null
				? theme.style("frame", `free ${formatFooterTokens(composition.free)}`, { dim: true })
				: null,
		]);
		bar = buildSegmentedContextBar(theme, barCells, facts.contextWindow ?? 0, contextBreakdownForBar(facts));
		const filledChar = visibleWidth(GLYPH.contextFull) === 1 ? GLYPH.contextFull : GLYPH.barFull;
		const freeChar = visibleWidth(GLYPH.contextFree) === 1 ? GLYPH.contextFree : GLYPH.barEmpty;
		legendRows = [
			`${theme.fg("info", `${filledChar} sys`)} ${theme.fg("warning", `${filledChar} tools`)} ${theme.fg("accent", `${filledChar} chat`)} ${theme.style("frame", `${freeChar} free`, { dim: true })}`,
		];
	}

	const usedTokens = hasLedger && ledger ? ledger.usedTokens : facts.used;
	const windowTokens = hasLedger && ledger ? ledger.contextWindow : facts.contextWindow;
	return dashboardBlock(theme, "Context", [
		statusRow(bar),
		kv("used", formatUsedWindow(usedTokens, windowTokens)),
		fill ? styledKv("fill", fill) : statusRow(null),
		chatFree ? styledKv("chat", chatFree) : statusRow(null),
		kv("compact", formatCompaction(facts)),
		styledKv("source", sourceState(theme, facts)),
		facts.extensions && facts.extensions.installed > 0
			? kv("ext", `${facts.extensions.active}/${facts.extensions.installed}`)
			: statusRow(null),
		...legendRows.map((row) => legendRow(row)),
	]);
}

function stopReasonStyle(reason: TurnSummary["stopReason"]): { glyph: string; token: ClioToken } {
	if (reason === "error") return { glyph: GLYPH.error, token: "error" };
	if (reason === "aborted" || reason === "cancelled") return { glyph: GLYPH.cancelled, token: "dim" };
	if (reason === "length") return { glyph: GLYPH.warn, token: "warning" };
	return { glyph: GLYPH.ok, token: "success" };
}

/**
 * Elegant single-line readout of the most recent completed turn. This is the
 * footer home for the metrics that used to print faintly under each assistant
 * reply: stop outcome, wall time, token in/out, reasoning, and tool work. The
 * model is intentionally omitted because the editor rail already carries it.
 */
export function formatLastTurn(theme: ClioTheme, summary: TurnSummary): string {
	const stop = stopReasonStyle(summary.stopReason);
	const parts: string[] = [
		theme.fg(stop.token, `${stop.glyph} ${formatCompactMs(summary.elapsedMs)}`),
		theme.fg("muted", `${GLYPH.up}${summary.inputTokens} ${GLYPH.down}${summary.outputTokens}`),
	];
	// Zero suppresses the chip, the same rule the chat panel's turn line follows:
	// a turn that spent no reasoning tokens states nothing by printing `r0`.
	if (typeof summary.reasoningTokens === "number" && summary.reasoningTokens > 0) {
		const marker =
			summary.reasoningTokenProvenance === "estimated" || summary.reasoningTokenProvenance === "mixed" ? "≈" : "";
		parts.push(theme.fg("reason", `r${marker}${summary.reasoningTokens}`));
	}
	if (summary.cacheReadTokens > 0 || summary.cacheWriteTokens > 0) {
		parts.push(theme.fg("dim", `cache ${summary.cacheReadTokens}/${summary.cacheWriteTokens}`));
	}
	if (summary.toolCount > 0) {
		const label = `${summary.toolCount} tool${summary.toolCount === 1 ? "" : "s"}`;
		const errors = summary.toolErrorCount > 0 ? theme.fg("error", ` ${summary.toolErrorCount}${GLYPH.error}`) : "";
		parts.push(`${theme.fg("muted", label)}${errors}`);
	}
	if (summary.watchdogPeak >= 2) parts.push(theme.fg("warning", "slow"));
	if (summary.truncated) parts.push(theme.fg("warning", "trunc"));
	return parts.join(theme.fg("dim", " · "));
}

/**
 * One row per live worker: the sub-process glyph when Clio started the run for
 * itself, the agent's own name, the fleet node it landed on, its status glyph,
 * elapsed, and the receipt id once the run has sealed one. Units are fitted
 * whole, so a narrow quadrant closes on a dim ellipsis rather than clipping a
 * receipt id into a string that still reads like a valid trace argument.
 */
function workerLine(theme: ClioTheme, row: DispatchBoardRow, width: number): string {
	const presentation = dispatchStatusPresentation(row.status, { compact: true });
	// The Activity section already promotes the fleet summary (or dispatch phase)
	// to action orange. Worker rows remain readable without repeating that signal.
	const token = presentation.token === "action" ? "accent" : presentation.token;
	const units = [
		theme.fg("muted", agentDisplayLabel(row)),
		theme.fg("dim", row.node ?? "local"),
		theme.fg(token, presentation.glyph),
		theme.fg("dim", formatCompactMs(row.elapsedMs)),
		...(row.receiptId !== undefined ? [theme.fg("dim", row.receiptId)] : []),
	];
	return fitUnits(theme, agentAudiencePrefix(theme, row), units, Math.max(1, Math.floor(width)));
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
	maxWorkers?: number;
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
	const parts = [theme.fg("success", `${GLYPH.speed}${rounded}/s`)];
	const ttft = finiteNonNegative(throughput?.ttftMs);
	if (ttft > 0) parts.push(theme.fg("muted", `ttft ${formatCompactMs(ttft)}`));
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
		output > 0 ? theme.fg("success", `${GLYPH.down}${formatFooterTokens(output)}`) : null,
		input > 0 ? theme.fg("muted", `${GLYPH.up}${formatFooterTokens(input)}`) : null,
	];
	const joined = joinChips(theme, parts);
	return joined.length > 0 ? joined : null;
}

function lastTurnOutcome(theme: ClioTheme, lastTurn: TurnSummary): string {
	const stop = stopReasonStyle(lastTurn.stopReason);
	return theme.fg(stop.token, `${stop.glyph} ${formatCompactMs(lastTurn.elapsedMs)}`);
}

function lastTurnDetails(theme: ClioTheme, lastTurn: TurnSummary): string {
	const parts: Array<string | null> = [
		theme.fg(
			"muted",
			`${GLYPH.up}${formatFooterTokens(lastTurn.inputTokens)} ${GLYPH.down}${formatFooterTokens(lastTurn.outputTokens)}`,
		),
		lastTurn.reasoningTokens !== undefined && lastTurn.reasoningTokens > 0
			? theme.fg(
					"reason",
					`r${lastTurn.reasoningTokenProvenance === "estimated" || lastTurn.reasoningTokenProvenance === "mixed" ? "≈" : ""}${formatFooterTokens(lastTurn.reasoningTokens)}`,
				)
			: null,
		lastTurn.cacheReadTokens > 0 || lastTurn.cacheWriteTokens > 0
			? theme.fg(
					"dim",
					`cache ${formatFooterTokens(lastTurn.cacheReadTokens)}/${formatFooterTokens(lastTurn.cacheWriteTokens)}`,
				)
			: null,
	];
	if (lastTurn.toolCount > 0) {
		const label = `${lastTurn.toolCount} tool${lastTurn.toolCount === 1 ? "" : "s"}`;
		const errors = lastTurn.toolErrorCount > 0 ? theme.fg("error", ` ${lastTurn.toolErrorCount}${GLYPH.error}`) : "";
		parts.push(`${theme.fg("muted", label)}${errors}`);
	}
	if (lastTurn.watchdogPeak >= 2) parts.push(theme.fg("warning", "slow"));
	if (lastTurn.truncated) parts.push(theme.fg("warning", "trunc"));
	return joinChips(theme, parts);
}

function cumulativeTokens(sessionTokens: UsageBreakdown | null | undefined): number {
	const fallback = finiteNonNegative(sessionTokens?.input) + finiteNonNegative(sessionTokens?.output);
	return finiteNonNegative(sessionTokens?.totalTokens) || fallback;
}

function fleetValue(dispatchSummary: string | null, dispatchRows: ReadonlyArray<DispatchBoardRow>): string | null {
	if (dispatchSummary) return dispatchSummary.replace(/^dispatch\s+/, "");
	return dispatchRows.length > 0 ? `${dispatchRows.length} runs` : null;
}

function meaningfulToolTally(value: string): string | null {
	return /^(?:none(?: · 0✗)?|0✗)$/u.test(value.trim()) ? null : value;
}

/** Task-board progress chips: `2/5 done`, with a warning chip when tasks are blocked. */
function taskBoardValue(theme: ClioTheme, board: TaskBoardSnapshot): string {
	const counts = taskBoardCounts(board);
	const progress = theme.fg(counts.open > 0 ? "muted" : "success", `${counts.completed}/${counts.total} done`);
	const blocked = counts.blocked > 0 ? theme.fg("warning", `${counts.blocked} blocked`) : null;
	return joinChips(theme, [progress, blocked]);
}

/** The board's current focus: the single active task, glyph-led like a worker row. */
function activeTaskLine(theme: ClioTheme, board: TaskBoardSnapshot): string | null {
	const active = board.tasks.find((task) => task.status === "active");
	if (!active) return null;
	return `${theme.fg("accent", GLYPH.running)} ${theme.fg("dim", active.id)} ${theme.fg("muted", active.title)}`;
}

export function activityQuadrant(facts: AgentWorkFacts, options: ActivityQuadrantOptions = {}): string[] {
	const theme = clioTheme();
	const maxWorkers = Math.max(0, options.maxWorkers ?? 3);
	const status = options.status ?? defaultIdleStatus();
	const toolCounts = options.toolCounts ?? { tools: {}, errors: 0 };
	const statusWidth = Math.max(options.width ?? 120, 48);
	const isStreaming = status.phase !== "idle" && status.phase !== "ended";
	const fleetSummaryIsAction = facts.dispatchSummary !== null && status.phase !== "dispatching";
	const rows: DashboardRow[] = [
		statusRow(
			buildHarnessStatePill(
				theme,
				status,
				toolCounts,
				facts.dispatchRows,
				options.tick ?? 0,
				options.now ?? Date.now(),
				statusWidth,
				true,
				fleetSummaryIsAction,
			),
		),
	];
	if (facts.contextActivity) {
		const token =
			facts.contextActivity.status === "failed"
				? "error"
				: facts.contextActivity.status === "completed"
					? "success"
					: "accent";
		rows.push(kv("context", facts.contextActivity.message, token));
		if (facts.contextActivity.detail) rows.push(kv("ctx detail", facts.contextActivity.detail, "dim"));
	}
	if (isStreaming && facts.statusText) rows.push(kv("state", facts.statusText, "accent"));
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
	rows.push(total > 0 ? styledKv("totals", theme.fg("muted", `Σ${formatFooterTokens(total)}`)) : statusRow(null));
	// Null until something has actually been priced, and an absent row is the
	// only honest rendering of that. See formatCostAggregate.
	const cost = formatCostAggregate(options.sessionCost);
	rows.push(cost === null ? statusRow(null) : styledKv("cost", theme.fg("muted", cost)));
	rows.push(kv("fleet", fleetValue(facts.dispatchSummary, facts.dispatchRows), fleetSummaryIsAction ? "action" : "dim"));
	// Every worker up to the panel bound gets its own row; what the bound cuts is
	// counted out loud instead of vanishing, so the row count an operator sees
	// always reconciles with the `fleet` line above it.
	const workerWidth = options.width !== undefined && Number.isFinite(options.width) ? options.width : 48;
	for (const row of facts.dispatchRows.slice(0, maxWorkers)) rows.push(statusRow(workerLine(theme, row, workerWidth)));
	const hiddenWorkers = facts.dispatchRows.length - maxWorkers;
	if (hiddenWorkers > 0) rows.push(statusRow(theme.fg("dim", `+${hiddenWorkers} more`)));
	if (facts.taskBoard && facts.taskBoard.tasks.length > 0) {
		rows.push(styledKv("tasks", taskBoardValue(theme, facts.taskBoard)));
		rows.push(statusRow(activeTaskLine(theme, facts.taskBoard)));
	}
	rows.push(kv("tools", meaningfulToolTally(facts.toolTally)));
	return dashboardBlock(theme, "Activity", rows);
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
	const rowCount = Math.max(left.length, right.length);
	const lines: string[] = [];
	for (let i = 0; i < rowCount; i += 1) {
		lines.push(`${cell(left[i] ?? "", leftWidth)}${sep}${cell(right[i] ?? "", rightWidth)}`);
	}
	return lines;
}

export function zipColumnBlocks(blocks: ReadonlyArray<string[]>, widths: ReadonlyArray<number>, sep: string): string[] {
	const rowCount = blocks.reduce((max, block) => Math.max(max, block.length), 0);
	const lines: string[] = [];
	for (let row = 0; row < rowCount; row += 1) {
		const cells = blocks.map((block, index) => cell(block[row] ?? "", widths[index] ?? 0));
		lines.push(cells.join(sep));
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
	if (name === ToolNames.AskUser) return width < 72 ? "ask" : "waiting for user";
	if (!name || width < 72) return "tool";
	const nameWidth = width >= 100 ? 18 : 12;
	// The pill label is never padded; truncate without pad so the tool name is
	// followed by a single space before the badge, not a column of blanks.
	return `tool ${truncateToWidth(name, nameWidth, "…", false)}`;
}

function harnessPhasePresentation(status: AgentStatus, width: number, now: number): HarnessPhasePresentation {
	const ultraNarrow = width < 48;
	switch (status.phase) {
		case "idle":
			return { glyph: GLYPH.queued, label: "idle", token: "muted", live: false };
		case "preparing":
			return { glyph: GLYPH.phaseWaiting, label: "prep", token: "info", live: true };
		case "waiting_model":
			return { glyph: GLYPH.phaseWaiting, label: "waiting", token: "info", live: true };
		case "thinking":
			return { glyph: GLYPH.phaseThinking, label: "thinking", token: "reason", live: true };
		case "writing":
			return { glyph: GLYPH.phaseWriting, label: "writing", token: "accent", live: true };
		case "tool_running":
			return { glyph: GLYPH.phaseTool, label: shortToolLabel(status, width), token: "accent", live: true };
		case "tool_blocked":
			// Attention states hold a static glyph rather than spinning: the work
			// has paused for a human, so the pill should not read as live progress.
			// The phase fires only on PermissionRequested, so the pill names the
			// wait for confirmation; "blocked" would contradict the ask overlay.
			return { glyph: GLYPH.phaseBlocked, label: "confirm", token: "warning", live: false };
		case "retrying": {
			const attempt = status.retry?.attempt ?? 0;
			const maxAttempts = status.retry?.maxAttempts ?? 0;
			return {
				glyph: GLYPH.phaseRetry,
				label: ultraNarrow ? "retry" : `retry ${attempt}/${maxAttempts}`,
				token: "warning",
				live: false,
			};
		}
		case "compacting":
			return { glyph: GLYPH.phaseCompact, label: "compacting", token: "reason", live: true };
		case "dispatching":
			return { glyph: GLYPH.phaseDispatch, label: "dispatch", token: "action", live: true };
		case "stuck": {
			const seconds = Math.max(0, Math.floor((now - status.since) / 1000));
			return { glyph: GLYPH.warn, label: ultraNarrow ? "stuck" : `stuck ${seconds}s`, token: "error", live: false };
		}
		case "ended":
			return { glyph: GLYPH.ok, label: "done", token: "success", live: false };
	}
}

function activeWorkerCount(rows: ReadonlyArray<DispatchBoardRow>): number {
	return rows.filter((row) => row.status === "running" || row.status === "stale" || row.status === "enqueued").length;
}

function harnessBadge(
	theme: ClioTheme,
	status: AgentStatus,
	toolCounts: ToolTallySnapshot,
	dispatchRows: ReadonlyArray<DispatchBoardRow>,
	fleetSummaryIsAction = false,
): string {
	const workers = activeWorkerCount(dispatchRows);
	const activeTools = finiteNonNegative(toolCounts.active);
	// Active fleet work is a Clio-signature state; it gets the action color.
	if (workers > 0) {
		const token = status.phase === "dispatching" ? "muted" : fleetSummaryIsAction ? "accent" : "action";
		return theme.fg(token, `fleet ${workers}`);
	}
	const badgeText = activeTools > 0 ? `tools ${activeTools}` : null;
	return badgeText ? theme.fg("muted", badgeText) : "";
}

function outputVerbosityLabel(verbosity: OutputVerbosity): string {
	return verbosity === "minimal" ? "min" : verbosity === "verbose" ? "verbose" : "default";
}

export function buildHarnessStatePill(
	theme: ClioTheme,
	status: AgentStatus,
	toolCounts: ToolTallySnapshot,
	dispatchRows: ReadonlyArray<DispatchBoardRow>,
	tick: number,
	now: number,
	width: number,
	showBadge = true,
	fleetSummaryIsAction = false,
): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const badge =
		showBadge && safeWidth >= 48 ? harnessBadge(theme, status, toolCounts, dispatchRows, fleetSummaryIsAction) : "";
	// Idleness is absence of work, not a phase worth narrating. If a tool or
	// fleet remains live while the harness settles, keep that activity without
	// prefixing it with an idle glyph.
	if (status.phase === "idle") return badge;
	const phase = harnessPhasePresentation(status, safeWidth, now);
	// A live phase leads with the animated spinner; the spinner stands in for the
	// static phase glyph rather than sitting beside it. Static glyphs render only
	// for the attention states and ended forms; idle returned quietly above.
	const lead = phase.live ? spinnerFrame(tick) : phase.glyph;
	const mainPill = theme.style(phase.token, `${lead} ${phase.label}`);
	return badge ? `${mainPill} ${theme.fg("dim", "·")} ${badge}` : mainPill;
}

/**
 * Drop order for the metric strip. The chip budget and the width budget both cut
 * from the highest rank down, so one ordering decides what an 80-column footer
 * keeps.
 *
 * The session total sits alone at the top. It is measured, it does not depend on
 * pricing, and it does not go stale between turns, which is not true of anything
 * else on the strip. At 80 columns the budget is four chips and the per-turn
 * detail used to spend all of it, so a session holding 9.7k measured tokens
 * showed none of them.
 */
const CHIP_RANK_LEADER = -1;
const CHIP_RANK_TOTALS = 0;
const CHIP_RANK_DETAIL = 1;
const CHIP_RANK_DEFERRED = 2;

interface RankedChip {
	text: string;
	rank: number;
}

function pushChip(chips: RankedChip[], text: string | null, rank: number): void {
	if (typeof text === "string" && text.length > 0) chips.push({ text, rank });
}

/**
 * Cut the strip to the chip budget and then to the width, dropping the
 * lowest-priority chip still standing each time. Within one rank the rightmost
 * goes first, which keeps the surviving chips in the order they were built.
 */
function selectChips(
	theme: ClioTheme,
	chips: ReadonlyArray<RankedChip>,
	chipLimit: number,
	maxWidth: number,
): string[] {
	const dropOrder = chips
		.map((chip, index) => ({ rank: chip.rank, index }))
		.sort((a, b) => b.rank - a.rank || b.index - a.index);
	const dropped = new Set<number>();
	const surviving = (): string[] => chips.filter((_, index) => !dropped.has(index)).map((chip) => chip.text);
	for (const { index } of dropOrder) {
		if (chips.length - dropped.size <= chipLimit && visibleWidth(joinChips(theme, surviving())) <= maxWidth) break;
		dropped.add(index);
	}
	return surviving();
}

export function buildMetricStrip(
	theme: ClioTheme,
	status: AgentStatus,
	throughput: TokenThroughputSnapshot | null | undefined,
	lastTurn: TurnSummary | null | undefined,
	sessionTokens: UsageBreakdown | null | undefined,
	sessionCost: CostAggregate | null | undefined,
	liveInputTokens: number | null | undefined,
	maxWidth: number,
	maxChipsCount = 6,
	outputVerbosity?: OutputVerbosity | null,
	leaderArmed = false,
): string {
	const safeMaxWidth = Math.max(0, Math.floor(maxWidth));
	if (safeMaxWidth <= 0) return "";
	const isStreaming = status.phase !== "idle" && status.phase !== "ended";
	const meaningfulVerbosity = outputVerbosity && outputVerbosity !== "default" ? outputVerbosity : null;
	if (!isStreaming && !lastTurn && !meaningfulVerbosity && !leaderArmed) return "";

	const candidates: Array<string | null> = [];
	/** Per-turn detail that ranks below the session totals when the strip is cut. */
	const deferred: Array<string | null> = [];
	if (isStreaming) {
		const tps = finiteNonNegative(throughput?.tokensPerSecond);
		const rounded = tps > 0 ? (tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10) : null;
		candidates.push(rounded !== null ? theme.fg("success", `${GLYPH.speed}${rounded}/s`) : null);

		const liveOutput = finiteNonNegative(throughput?.outputTokens);
		candidates.push(liveOutput > 0 ? theme.fg("success", `${GLYPH.down}${formatFooterTokens(liveOutput)}`) : null);

		const ttftMs = finiteNonNegative(throughput?.ttftMs);
		candidates.push(ttftMs > 0 ? theme.fg("muted", `ttft ${formatCompactMs(ttftMs)}`) : null);

		const inputTokens =
			finiteNonNegative(liveInputTokens) ||
			finiteNonNegative(status.summary?.inputTokens) ||
			finiteNonNegative(lastTurn?.inputTokens) ||
			finiteNonNegative(sessionTokens?.input);
		candidates.push(inputTokens > 0 ? theme.fg("muted", `${GLYPH.up}${formatFooterTokens(inputTokens)}`) : null);
	} else if (lastTurn) {
		const stop = stopReasonStyle(lastTurn.stopReason);
		candidates.push(theme.fg(stop.token, `${stop.glyph} ${formatCompactMs(lastTurn.elapsedMs)}`));
		candidates.push(
			theme.fg(
				"muted",
				`${GLYPH.up}${formatFooterTokens(lastTurn.inputTokens)} ${GLYPH.down}${formatFooterTokens(lastTurn.outputTokens)}`,
			),
		);
		candidates.push(
			lastTurn.reasoningTokens !== undefined && lastTurn.reasoningTokens > 0
				? theme.fg(
						"reason",
						`r${lastTurn.reasoningTokenProvenance === "estimated" || lastTurn.reasoningTokenProvenance === "mixed" ? "≈" : ""}${formatFooterTokens(lastTurn.reasoningTokens)}`,
					)
				: null,
		);
		// Held back so the session totals below outrank them. The chip list is cut
		// to `maxChipsCount` before it is measured, and with cache and tools ahead
		// of the totals an 80-column terminal spent the whole budget on per-turn
		// detail: the cost field disappeared from the footer at the exact moment
		// it acquired a value, while `/cost` on the same session read `cost
		// unknown`. Two surfaces, two answers, because of a slice.
		deferred.push(
			lastTurn.cacheReadTokens > 0 || lastTurn.cacheWriteTokens > 0
				? theme.fg(
						"dim",
						`cache ${formatFooterTokens(lastTurn.cacheReadTokens)}/${formatFooterTokens(lastTurn.cacheWriteTokens)}`,
					)
				: null,
		);
		if (lastTurn.toolCount > 0) {
			const label = `${lastTurn.toolCount} tool${lastTurn.toolCount === 1 ? "" : "s"}`;
			const errors = lastTurn.toolErrorCount > 0 ? theme.fg("error", ` ${lastTurn.toolErrorCount}${GLYPH.error}`) : "";
			deferred.push(`${theme.fg("muted", label)}${errors}`);
		} else {
			deferred.push(null);
		}
	}
	if (meaningfulVerbosity) deferred.push(theme.fg("muted", `out ${outputVerbosityLabel(meaningfulVerbosity)}`));

	const fallbackTotal = finiteNonNegative(sessionTokens?.input) + finiteNonNegative(sessionTokens?.output);
	const cumulativeTotal = finiteNonNegative(sessionTokens?.totalTokens) || fallbackTotal;
	const totalChip = cumulativeTotal > 0 ? theme.fg("muted", `Σ${formatFooterTokens(cumulativeTotal)}`) : null;
	// Null when nothing priced these tokens, and an absent chip is the honest
	// rendering of that. `$0.00` on a session that had made no call was a number
	// nothing measured, and `cost unknown` beside a real Σ read as doubt about
	// the tokens. See formatCostAggregate.
	const cost = formatCostAggregate(sessionCost);
	const costChip = cost === null ? null : theme.fg("muted", cost);

	const chipLimit = Math.max(0, Math.floor(maxChipsCount));
	const chips: RankedChip[] = [];
	// Ranked above every measurement: the strip is cut by dropping the
	// lowest-ranked chip, and this one is the answer to "did that key register".
	pushChip(chips, leaderArmed ? theme.fg("accent", "leader armed") : null, CHIP_RANK_LEADER);
	for (const chip of candidates) pushChip(chips, chip, CHIP_RANK_DETAIL);
	pushChip(chips, totalChip, CHIP_RANK_TOTALS);
	pushChip(chips, costChip, CHIP_RANK_DETAIL);
	for (const chip of deferred) pushChip(chips, chip, CHIP_RANK_DEFERRED);
	return joinChips(theme, selectChips(theme, chips, chipLimit, safeMaxWidth));
}
