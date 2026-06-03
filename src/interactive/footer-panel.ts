import type { TokenThroughputSnapshot, UsageBreakdown } from "../domains/observability/index.js";
import type { ContextUsageSnapshot } from "../domains/session/context-accounting.js";
import { type Text, truncateToWidth, visibleWidth } from "../engine/tui.js";
import type { DispatchBoardRow, DispatchBoardStatus } from "./dispatch-board.js";

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
