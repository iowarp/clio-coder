import { ToolNames } from "../../core/tool-names.js";
import type { TokenThroughputSnapshot, UsageBreakdown } from "../../domains/observability/index.js";
import type { ContextUsageBreakdown } from "../../domains/session/context-accounting.js";
import type { ContextLedger, ContextLedgerCategory } from "../../domains/session/context-ledger.js";
import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { CONTEXT_CATEGORY_TOKEN, contextCategorySwatch, renderContextMeterBar } from "../context-meter.js";
import { agentDisplayLabel, type DispatchBoardRow, type DispatchBoardStatus } from "../dispatch-board.js";
import { buildSegmentedContextBar, CONTEXT_BAR_LABEL_WIDTH, formatFooterTokens } from "../footer-panel.js";
import { type AgentStatus, spinnerFrame, type TurnSummary } from "../status/index.js";
import {
	type ClioTheme,
	type ClioToken,
	clioTheme,
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
}

/** Responsive bands for the expanded footer. */
export const EXPANDED_WIDE = 80;
export const EXPANDED_MID = 70;
export const EXPANDED_ULTRAWIDE = 120;

/** Compact footer shows the git section only when there is room for it. */
const COMPACT_GIT_MIN_WIDTH = 72;

export function fitDashboardLine(line: string, width: number): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line;
}

/** Pad or truncate an already styled string to an exact column width. */
function cell(text: string, width: number): string {
	const safe = Math.max(0, width);
	const clipped = truncateToWidth(text, safe, "", true);
	return `${clipped}${" ".repeat(Math.max(0, safe - visibleWidth(clipped)))}`;
}

export function joinColumns(left: string, right: string, width: number): string {
	const safe = Math.max(0, Math.floor(width));
	if (safe === 0) return "";
	if (visibleWidth(right) === 0) return cell(left, safe);
	const rightWidth = visibleWidth(right);
	if (rightWidth >= safe) return cell(right, safe);
	const leftBudget = Math.max(0, safe - rightWidth - 1);
	const fittedLeft = visibleWidth(left) > leftBudget ? truncateToWidth(left, leftBudget, "", true) : left;
	const gap = Math.max(1, safe - visibleWidth(fittedLeft) - rightWidth);
	return cell(`${fittedLeft}${" ".repeat(gap)}${right}`, safe);
}

function finiteNonNegative(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function formatToolTally(snapshot: ToolTallySnapshot | null | undefined): string {
	if (!snapshot) return `none · 0${GLYPH.error}`;
	const entries = Object.entries(snapshot.tools)
		.filter(([name, count]) => count > 0 && name.toLowerCase() !== "dispatch")
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 4)
		.map(([name, count]) => `${name} ${formatFooterTokens(count)}`);
	const prefix = entries.length > 0 ? entries.join(" · ") : "none";
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

function gitValue(theme: ClioTheme, branch: string | null, dirty: boolean | null): string {
	if (!branch) return theme.fg("dim", "none");
	return `${theme.fg("success", branch)} ${gitMarker(theme, dirty)}`;
}

/** `github.com/owner/repo` → `owner/repo`; otherwise the host or the raw value, trimmed. */
export function collapseRemote(remote: string | null): string | null {
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
 * Compact primary row: workspace identity on the left, session resources on the
 * right. The editor rail owns model and thinking labels. The branch appears
 * here, and only here, across the whole screen.
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
	sessionCost: number | null = null,
): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const barCells = compactContextBarWidth(safeWidth);
	let left = "";
	if (context.ledger) {
		const percent = context.ledger.percent !== null ? `${context.ledger.percent.toFixed(1)}%` : "?%";
		left = `ctx ${renderContextMeterBar(context.ledger, barCells, theme)} ${percent}`;
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
	);
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

function dashboardBlock(
	theme: ClioTheme,
	token: ClioToken,
	label: string,
	rows: ReadonlyArray<DashboardRow>,
): string[] {
	const keyWidth = rows.reduce((max, row) => (row.kind === "kv" ? Math.max(max, row.key.length) : max), 0);
	const body = rows
		.map((row) => renderDashboardRow(theme, row, keyWidth))
		.filter((row): row is string => typeof row === "string" && row.length > 0);
	return [sectionTag(theme, token, label.toUpperCase(), 0), ...body];
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
	return dashboardBlock(theme, "info", "Workspace", [
		kv("cwd", facts.cwd),
		styledKv("git", gitValue(theme, facts.branch, facts.dirty)),
		kv("type", facts.projectType),
		kv("remote", remote),
	]);
}

function sessionIdentity(facts: SessionFacts): { key: string; value: string } {
	if (facts.id) return { key: "id", value: facts.id };
	if (facts.name) return { key: "name", value: facts.name };
	return { key: "id", value: "none" };
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
	return dashboardBlock(theme, "accent", "Session", [
		kv(identity.key, identity.value, "accent"),
		kv("target", facts.target, "accent"),
		kv("think", facts.thinking, "reason"),
		styledKv("caps", capabilitiesValue(theme, facts.capabilities)),
		kv("autonomy", facts.safety, "accentDeep"),
		kv("profile", facts.toolProfile),
	]);
}

function expandedContextBarCells(width: number | undefined): number {
	if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return 12;
	const budget = Math.max(6, Math.floor(width) - CONTEXT_BAR_LABEL_WIDTH - 1);
	const desired = width >= 36 ? 16 : width >= 32 ? 14 : 12;
	return Math.max(8, Math.min(16, desired, budget));
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

function sourceState(theme: ClioTheme, facts: ContextEngineFacts): string {
	return joinChips(theme, [
		theme.fg("muted", facts.clioMd ?? "CLIO.md none"),
		theme.fg("muted", facts.memory ?? "mem none"),
	]);
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

/** Swatch legend covering exactly the categories present in the meter. */
function ledgerLegend(theme: ClioTheme, ledger: ContextLedger): string {
	return ledger.meter
		.map((group) => {
			const labelToken: ClioToken = group.category === "free" || group.category === "reserve" ? "dim" : "muted";
			return `${contextCategorySwatch(group.category, theme)} ${theme.fg(labelToken, CONTEXT_SHORT_LABEL[group.category])}`;
		})
		.join(" ");
}

function ledgerBar(theme: ClioTheme, ledger: ContextLedger, cells: number): string {
	const percent = ledger.percent !== null ? `${ledger.percent.toFixed(1)}%` : "--%";
	return `${renderContextMeterBar(ledger, cells, theme)}  ${theme.fg("muted", percent)}`;
}

export function contextQuadrant(facts: ContextEngineFacts, options: ExpandedQuadrantOptions = {}): string[] {
	const theme = clioTheme();
	const ledger = facts.ledger ?? null;
	const hasLedger = ledger !== null && ledger.contextWindow > 0;
	const barCells = expandedContextBarCells(options.width);

	let bar: string;
	let fill: string;
	let chatFree: string;
	let legend: string;
	if (hasLedger && ledger) {
		bar = ledgerBar(theme, ledger, barCells);
		fill = ledgerSystemChips(theme, ledger);
		chatFree = ledgerChatChips(theme, ledger);
		legend = ledgerLegend(theme, ledger);
	} else {
		const composition = contextComposition(facts);
		fill = joinChips(theme, [
			composition.system > 0 ? theme.fg("info", `sys ${formatFooterTokens(composition.system)}`) : null,
			composition.tools > 0 ? theme.fg("warning", `tools ${formatFooterTokens(composition.tools)}`) : null,
		]);
		chatFree = joinChips(theme, [
			composition.chat > 0 ? theme.fg("accent", formatFooterTokens(composition.chat)) : theme.fg("accent", "0"),
			composition.free !== null
				? theme.style("frame", `free ${formatFooterTokens(composition.free)}`, { dim: true })
				: null,
		]);
		bar = buildSegmentedContextBar(theme, barCells, facts.contextWindow ?? 0, contextBreakdownForBar(facts));
		const filledChar = visibleWidth(GLYPH.contextFull) === 1 ? GLYPH.contextFull : GLYPH.barFull;
		const freeChar = visibleWidth(GLYPH.contextFree) === 1 ? GLYPH.contextFree : GLYPH.barEmpty;
		legend = `${theme.fg("info", `${filledChar} sys`)} ${theme.fg("warning", `${filledChar} tools`)} ${theme.fg("accent", `${filledChar} chat`)} ${theme.style("frame", `${freeChar} free`, { dim: true })}`;
	}

	const usedTokens = hasLedger && ledger ? ledger.usedTokens : facts.used;
	const windowTokens = hasLedger && ledger ? ledger.contextWindow : facts.contextWindow;
	return dashboardBlock(theme, "reason", "Context", [
		statusRow(bar),
		kv("used", formatUsedWindow(usedTokens, windowTokens)),
		fill ? styledKv("fill", fill) : kv("fill", "none"),
		chatFree ? styledKv("chat", chatFree) : kv("chat", "none"),
		kv("compact", formatCompaction(facts)),
		styledKv("source", sourceState(theme, facts)),
		facts.extensions && facts.extensions.installed > 0
			? kv("ext", `${facts.extensions.active}/${facts.extensions.installed}`)
			: statusRow(null),
		legendRow(legend),
	]);
}

function statusGlyph(status: DispatchBoardStatus): string {
	if (status === "running" || status === "stale" || status === "enqueued") return GLYPH.running;
	if (status === "completed") return GLYPH.ok;
	if (status === "aborted") return GLYPH.cancelled;
	return GLYPH.error;
}

function statusToken(status: DispatchBoardStatus): ClioToken {
	if (status === "completed") return "success";
	if (status === "running" || status === "enqueued") return "accent";
	if (status === "stale") return "warning";
	return "error";
}

function formatElapsed(value: number): string {
	const ms = Math.max(0, Math.round(value));
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	return seconds < 60
		? `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`
		: `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
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
		theme.fg(stop.token, `${stop.glyph} ${formatElapsed(summary.elapsedMs)}`),
		theme.fg("muted", `${GLYPH.up}${summary.inputTokens} ${GLYPH.down}${summary.outputTokens}`),
	];
	if (typeof summary.reasoningTokens === "number" && summary.reasoningTokens > 0) {
		parts.push(theme.fg("reason", `r${summary.reasoningTokens}`));
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

export function workerLine(theme: ClioTheme, row: DispatchBoardRow): string {
	const glyph = theme.fg(statusToken(row.status), statusGlyph(row.status));
	return `${glyph} ${theme.fg("muted", agentDisplayLabel(row))} ${theme.fg("dim", `${row.status} ${formatElapsed(row.elapsedMs)}`)}`;
}

interface ActivityQuadrantOptions extends ExpandedQuadrantOptions {
	status?: AgentStatus;
	toolCounts?: ToolTallySnapshot;
	throughput?: TokenThroughputSnapshot | null;
	sessionTokens?: UsageBreakdown | null;
	sessionCost?: number | null;
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
	const parts = [theme.fg("success", `⚡${rounded}/s`)];
	const ttft = finiteNonNegative(throughput?.ttftMs);
	if (ttft > 0) parts.push(theme.fg("muted", `ttft ${formatElapsed(ttft)}`));
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
	return theme.fg(stop.token, `${stop.glyph} ${formatElapsed(lastTurn.elapsedMs)}`);
}

function lastTurnDetails(theme: ClioTheme, lastTurn: TurnSummary): string {
	const parts: Array<string | null> = [
		theme.fg(
			"muted",
			`${GLYPH.up}${formatFooterTokens(lastTurn.inputTokens)} ${GLYPH.down}${formatFooterTokens(lastTurn.outputTokens)}`,
		),
		finiteNonNegative(lastTurn.reasoningTokens) > 0
			? theme.fg("reason", `r${formatFooterTokens(lastTurn.reasoningTokens ?? 0)}`)
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

function fleetValue(dispatchSummary: string | null, dispatchRows: ReadonlyArray<DispatchBoardRow>): string {
	if (dispatchSummary) return dispatchSummary.replace(/^dispatch\s+/, "");
	return dispatchRows.length > 0 ? `${dispatchRows.length} runs` : "none";
}

export function activityQuadrant(facts: AgentWorkFacts, options: ActivityQuadrantOptions = {}): string[] {
	const theme = clioTheme();
	const maxWorkers = Math.max(0, options.maxWorkers ?? 3);
	const status = options.status ?? defaultIdleStatus();
	const toolCounts = options.toolCounts ?? { tools: {}, errors: 0 };
	const statusWidth = Math.max(options.width ?? 120, 48);
	const isStreaming = status.phase !== "idle" && status.phase !== "ended";
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
	rows.push(
		typeof options.sessionCost === "number" && Number.isFinite(options.sessionCost)
			? styledKv("cost", theme.fg("muted", formatUsd(options.sessionCost)))
			: statusRow(null),
	);
	rows.push(
		kv("fleet", fleetValue(facts.dispatchSummary, facts.dispatchRows), facts.dispatchSummary ? "warning" : "dim"),
	);
	for (const row of facts.dispatchRows.slice(0, maxWorkers)) rows.push(statusRow(workerLine(theme, row)));
	rows.push(kv("tools", facts.toolTally));
	return dashboardBlock(theme, "success", "Activity", rows);
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

function formatDurationMs(ms: number): string {
	const safe = Math.max(0, Math.round(ms));
	if (safe < 1000) return `${safe}ms`;
	const seconds = safe / 1000;
	return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
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
	return `tool ${truncateToWidth(name, nameWidth, "…", true)}`;
}

function harnessPhasePresentation(status: AgentStatus, width: number, now: number): HarnessPhasePresentation {
	const ultraNarrow = width < 48;
	switch (status.phase) {
		case "idle":
			return { glyph: "◌", label: "idle", token: "muted", live: false };
		case "preparing":
			return { glyph: "◔", label: "prep", token: "info", live: true };
		case "waiting_model":
			return { glyph: "◔", label: "waiting", token: "info", live: true };
		case "thinking":
			return { glyph: "◐", label: "thinking", token: "reason", live: true };
		case "writing":
			return { glyph: "◑", label: "writing", token: "accent", live: true };
		case "tool_running":
			return { glyph: "⚙", label: shortToolLabel(status, width), token: "accent", live: true };
		case "tool_blocked":
			return { glyph: "⏸", label: "blocked", token: "warning", live: true };
		case "retrying": {
			const attempt = status.retry?.attempt ?? 0;
			const maxAttempts = status.retry?.maxAttempts ?? 0;
			return {
				glyph: "↻",
				label: ultraNarrow ? "retry" : `retry ${attempt}/${maxAttempts}`,
				token: "warning",
				live: true,
			};
		}
		case "compacting":
			return { glyph: "♻", label: "compacting", token: "reason", live: true };
		case "dispatching":
			return { glyph: "⇲", label: "dispatch", token: "accent", live: true };
		case "stuck": {
			const seconds = Math.max(0, Math.floor((now - status.since) / 1000));
			return { glyph: "⚠", label: ultraNarrow ? "stuck" : `stuck ${seconds}s`, token: "error", live: true };
		}
		case "ended":
			return { glyph: "✓", label: "done", token: "success", live: false };
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
): string {
	const workers = activeWorkerCount(dispatchRows);
	const activeTools = finiteNonNegative(toolCounts.active);
	let badgeText: string | null = null;
	if (workers > 0) badgeText = `fleet ${workers}`;
	else if (activeTools > 0) badgeText = `tools ${activeTools}`;
	else if (status.phase === "idle") badgeText = "tools none";
	return badgeText ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", badgeText)}` : "";
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
): string {
	const safeWidth = Math.max(1, Math.floor(width));
	const phase = harnessPhasePresentation(status, safeWidth, now);
	const spinner = phase.live ? `${theme.fg(phase.token, spinnerFrame(tick))} ` : "";
	const mainPill = theme.style(phase.token, `${phase.glyph} ${phase.label}`);
	const badge = showBadge && safeWidth >= 48 ? harnessBadge(theme, status, toolCounts, dispatchRows) : "";
	return `${spinner}${mainPill}${badge}`;
}

export function buildMetricStrip(
	theme: ClioTheme,
	status: AgentStatus,
	throughput: TokenThroughputSnapshot | null | undefined,
	lastTurn: TurnSummary | null | undefined,
	sessionTokens: UsageBreakdown | null | undefined,
	sessionCost: number | null | undefined,
	liveInputTokens: number | null | undefined,
	maxWidth: number,
	maxChipsCount = 6,
): string {
	const safeMaxWidth = Math.max(0, Math.floor(maxWidth));
	if (safeMaxWidth <= 0) return "";
	const isStreaming = status.phase !== "idle" && status.phase !== "ended";
	if (!isStreaming && !lastTurn) return "";

	const candidates: Array<string | null> = [];
	if (isStreaming) {
		const tps = finiteNonNegative(throughput?.tokensPerSecond);
		const rounded = tps > 0 ? (tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10) : null;
		candidates.push(rounded !== null ? theme.fg("success", `⚡${rounded}/s`) : null);

		const liveOutput = finiteNonNegative(throughput?.outputTokens);
		candidates.push(liveOutput > 0 ? theme.fg("success", `${GLYPH.down}${formatFooterTokens(liveOutput)}`) : null);

		const ttftMs = finiteNonNegative(throughput?.ttftMs);
		candidates.push(ttftMs > 0 ? theme.fg("muted", `ttft ${formatDurationMs(ttftMs)}`) : null);

		const inputTokens =
			finiteNonNegative(liveInputTokens) ||
			finiteNonNegative(status.summary?.inputTokens) ||
			finiteNonNegative(lastTurn?.inputTokens) ||
			finiteNonNegative(sessionTokens?.input);
		candidates.push(inputTokens > 0 ? theme.fg("muted", `${GLYPH.up}${formatFooterTokens(inputTokens)}`) : null);
	} else if (lastTurn) {
		const stop = stopReasonStyle(lastTurn.stopReason);
		candidates.push(theme.fg(stop.token, `${stop.glyph} ${formatElapsed(lastTurn.elapsedMs)}`));
		candidates.push(
			theme.fg(
				"muted",
				`${GLYPH.up}${formatFooterTokens(lastTurn.inputTokens)} ${GLYPH.down}${formatFooterTokens(lastTurn.outputTokens)}`,
			),
		);
		candidates.push(
			finiteNonNegative(lastTurn.reasoningTokens) > 0
				? theme.fg("reason", `r${formatFooterTokens(lastTurn.reasoningTokens ?? 0)}`)
				: null,
		);
		if (lastTurn.toolCount > 0) {
			const label = `${lastTurn.toolCount} tool${lastTurn.toolCount === 1 ? "" : "s"}`;
			const errors = lastTurn.toolErrorCount > 0 ? theme.fg("error", ` ${lastTurn.toolErrorCount}${GLYPH.error}`) : "";
			candidates.push(`${theme.fg("muted", label)}${errors}`);
		} else {
			candidates.push(null);
		}
	}

	const fallbackTotal = finiteNonNegative(sessionTokens?.input) + finiteNonNegative(sessionTokens?.output);
	const cumulativeTotal = finiteNonNegative(sessionTokens?.totalTokens) || fallbackTotal;
	candidates.push(cumulativeTotal > 0 ? theme.fg("muted", `Σ${formatFooterTokens(cumulativeTotal)}`) : null);
	candidates.push(finiteNonNegative(sessionCost) > 0 ? theme.fg("muted", formatUsd(sessionCost ?? 0)) : null);

	const chipLimit = Math.max(0, Math.floor(maxChipsCount));
	const activeChips = candidates
		.filter((chip): chip is string => typeof chip === "string" && chip.length > 0)
		.slice(0, chipLimit);
	while (activeChips.length > 0 && visibleWidth(joinChips(theme, activeChips)) > safeMaxWidth) activeChips.pop();
	return joinChips(theme, activeChips);
}
