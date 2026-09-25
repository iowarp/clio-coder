import type { OutputStyle } from "../../core/defaults.js";
import { ToolNames } from "../../core/tool-names.js";
import type { LiveBudgetView } from "../../domains/context/budget/live-view.js";
import {
	type CostAggregate,
	formatCostAggregate,
	type TokenThroughputSnapshot,
	type UsageBreakdown,
} from "../../domains/observability/index.js";
import { describeLocalCapacity, type LocalCapacity } from "../../domains/scheduling/local-capacity.js";
import type { ContextUsageBreakdown } from "../../domains/session/context-accounting.js";
import type { ContextLedger, ContextLedgerCategory } from "../../domains/session/context-ledger.js";
import { type TaskBoardSnapshot, taskBoardCounts } from "../../domains/session/task-board.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { CONTEXT_CATEGORY_TOKEN, contextCategorySwatch, renderContextMeterBar } from "../context-meter.js";
import {
	agentDisplayLabel,
	type DispatchBoardRow,
	dispatchRowPrefix,
	dispatchStatusPresentation,
} from "../dispatch-board.js";
import { buildSegmentedContextBar, CONTEXT_BAR_LABEL_WIDTH, formatFooterTokens } from "../footer-panel.js";
import {
	type AgentStatus,
	formatReasoningChip,
	reasoningFromSummary,
	spinnerFrame,
	type TurnSummary,
} from "../status/index.js";
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
import { fitIdentityLabel } from "../theme/labels.js";
import { isHelperRun } from "../worker-stream.js";

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
	/** Raw route fields for boundary-aware fitting in the compact footer. */
	targetId?: string | null;
	modelId?: string | null;
	capabilities: string[] | null;
	safety: string | null;
	toolProfile: string | null;
	/** Active transcript detail mode, shown in the dashboard so visibility is never implicit. */
	outputStyle?: OutputStyle | null;
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
	activeSkills?: ReadonlyArray<string>;
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

/** Responsive bands for the expanded footer. */
export const EXPANDED_WIDE = 80;
export const EXPANDED_MID = 70;
export const EXPANDED_ULTRAWIDE = 220;

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
 * Workspace/status row helper: workspace identity on the left and a meaningful
 * work phase on the right. The active compact dashboard layout is composed in
 * dashboard.ts, including its route label.
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
	localCapacity: LocalCapacity | null = null,
): string {
	const safeWidth = Math.max(1, Math.floor(width));
	let git = safeWidth >= COMPACT_GIT_MIN_WIDTH ? gitChip(theme, workspace.branch, workspace.dirty) : null;
	let right = buildHarnessStatePill(
		theme,
		status,
		toolCounts,
		dispatchRows,
		tick,
		now,
		safeWidth,
		true,
		false,
		localCapacity,
	);
	// A long temporary parent must yield before the active worker count.
	const cwd = fitIdentityLabel(workspace.cwd, Math.max(8, safeWidth - visibleWidth(right) - 1));
	let left = joinSections(theme, [theme.fg("muted", cwd), git]);

	if (git && visibleWidth(left) + 1 + visibleWidth(right) > safeWidth) {
		git = null;
		left = theme.fg("muted", cwd);
	}

	if (visibleWidth(left) + 1 + visibleWidth(right) > safeWidth) {
		right = buildHarnessStatePill(
			theme,
			status,
			toolCounts,
			dispatchRows,
			tick,
			now,
			safeWidth,
			false,
			false,
			localCapacity,
		);
	}

	if (visibleWidth(left) + 1 + visibleWidth(right) > safeWidth) {
		const maxCwdWidth = Math.max(1, safeWidth - visibleWidth(right) - 1);
		left = theme.fg("muted", fitIdentityLabel(workspace.cwd, maxCwdWidth));
	}

	return joinColumns(left, right, safeWidth);
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
		free:
			window > 0 && typeof context.used === "number" && Number.isFinite(context.used) ? Math.max(0, window - used) : null,
	};
}

/** Short truthful occupancy label shared by compact and expanded surfaces. */
export function contextUsageText(context: ContextEngineFacts): string {
	const used = context.budget ? context.used : (context.ledger?.usedTokens ?? context.used);
	const window = context.budget ? context.contextWindow : (context.ledger?.contextWindow ?? context.contextWindow);
	const source = context.budget?.inputSource === "historical" ? "saved " : context.budget && used !== null ? "~" : "";
	return `${source}${used === null ? "?" : formatFooterTokens(used)} / ${window ? formatFooterTokens(window) : "?"}`;
}

/** The share of the window `contextUsageText` states, in percent; null when either number is unknown. */
export function contextUsagePercent(context: ContextEngineFacts): number | null {
	const used = context.budget ? context.used : (context.ledger?.usedTokens ?? context.used);
	const window = context.budget ? context.contextWindow : (context.ledger?.contextWindow ?? context.contextWindow);
	return used === null || !window ? null : (used / window) * 100;
}

/** Reads published numbers only; never refreshes accounting from a renderer. */
export function contextOccupancyBar(context: ContextEngineFacts, cells: number, theme: ClioTheme): string {
	if (!context.budget && context.ledger) return renderContextMeterBar(context.ledger, cells, theme);
	return buildSegmentedContextBar(
		theme,
		cells,
		context.contextWindow ?? 0,
		context.used === null ? undefined : contextBreakdownForBar(context),
	);
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
		const value = row.styled ? (row.value ?? "") : theme.fg(row.valueToken ?? "muted", row.value ?? "");
		return wrapTextWithAnsi(value, Math.max(1, width - prefixWidth)).map(
			(line, index) =>
				`${index === 0 ? theme.fg("dim", `${row.key.padEnd(keyWidth)} `.slice(0, prefixWidth)) : " ".repeat(prefixWidth)}${line}`,
		);
	});
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
	return dashboardBlock(
		theme,
		"Workspace",
		[
			kv("cwd", facts.cwd),
			styledKv("git", gitValue(theme, facts.branch, facts.dirty)),
			kv("type", facts.projectType),
			kv("remote", remote),
		],
		_options.width,
	);
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

export function sessionQuadrant(facts: SessionFacts, _options: ExpandedQuadrantOptions = {}): string[] {
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
				Number.POSITIVE_INFINITY,
			)
		: null;
	return dashboardBlock(
		theme,
		"Session",
		[
			identity ? kv(identity.key, identity.value, "accent") : statusRow(null),
			kv("target", facts.target, "accent"),
			styledKv("caps", capabilitiesValue(theme, facts.capabilities)),
			// accentDeep is a structure color reserved for the section tag; the autonomy
			// value is a plain fact and reads muted like the other neutral values.
			kv("autonomy", facts.safety),
			kv("profile", facts.toolProfile),
			kv(
				"output",
				facts.outputStyle && facts.outputStyle !== "standard" ? facts.outputStyle : null,
				facts.outputStyle === "detailed" ? "accent" : "muted",
			),
			styledKv("memory", memoryValue),
		],
		_options.width,
	);
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
		ledger.groups.some((group) => group.category === "toolResults")
			? theme.fg(
					"tool",
					`results ${formatFooterTokens(ledger.groups.find((group) => group.category === "toolResults")?.tokens ?? 0)}`,
				)
			: null,
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
			composition.system > 0 ? theme.fg("info", `sys ${formatFooterTokens(composition.system)}`) : null,
			composition.tools > 0 ? theme.fg("warning", `tools ${formatFooterTokens(composition.tools)}`) : null,
		]);
		chatFree = joinChips(theme, [
			composition.chat > 0 ? theme.fg("accent", formatFooterTokens(composition.chat)) : null,
			composition.free !== null
				? theme.style("frame", `free ${formatFooterTokens(composition.free)}`, { dim: true })
				: null,
		]);
		bar = contextOccupancyBar(facts, barCells, theme);
		const filledChar = visibleWidth(GLYPH.contextFull) === 1 ? GLYPH.contextFull : GLYPH.barFull;
		const freeChar = visibleWidth(GLYPH.contextFree) === 1 ? GLYPH.contextFree : GLYPH.barEmpty;
		legendRows = [
			`${theme.fg("info", `${filledChar} sys`)} ${theme.fg("warning", `${filledChar} tools`)} ${theme.fg("accent", `${filledChar} chat`)} ${theme.style("frame", `${freeChar} free`, { dim: true })}`,
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
	if (reason === "aborted" || reason === "cancelled") return { glyph: GLYPH.cancelled, token: "dim" };
	if (reason === "length") return { glyph: GLYPH.warn, token: "warning" };
	return { glyph: GLYPH.ok, token: "success" };
}

/**
 * One row per live worker: the origin glyph, the sub-process glyph when Clio
 * started the run for itself, the agent's own name, the fleet node it landed
 * on, its status glyph, elapsed, and the receipt id once the run has sealed
 * one. Units are fitted whole, so a narrow quadrant closes on a dim ellipsis
 * rather than clipping a receipt id into a string that still reads like a valid
 * trace argument.
 */
function workerLine(theme: ClioTheme, row: DispatchBoardRow, _width: number): string {
	const presentation = dispatchStatusPresentation(row.status, { compact: true });
	// The Activity section already promotes the fleet summary (or dispatch phase)
	// to action orange. Worker rows remain readable without repeating that signal.
	const units = [
		theme.fg("muted", agentDisplayLabel(row)),
		theme.fg("dim", row.node ?? "local"),
		theme.fg(presentation.token, presentation.glyph),
		theme.fg("dim", formatCompactMs(row.elapsedMs)),
		...(row.receiptId !== undefined ? [theme.fg("dim", row.receiptId)] : []),
	];
	if (row.progress?.toolCalls !== undefined) units.push(theme.fg("muted", `${row.progress.toolCalls} calls`));
	if (row.progress?.contextTokens !== undefined)
		units.push(theme.fg("muted", `context ${formatFooterTokens(row.progress.contextTokens)}`));
	if (row.progress?.inputTokens !== undefined || row.inputTokens > 0 || row.outputTokens > 0) {
		units.push(theme.fg("dim", `↑${formatFooterTokens(row.inputTokens)} ↓${formatFooterTokens(row.outputTokens)}`));
	}
	return `${dispatchRowPrefix(theme, row).text}${units.join(" · ")}`;
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

/**
 * The last turn's reasoning chip, or null when the turn spent none. Every
 * surface that shows reasoning reads the same projection, so the transcript,
 * this footer, and the receipt cannot disagree about the count or whether it
 * is provider-attested.
 */
function reasoningChip(theme: ClioTheme, lastTurn: TurnSummary): string | null {
	const chip = formatReasoningChip(reasoningFromSummary(lastTurn), formatFooterTokens);
	return chip === null ? null : theme.fg("reason", chip);
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
		reasoningChip(theme, lastTurn),
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
				facts.localCapacity ?? null,
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
	const fleetRows = facts.dispatchRows;
	for (const row of fleetRows.slice(0, maxWorkers)) rows.push(statusRow(workerLine(theme, row, workerWidth)));
	const hiddenWorkers = fleetRows.length - maxWorkers;
	if (hiddenWorkers > 0) rows.push(statusRow(theme.fg("dim", `+${hiddenWorkers} more`)));
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

export function zipColumnBlocks(blocks: ReadonlyArray<string[]>, widths: ReadonlyArray<number>, sep: string): string[] {
	blocks = blocks.map((block, index) =>
		block.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, widths[index] ?? 1))),
	);
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
	if (name === ToolNames.AskUser) return "Needs input";
	if (name === ToolNames.Dispatch) return "Waiting for worker";
	if (!name || width < 72) return "Running tool";
	const nameWidth = width >= 100 ? 18 : 12;
	// The pill label is never padded; truncate without pad so the tool name is
	// followed by a single space before the badge, not a column of blanks.
	return `Running ${truncateToWidth(name, nameWidth, "…", false)}`;
}

function harnessPhasePresentation(status: AgentStatus, width: number, now: number): HarnessPhasePresentation {
	const ultraNarrow = width < 48;
	switch (status.phase) {
		case "idle":
			return { glyph: GLYPH.queued, label: "Ready", token: "muted", live: false };
		case "preparing":
			return { glyph: GLYPH.phaseWaiting, label: "Preparing", token: "info", live: true };
		case "waiting_model":
			return { glyph: GLYPH.phaseWaiting, label: "Waiting for model", token: "info", live: true };
		case "thinking":
			return { glyph: GLYPH.phaseThinking, label: "Thinking", token: "reason", live: true };
		case "writing":
			return {
				glyph: GLYPH.phaseWriting,
				label: status.preparingToolCall ? "Preparing tool call" : "Writing",
				token: "accent",
				live: true,
			};
		case "tool_running":
			return {
				glyph: GLYPH.phaseTool,
				label: shortToolLabel(status, width),
				token: "accent",
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
				label: ultraNarrow ? "retry" : `retry ${attempt}/${maxAttempts}`,
				token: "warning",
				live: false,
			};
		}
		case "compacting":
			return { glyph: GLYPH.phaseCompact, label: "Compacting context", token: "reason", live: true };
		case "dispatching":
			return { glyph: GLYPH.phaseDispatch, label: "Waiting for worker", token: "action", live: true };
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
			if (stop === "aborted" || stop === "cancelled")
				return { glyph: GLYPH.cancelled, label: "Cancelled", token: "muted", live: false };
			if (stop === "length") return { glyph: GLYPH.warn, label: "Output limit", token: "warning", live: false };
			return { glyph: GLYPH.ok, label: "Ready", token: "success", live: false };
		}
	}
}

function activeWorkerRows(rows: ReadonlyArray<DispatchBoardRow>): ReadonlyArray<DispatchBoardRow> {
	return rows.filter((row) => row.status === "running" || row.status === "stale" || row.status === "enqueued");
}

/**
 * Background work stays a count beside the main phase. When a host limit holds
 * local demand below what is queued, the chip names that limit.
 */
function activeWorkerChip(rows: ReadonlyArray<DispatchBoardRow>, localCapacity: LocalCapacity | null = null): string {
	const active = activeWorkerRows(rows);
	const helpers = active.filter(isHelperRun).length;
	const workers = active.length - helpers;
	const chip = [
		helpers > 0 ? `${helpers} helper${helpers === 1 ? "" : "s"}` : null,
		workers > 0 ? `${workers} worker${workers === 1 ? "" : "s"}` : null,
	]
		.filter(Boolean)
		.join(" · ");
	if (localCapacity === null) return chip;
	const localDemand = active.filter((row) => row.node === undefined || row.node === "local").length;
	const bound = localDemand > localCapacity.limit ? describeLocalCapacity(localCapacity) : null;
	return bound === null ? chip : `${chip} · ${bound}`;
}

function harnessBadge(
	theme: ClioTheme,
	status: AgentStatus,
	toolCounts: ToolTallySnapshot,
	dispatchRows: ReadonlyArray<DispatchBoardRow>,
	fleetSummaryIsAction = false,
	localCapacity: LocalCapacity | null = null,
): string {
	const workers = activeWorkerRows(dispatchRows).length;
	const activeTools = finiteNonNegative(toolCounts.active);
	// Active fleet work is a Clio-signature state; it gets the action color.
	if (workers > 0) {
		const token = status.phase === "dispatching" ? "muted" : fleetSummaryIsAction ? "accent" : "action";
		return theme.fg(token, activeWorkerChip(dispatchRows, localCapacity));
	}
	const badgeText = activeTools > 0 ? `tools ${activeTools}` : null;
	return badgeText ? theme.fg("muted", badgeText) : "";
}

function buildHarnessStatePill(
	theme: ClioTheme,
	status: AgentStatus,
	toolCounts: ToolTallySnapshot,
	dispatchRows: ReadonlyArray<DispatchBoardRow>,
	tick: number,
	now: number,
	width: number,
	showBadge = true,
	fleetSummaryIsAction = false,
	localCapacity: LocalCapacity | null = null,
): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const badge = showBadge
		? harnessBadge(theme, status, toolCounts, dispatchRows, fleetSummaryIsAction, localCapacity)
		: "";
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
