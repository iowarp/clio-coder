import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import type { DispatchBoardRow, DispatchBoardStatus } from "../dispatch-board.js";
import { fitFooterText, formatFooterTokens } from "../footer-panel.js";
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
}

/** Live workspace facts. Owned by the footer (the welcome header no longer repeats the branch). */
export interface WorkspaceFacts {
	cwd: string;
	branch: string | null;
	dirty: boolean | null;
	projectType: string | null;
	remote: string | null;
}

/** Session identity + resource totals. */
export interface SessionFacts {
	name: string | null;
	id: string | null;
	mode: string;
	version: string;
	turns: number | null;
	tokens: string | null;
	cost: string | null;
}

/** Context engine telemetry. */
export interface ContextEngineFacts {
	label: string | null;
	used: number | null;
	contextWindow: number | null;
	compactionThreshold: number | null;
	compactionAuto: boolean | null;
	clioMd: string | null;
	memory: string | null;
	extensions: { active: number; installed: number } | null;
}

/** Dynamic agent work: the live action quadrant. */
export interface AgentWorkFacts {
	statusText: string | null;
	dispatchSummary: string | null;
	toolTally: string;
	dispatchRows: ReadonlyArray<DispatchBoardRow>;
}

/** Expanded-footer responsive bands. */
export const EXPANDED_WIDE = 120;
export const EXPANDED_MID = 80;

/** Compact footer shows the git section only when there is room for it. */
const COMPACT_GIT_MIN_WIDTH = 72;

function joinColumns(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return fitFooterText(`${left}${" ".repeat(gap)}${right}`, width);
}

export function fitDashboardLine(line: string, width: number): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line;
}

/** Pad/truncate an already-styled string to an exact column width. */
function cell(text: string, width: number): string {
	const safe = Math.max(0, width);
	const clipped = truncateToWidth(text, safe, "", true);
	return `${clipped}${" ".repeat(Math.max(0, safe - visibleWidth(clipped)))}`;
}

export function formatToolTally(snapshot: ToolTallySnapshot | null | undefined): string {
	if (!snapshot) return "no tools · 0✗";
	const entries = Object.entries(snapshot.tools)
		.filter(([name, count]) => count > 0 && name.toLowerCase() !== "dispatch")
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 4)
		.map(([name, count]) => `${name} ${formatFooterTokens(count)}`);
	const prefix = entries.length > 0 ? entries.join(" · ") : "no tools";
	return `${prefix} · ${formatFooterTokens(snapshot.errors)}${GLYPH.error}`;
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
 * right. Carries no model/mode/thinking — the editor rail owns those — and the
 * branch appears here (and only here) across the whole screen.
 */
export function compactPrimaryLine(workspace: WorkspaceFacts, session: SessionFacts, width: number): string {
	const theme = clioTheme();
	const cwd = theme.fg("muted", workspace.cwd);
	const git = width >= COMPACT_GIT_MIN_WIDTH ? gitChip(theme, workspace.branch, workspace.dirty) : null;
	const left = joinSections(theme, [cwd, git]);
	const right = joinChips(theme, [
		session.tokens ? theme.fg("muted", session.tokens) : null,
		session.cost ? theme.fg("muted", session.cost) : null,
	]);
	return joinColumns(left, right || theme.fg("dim", "tokens idle"), width);
}

/**
 * Compact secondary row: context fill + the single most important activity on
 * the left, dispatch summary + tool tally on the right.
 */
export function compactSecondaryLine(context: ContextEngineFacts, agent: AgentWorkFacts, width: number): string {
	const theme = clioTheme();
	const activity = agent.statusText
		? theme.fg("accent", `${GLYPH.running} ${agent.statusText}`)
		: theme.fg("muted", "run idle");
	const left = joinChips(theme, [context.label ? theme.fg("info", context.label) : null, activity]);
	const right = joinChips(theme, [
		agent.dispatchSummary ? theme.fg("accent", agent.dispatchSummary) : null,
		theme.fg("muted", `tools ${agent.toolTally}`),
	]);
	return joinColumns(left || theme.fg("muted", "run idle"), right, width);
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
		`${labeledChip(theme, "mode", facts.mode, "muted")} ${theme.fg("dim", `v${facts.version}`)}`,
		facts.turns !== null ? labeledChip(theme, "turns", String(facts.turns), "muted") : null,
		facts.tokens ? labeledChip(theme, "tok", facts.tokens.replace(/^tok\s+/, ""), "muted") : null,
		facts.cost ? labeledChip(theme, "cost", facts.cost.replace(/^cost\s+/, ""), "muted") : null,
	]);
}

export function contextQuadrant(facts: ContextEngineFacts): string[] {
	const theme = clioTheme();
	const used =
		facts.used !== null && facts.contextWindow
			? `${formatFooterTokens(facts.used)}/${formatFooterTokens(facts.contextWindow)}`
			: null;
	const compaction =
		facts.compactionThreshold !== null
			? `compact ${facts.compactionAuto ? "auto" : "manual"} @${Math.round(facts.compactionThreshold * 100)}%`
			: null;
	return quadrantBlock(theme, "reason", "Context", [
		facts.label ? theme.fg("info", facts.label) : theme.fg("dim", "ctx idle"),
		used ? labeledChip(theme, "used", used, "muted") : null,
		compaction ? theme.fg("muted", compaction) : null,
		joinChips(theme, [
			facts.clioMd ? theme.fg("muted", facts.clioMd) : null,
			facts.memory ? theme.fg("muted", facts.memory) : null,
		]) || null,
		facts.extensions && facts.extensions.installed > 0
			? labeledChip(theme, "ext", `${facts.extensions.active}/${facts.extensions.installed}`, "muted")
			: null,
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

export function workerLine(theme: ClioTheme, row: DispatchBoardRow): string {
	const glyph = theme.fg(statusToken(row.status), statusGlyph(row.status));
	return `${glyph} ${theme.fg("muted", row.agentId)} ${theme.fg("dim", `${row.status} ${formatElapsed(row.elapsedMs)}`)}`;
}

export function agentQuadrant(facts: AgentWorkFacts, options: { maxWorkers?: number } = {}): string[] {
	const theme = clioTheme();
	const maxWorkers = Math.max(0, options.maxWorkers ?? 3);
	const activity = facts.statusText
		? theme.fg("accent", `${GLYPH.running} ${facts.statusText}`)
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
