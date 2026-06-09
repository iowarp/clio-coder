import type { TokenThroughputSnapshot, UsageBreakdown } from "../../domains/observability/index.js";
import type { ContextUsageBreakdown } from "../../domains/session/context-accounting.js";
import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
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
	labeledChip,
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
	sendPolicy: string | null;
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
}

/** Dynamic agent work: the live action quadrant. */
export interface AgentWorkFacts {
	statusText: string | null;
	dispatchSummary: string | null;
	toolTally: string;
	dispatchRows: ReadonlyArray<DispatchBoardRow>;
	/** Metrics for the most recent completed turn, surfaced when the agent is idle. */
	lastTurn: TurnSummary | null;
}

/** Responsive bands for the expanded footer. */
export const EXPANDED_WIDE = 80;
export const EXPANDED_MID = 70;
export const EXPANDED_ULTRAWIDE = 100;

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
	if (!snapshot) return "no tools · 0✗";
	const entries = Object.entries(snapshot.tools)
		.filter(([name, count]) => count > 0 && name.toLowerCase() !== "dispatch")
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 4)
		.map(([name, count]) => `${name} ${formatFooterTokens(count)}`);
	const prefix = entries.length > 0 ? entries.join(" · ") : "no tools";
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
	const left = buildSegmentedContextBar(theme, barCells, context.contextWindow ?? 0, contextBreakdownForBar(context));
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

function quadrantBlock(
	theme: ClioTheme,
	token: ClioToken,
	label: string,
	rows: ReadonlyArray<string | null>,
): string[] {
	const body = rows.filter((row): row is string => typeof row === "string" && row.length > 0);
	return [sectionTag(theme, token, label.toUpperCase(), 0), ...body];
}

export function workspaceQuadrant(facts: WorkspaceFacts): string[] {
	const theme = clioTheme();
	const remote = collapseRemote(facts.remote);
	return quadrantBlock(theme, "info", "Workspace", [
		labeledChip(theme, "cwd", facts.cwd, "muted"),
		gitChip(theme, facts.branch, facts.dirty) ?? theme.fg("dim", "git none"),
		facts.projectType ? labeledChip(theme, "type", facts.projectType, "muted") : null,
		remote ? labeledChip(theme, "remote", remote, "muted") : null,
	]);
}

export function sessionQuadrant(facts: SessionFacts): string[] {
	const theme = clioTheme();
	const title = facts.name ?? facts.id ?? "no session";
	return quadrantBlock(theme, "accent", "Session", [
		theme.fg("accent", title),
		theme.fg("dim", `v${facts.version}`),
		facts.target ? labeledChip(theme, "target", facts.target, "accent") : null,
		facts.thinking ? labeledChip(theme, "think", facts.thinking, "reason") : null,
		facts.capabilities && facts.capabilities.length > 0
			? labeledChip(theme, "caps", facts.capabilities.join(","), "muted")
			: null,
		facts.safety ? labeledChip(theme, "safety", facts.safety, "accentDeep") : null,
		facts.sendPolicy ? labeledChip(theme, "policy", facts.sendPolicy, "muted") : null,
		facts.toolProfile ? labeledChip(theme, "profile", facts.toolProfile, "muted") : null,
		facts.turns !== null ? labeledChip(theme, "turns", String(facts.turns), "muted") : null,
		facts.tokens ? labeledChip(theme, "tok", facts.tokens.replace(/^tok\s+/, ""), "muted") : null,
		facts.throughput ? labeledChip(theme, "speed", facts.throughput, "success") : null,
		facts.throughputDetail ? theme.fg("muted", facts.throughputDetail) : null,
		facts.cost ? labeledChip(theme, "cost", facts.cost.replace(/^cost\s+/, ""), "muted") : null,
	]);
}

export function contextQuadrant(facts: ContextEngineFacts): string[] {
	const theme = clioTheme();
	const used =
		facts.used !== null && facts.contextWindow
			? `${formatFooterTokens(facts.used)}/${formatFooterTokens(facts.contextWindow)}`
			: null;
	const schema =
		facts.toolSchemaTokens !== null && facts.toolSchemaTokens > 0
			? labeledChip(theme, "schemas", formatFooterTokens(facts.toolSchemaTokens), "muted")
			: null;
	const compaction =
		facts.compactionThreshold !== null
			? `${facts.compactionActive ? "compacting" : "compact"} ${facts.compactionAuto ? "auto" : "manual"} @${Math.round(facts.compactionThreshold * 100)}%`
			: null;
	const filledChar = visibleWidth(GLYPH.contextFull) === 1 ? GLYPH.contextFull : GLYPH.barFull;
	const legend = `${theme.fg("info", `${filledChar} sys`)} ${theme.fg("warning", `${filledChar} tools`)} ${theme.fg("accent", `${filledChar} chat`)}`;
	return quadrantBlock(theme, "reason", "Context", [
		facts.label ? theme.fg("info", facts.label) : theme.fg("dim", "ctx idle"),
		used ? labeledChip(theme, "used", used, "muted") : null,
		schema,
		compaction ? theme.fg("muted", compaction) : null,
		joinChips(theme, [
			facts.clioMd ? theme.fg("muted", facts.clioMd) : null,
			facts.memory ? theme.fg("muted", facts.memory) : null,
		]) || null,
		facts.extensions && facts.extensions.installed > 0
			? labeledChip(theme, "ext", `${facts.extensions.active}/${facts.extensions.installed}`, "muted")
			: null,
		legend,
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

export function agentQuadrant(facts: AgentWorkFacts, options: { maxWorkers?: number } = {}): string[] {
	const theme = clioTheme();
	const maxWorkers = Math.max(0, options.maxWorkers ?? 3);
	const activity = facts.statusText
		? theme.fg("accent", `${GLYPH.running} ${facts.statusText}`)
		: facts.lastTurn
			? formatLastTurn(theme, facts.lastTurn)
			: theme.fg("muted", "idle");
	const rows: Array<string | null> = [
		activity,
		facts.dispatchSummary ? theme.fg("warning", facts.dispatchSummary) : theme.fg("dim", "no workers"),
	];
	for (const row of facts.dispatchRows.slice(0, maxWorkers)) rows.push(workerLine(theme, row));
	rows.push(theme.fg("muted", `tools ${facts.toolTally}`));
	return quadrantBlock(theme, "success", "Agent", rows);
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
