import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import type { DispatchBoardRow, DispatchBoardStatus } from "../dispatch-board.js";
import { fitFooterText, formatFooterTokens } from "../footer-panel.js";
import { type ClioTheme, type ClioToken, clioTheme, GLYPH, rule } from "../theme/index.js";

export interface ToolTallySnapshot {
	tools: Readonly<Record<string, number>>;
	errors: number;
}

export interface LoopClusterInput {
	mode: string;
	cwd: string;
	branch: string | null;
	targetLabel: string;
	thinkingLabel: string;
	context: string | null;
	tokens: string | null;
	statusText: string | null;
	toolTally: string;
}

function stylePhase(theme: ClioTheme, token: ClioToken, label: string): string {
	return theme.style(token, label.padEnd(8), { bold: true });
}

function joinColumns(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return fitFooterText(`${left}${" ".repeat(gap)}${right}`, width);
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

export function identityLine(input: {
	width: number;
	mode: string;
	branch: string | null;
	targetLabel: string;
	thinkingLabel: string;
	context: string | null;
	version: string;
}): string {
	const theme = clioTheme();
	const branch = input.branch ? ` ${theme.fg("success", input.branch)}` : "";
	const left = `${theme.fg("accent", `${GLYPH.agent} clio`)} · ${input.mode} · v${input.version}${branch}`;
	const rightParts = [input.targetLabel, `think ${input.thinkingLabel}`, input.context].filter(
		(part): part is string => typeof part === "string" && part.length > 0,
	);
	return joinColumns(left, theme.fg("muted", rightParts.join(" · ")), input.width);
}

export function loopCluster(input: LoopClusterInput, width: number): string[] {
	const theme = clioTheme();
	const headerLeft = `${theme.style("title", `${GLYPH.agent} CLIO CODER STATUS`, { bold: true })}`;
	const headerRight = input.mode;
	const branch = input.branch ? `git ${input.branch}` : "git unknown";
	const status = input.statusText ?? "idle";
	return [
		joinColumns(headerLeft, theme.fg("muted", headerRight), width),
		fitFooterText(`${stylePhase(theme, "accent", "PERCEIVE")} ${input.cwd} · ${branch}`, width),
		joinColumns(
			`${stylePhase(theme, "reason", "REASON")} ${input.targetLabel} · think ${input.thinkingLabel}`,
			input.context ?? "",
			width,
		),
		fitFooterText(`${stylePhase(theme, "success", "ACT")} ${status}`, width),
		joinColumns(`${stylePhase(theme, "loop", "REMEMBER")} ${input.tokens ?? "tokens idle"}`, input.toolTally, width),
	];
}

function statusGlyph(status: DispatchBoardStatus): string {
	if (status === "running" || status === "stale" || status === "enqueued") return GLYPH.running;
	if (status === "completed") return GLYPH.ok;
	if (status === "aborted") return GLYPH.cancelled;
	return GLYPH.error;
}

function formatElapsed(value: number): string {
	const ms = Math.max(0, Math.round(value));
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	return seconds < 60
		? `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`
		: `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

function formatUsd(value: number): string {
	return value > 0 ? `$${value.toFixed(2)}` : "$0";
}

export function dispatchRows(rows: ReadonlyArray<DispatchBoardRow>, width: number, maxRows = 4): string[] {
	const theme = clioTheme();
	return rows.slice(0, Math.max(0, maxRows)).map((row) => {
		const glyph = statusGlyph(row.status);
		const statusToken: ClioToken =
			row.status === "completed"
				? "success"
				: row.status === "running" || row.status === "enqueued"
					? "accent"
					: row.status === "stale"
						? "warning"
						: "error";
		const left = `${theme.fg(statusToken, glyph)} ${row.agentId}`;
		const target = `${row.endpointId}/${row.wireModelId}`;
		const right = `${row.status} ${formatElapsed(row.elapsedMs)} ${formatFooterTokens(row.tokenCount)} ${formatUsd(row.costUsd)}`;
		return joinColumns(`${left} ${theme.fg("muted", target)}`, theme.fg("muted", right), width);
	});
}

export function dispatchSeparator(width: number): string {
	return rule(clioTheme(), width, { left: "dispatch" });
}

export function fitDashboardLine(line: string, width: number): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line;
}
