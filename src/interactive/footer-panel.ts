import type { TokenThroughputSnapshot, UsageBreakdown } from "../domains/observability/index.js";
import type { ContextUsageSnapshot } from "../domains/session/context-accounting.js";
import { type Text, truncateToWidth, visibleWidth } from "../engine/tui.js";
import type { DispatchBoardRow, DispatchBoardStatus } from "./dispatch-board.js";
import { type ClioTheme, GLYPH } from "./theme/index.js";

const ARROW_UP = "\u2191";
const ARROW_DOWN = "\u2193";
const SPEED_ICON = "\u26A1";

/**
 * Render a token count with a single-letter magnitude suffix so the footer
 * stays short on long-running sessions. Values under 1,000 render as the
 * raw integer; 1,000-999,999 render with a `k` suffix and one decimal when
 * that digit is non-zero; 1,000,000+ uses `M`.
 */
export function formatFooterTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	const value = Math.round(n);
	if (value < 1000) return value.toString();
	if (value < 1_000_000) {
		const scaled = value / 1000;
		const fixed = scaled.toFixed(1);
		return fixed.endsWith(".0") ? `${fixed.slice(0, -2)}k` : `${fixed}k`;
	}
	const scaled = value / 1_000_000;
	const fixed = scaled.toFixed(1);
	return fixed.endsWith(".0") ? `${fixed.slice(0, -2)}M` : `${fixed}M`;
}

/**
 * Build the token-counter footer segment. Returns `null` when no usage has
 * landed yet so the footer stays uncluttered at session start. Cache-read
 * tokens are omitted here to keep the line scannable; reasoning tokens are
 * shown only when the provider exposes them. The `/cost` overlay exposes the
 * full breakdown.
 */
export function tokensSegment(usage: UsageBreakdown | null | undefined): string | null {
	if (!usage) return null;
	const input = Math.max(0, usage.input ?? 0);
	const output = Math.max(0, usage.output ?? 0);
	const reasoning = Math.max(0, usage.reasoningTokens ?? 0);
	const total = Math.max(0, usage.totalTokens ?? input + output);
	if (input + output + reasoning + total === 0) return null;
	const reasoningPart = reasoning > 0 ? ` r${formatFooterTokens(reasoning)}` : "";
	const totalPart = total > 0 ? ` Σ${formatFooterTokens(total)}` : "";
	return `${ARROW_UP}${formatFooterTokens(input)} ${ARROW_DOWN}${formatFooterTokens(output)}${reasoningPart}${totalPart}`;
}

export function throughputSegment(metric: TokenThroughputSnapshot | null | undefined): string | null {
	const tps = metric?.tokensPerSecond;
	if (typeof tps !== "number" || !Number.isFinite(tps) || tps <= 0) return null;
	const rounded = tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10;
	return `${SPEED_ICON}${rounded} Tk/s`;
}

function formatDurationMs(ms: number): string {
	const safe = Math.max(0, Math.round(ms));
	if (safe < 1000) return `${safe}ms`;
	const seconds = safe / 1000;
	return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

export function throughputDetailSegment(metric: TokenThroughputSnapshot | null | undefined): string | null {
	if (!throughputSegment(metric) || !metric) return null;
	const parts = [`gen ${formatDurationMs(metric.durationMs)}`];
	if (typeof metric.ttftMs === "number" && Number.isFinite(metric.ttftMs))
		parts.push(`ttft ${formatDurationMs(metric.ttftMs)}`);
	parts.push(`↓${formatFooterTokens(metric.outputTokens)}`);
	return parts.join(" · ");
}

export function buildCtxBar(percent: number | null | undefined, width = 8): string {
	const cells = Math.max(1, Math.floor(width));
	if (typeof percent !== "number" || !Number.isFinite(percent)) return "░".repeat(cells);
	const filled = Math.max(0, Math.min(cells, Math.round((Math.max(0, Math.min(100, percent)) / 100) * cells)));
	return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
}

export function contextSegment(usage: ContextUsageSnapshot | null | undefined): string | null {
	if (!usage || usage.contextWindow <= 0) return null;
	const percent = usage.percent;
	const percentLabel = typeof percent === "number" && Number.isFinite(percent) ? `${Math.round(percent)}%` : "?%";
	return `ctx ${buildCtxBar(percent, 10)} ${percentLabel}`;
}

function dispatchStatusCounts(rows: ReadonlyArray<DispatchBoardRow>): {
	active: number;
	completed: number;
	failed: number;
	tokens: number;
} {
	const activeStatuses = new Set<DispatchBoardStatus>(["running", "stale", "enqueued"]);
	const failedStatuses = new Set<DispatchBoardStatus>(["failed", "aborted", "dead"]);
	let active = 0;
	let completed = 0;
	let failed = 0;
	let tokens = 0;
	for (const row of rows) {
		if (activeStatuses.has(row.status)) active += 1;
		else if (row.status === "completed") completed += 1;
		else if (failedStatuses.has(row.status)) failed += 1;
		tokens += Math.max(0, row.tokenCount);
	}
	return { active, completed, failed, tokens };
}

export function dispatchSegment(rows: ReadonlyArray<DispatchBoardRow> | null | undefined): string | null {
	if (!rows || rows.length === 0) return null;
	const counts = dispatchStatusCounts(rows);
	const parts: string[] = [];
	if (counts.active > 0) parts.push(`${counts.active} active`);
	if (counts.completed > 0) parts.push(`${counts.completed} done`);
	if (counts.failed > 0) parts.push(`${counts.failed} fail`);
	if (counts.tokens > 0) parts.push(`${formatFooterTokens(counts.tokens)}tok`);
	return `dispatch ${parts.length > 0 ? parts.join(" ") : `${rows.length} runs`}`;
}

export interface FooterPanel {
	view: Text;
	refresh(): void;
}

export function fitFooterText(text: string, width: number): string {
	const safeWidth = Math.max(1, Math.floor(width));
	return visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, "", true) : text;
}

const CONTEXT_PERCENT_FIELD_WIDTH = 6;
export const CONTEXT_BAR_LABEL_WIDTH = 2 + CONTEXT_PERCENT_FIELD_WIDTH;

type SegmentBreakdownInput = {
	systemPromptTokens: number;
	toolSchemaTokens: number;
	messageTokens: number;
	pendingUserTokens: number;
};

function finiteNonNegative(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function contextBarGlyphs(): { filled: string; free: string } {
	return {
		filled: visibleWidth(GLYPH.contextFull) === 1 ? GLYPH.contextFull : GLYPH.barFull,
		free: visibleWidth(GLYPH.contextFree) === 1 ? GLYPH.contextFree : GLYPH.barEmpty,
	};
}

function contextPercentLabel(percent: number | null): string {
	const text = percent === null ? "--%" : `${percent.toFixed(1)}%`;
	return `  ${text.padEnd(CONTEXT_PERCENT_FIELD_WIDTH, " ")}`;
}

function largestRemainderCells(values: readonly [number, number, number], filled: number): [number, number, number] {
	const total = values[0] + values[1] + values[2];
	if (filled <= 0 || total <= 0) return [0, 0, 0];
	const raw: [number, number, number] = [
		(values[0] / total) * filled,
		(values[1] / total) * filled,
		(values[2] / total) * filled,
	];
	const cells: [number, number, number] = [Math.floor(raw[0]), Math.floor(raw[1]), Math.floor(raw[2])];
	let remaining = filled - cells[0] - cells[1] - cells[2];
	const order = [0, 1, 2].sort((a, b) => {
		const rawA = raw[a] ?? 0;
		const rawB = raw[b] ?? 0;
		const diff = rawB - Math.floor(rawB) - (rawA - Math.floor(rawA));
		return Math.abs(diff) > 1e-9 ? diff : a - b;
	});
	for (const index of order) {
		if (remaining <= 0) break;
		if (index === 0) cells[0] += 1;
		else if (index === 1) cells[1] += 1;
		else cells[2] += 1;
		remaining -= 1;
	}
	return cells;
}

export function buildSegmentedContextBar(
	theme: ClioTheme,
	barWidth: number,
	contextWindow: number,
	breakdown: SegmentBreakdownInput | undefined,
): string {
	const cells = Math.max(0, Math.floor(Number.isFinite(barWidth) ? barWidth : 0));
	const glyphs = contextBarGlyphs();

	if (contextWindow <= 0 || !Number.isFinite(contextWindow) || !breakdown) {
		return `${theme.style("frame", glyphs.free.repeat(cells), { dim: true })}${contextPercentLabel(null)}`;
	}

	const system = finiteNonNegative(breakdown.systemPromptTokens);
	const tools = finiteNonNegative(breakdown.toolSchemaTokens);
	const conversation = finiteNonNegative(breakdown.messageTokens) + finiteNonNegative(breakdown.pendingUserTokens);
	const categoryTotal = system + tools + conversation;
	const used = Math.max(0, Math.min(categoryTotal, contextWindow));
	const percent = (used / contextWindow) * 100;
	let filled = Math.max(0, Math.min(cells, Math.round((used / contextWindow) * cells)));
	if (used > 0) filled = Math.max(1, filled);

	const scale = categoryTotal > 0 && used < categoryTotal ? used / categoryTotal : 1;
	const [systemCells, toolCells, conversationCells] = largestRemainderCells(
		[system * scale, tools * scale, conversation * scale],
		filled,
	);
	const freeCells = Math.max(0, cells - filled);
	const systemPart = systemCells > 0 ? theme.fg("info", glyphs.filled.repeat(systemCells)) : "";
	const toolPart = toolCells > 0 ? theme.fg("warning", glyphs.filled.repeat(toolCells)) : "";
	const conversationPart = conversationCells > 0 ? theme.fg("accent", glyphs.filled.repeat(conversationCells)) : "";
	const freePart = freeCells > 0 ? theme.style("frame", glyphs.free.repeat(freeCells), { dim: true }) : "";
	return `${systemPart}${toolPart}${conversationPart}${freePart}${contextPercentLabel(percent)}`;
}
