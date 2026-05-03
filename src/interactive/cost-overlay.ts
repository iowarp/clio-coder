import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { CostEntry, ObservabilityContract } from "../domains/observability/index.js";
import { type OverlayHandle, Text, type TUI, truncateToWidth } from "../engine/tui.js";

const DEFAULT_CONTENT_WIDTH = 80;
const TITLE_PREFIX = "─ Session usage";
const HINT = "[Esc] close";
const ANSI_RESET = "\u001b[0m";

export const COST_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

export interface CostRow {
	providerId: string;
	modelId: string;
	runs: number;
	tokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoningTokens: number;
	usd: number;
}

function padContent(text: string, contentWidth: number): string {
	return `│ ${truncateToWidth(text, contentWidth, "...", true).replaceAll(ANSI_RESET, "")} │`;
}

function topBorder(contentWidth: number, sessionId: string | null): string {
	const innerWidth = contentWidth + 2;
	const label = sessionId && sessionId.length > 0 ? `${TITLE_PREFIX} (${sessionId}) ` : `${TITLE_PREFIX} `;
	if (innerWidth <= label.length) {
		const truncated = truncateToWidth(label, innerWidth, "...", true);
		return `┌${truncated.padEnd(innerWidth, "─")}┐`;
	}
	return `┌${label.padEnd(innerWidth, "─")}┐`;
}

function bottomBorder(contentWidth: number): string {
	return `└${"─".repeat(contentWidth + 2)}┘`;
}

function dividerRow(contentWidth: number): string {
	return padContent("─".repeat(contentWidth), contentWidth);
}

function formatTokens(n: number): string {
	return n.toLocaleString("en-US");
}

function formatUsd(n: number): string {
	return `$${n.toFixed(2)}`;
}

function formatUsdCell(usd: number): string {
	return usd === 0 ? `${formatUsd(0)} local` : formatUsd(usd);
}

export function aggregateCostEntries(entries: ReadonlyArray<CostEntry>): CostRow[] {
	const map = new Map<string, CostRow>();
	for (const entry of entries) {
		const key = `${entry.providerId}::${entry.modelId}`;
		const existing = map.get(key);
		if (existing) {
			existing.runs += 1;
			existing.tokens += entry.tokens;
			existing.input += entry.input;
			existing.output += entry.output;
			existing.cacheRead += entry.cacheRead;
			existing.cacheWrite += entry.cacheWrite;
			existing.reasoningTokens += entry.reasoningTokens;
			existing.usd += entry.usd;
			continue;
		}
		map.set(key, {
			providerId: entry.providerId,
			modelId: entry.modelId,
			runs: 1,
			tokens: entry.tokens,
			input: entry.input,
			output: entry.output,
			cacheRead: entry.cacheRead,
			cacheWrite: entry.cacheWrite,
			reasoningTokens: entry.reasoningTokens,
			usd: entry.usd,
		});
	}
	const rows = Array.from(map.values());
	rows.sort((a, b) => {
		if (a.providerId !== b.providerId) return a.providerId < b.providerId ? -1 : 1;
		if (a.modelId !== b.modelId) return a.modelId < b.modelId ? -1 : 1;
		return 0;
	});
	return rows;
}

function sumRows(rows: ReadonlyArray<CostRow>): Omit<CostRow, "providerId" | "modelId" | "runs" | "usd"> {
	return rows.reduce(
		(acc, row) => ({
			tokens: acc.tokens + row.tokens,
			input: acc.input + row.input,
			output: acc.output + row.output,
			cacheRead: acc.cacheRead + row.cacheRead,
			cacheWrite: acc.cacheWrite + row.cacheWrite,
			reasoningTokens: acc.reasoningTokens + row.reasoningTokens,
		}),
		{ tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
	);
}

function formatSummaryLines(totalUsd: number, totalTokens: number, rows: ReadonlyArray<CostRow>): string[] {
	const totals = sumRows(rows);
	const resolvedTotal = totalTokens > 0 ? totalTokens : totals.tokens;
	return [
		`total ${formatTokens(resolvedTotal)} tokens  cost ${formatUsdCell(totalUsd)}`,
		`input ${formatTokens(totals.input)}  cache read ${formatTokens(totals.cacheRead)}  cache write ${formatTokens(totals.cacheWrite)}`,
		`output ${formatTokens(totals.output)}  reasoning ${formatTokens(totals.reasoningTokens)}`,
	];
}

function formatRowLines(row: CostRow): string[] {
	return [
		`${row.providerId} · ${row.modelId}`,
		`  runs ${formatTokens(row.runs)}  total ${formatTokens(row.tokens)}  cost ${formatUsdCell(row.usd)}`,
		`  input ${formatTokens(row.input)}  cache read ${formatTokens(row.cacheRead)}  cache write ${formatTokens(row.cacheWrite)}`,
		`  output ${formatTokens(row.output)}  reasoning ${formatTokens(row.reasoningTokens)}`,
	];
}

export interface FormatCostOverlayOptions {
	sessionId?: string | null;
	contentWidth?: number;
}

export function formatCostOverlayLines(
	totalUsd: number,
	totalTokens: number,
	rows: ReadonlyArray<CostRow>,
	options?: FormatCostOverlayOptions,
): string[] {
	const contentWidth = Math.max(1, options?.contentWidth ?? DEFAULT_CONTENT_WIDTH);
	const lines: string[] = [topBorder(contentWidth, options?.sessionId ?? null)];
	for (const line of formatSummaryLines(totalUsd, totalTokens, rows)) {
		lines.push(padContent(line, contentWidth));
	}
	lines.push(dividerRow(contentWidth));
	if (rows.length === 0) {
		lines.push(padContent("no token usage recorded for this session", contentWidth));
	} else {
		for (const [index, row] of rows.entries()) {
			if (index > 0) lines.push(padContent("", contentWidth));
			for (const line of formatRowLines(row)) {
				lines.push(padContent(line, contentWidth));
			}
		}
	}
	lines.push(padContent("", contentWidth));
	lines.push(padContent(HINT, contentWidth));
	lines.push(bottomBorder(contentWidth));
	return lines;
}

export interface CostSnapshot {
	sessionId: string | null;
	totalUsd: number;
	totalTokens: number;
	rows: CostRow[];
}

export function buildCostSnapshot(observability: ObservabilityContract, sessionId: string | null): CostSnapshot {
	const entries = observability.costEntries();
	const rows = aggregateCostEntries(entries);
	const totalTokens = rows.reduce((sum, r) => sum + r.tokens, 0);
	return {
		sessionId,
		totalUsd: observability.sessionCost(),
		totalTokens,
		rows,
	};
}

function snapshotLines(snapshot: CostSnapshot): string[] {
	return formatCostOverlayLines(snapshot.totalUsd, snapshot.totalTokens, snapshot.rows, {
		sessionId: snapshot.sessionId,
	});
}

export interface OpenCostOverlayOptions {
	bus?: SafeEventBus;
	sessionId?: string | null;
}

/**
 * Mount a read-only session-cost overlay. Reads observability.sessionCost() for
 * the running USD total and aggregates observability.costEntries() into a
 * per-provider/model row set. When a bus is supplied, DispatchCompleted events
 * re-render the overlay so the totals tick up as workers finish.
 */
export function openCostOverlay(
	tui: TUI,
	observability: ObservabilityContract,
	options?: OpenCostOverlayOptions,
): OverlayHandle {
	const sessionId = options?.sessionId ?? null;
	const initial = buildCostSnapshot(observability, sessionId);
	const text = new Text(snapshotLines(initial).join("\n"), 0, 0);
	const handle = tui.showOverlay(text, { anchor: "center", width: COST_OVERLAY_WIDTH });

	const refresh = (): void => {
		const snapshot = buildCostSnapshot(observability, sessionId);
		text.setText(snapshotLines(snapshot).join("\n"));
		text.invalidate();
		tui.requestRender();
	};

	const unsubscribes: Array<() => void> = [];
	if (options?.bus) {
		unsubscribes.push(options.bus.on(BusChannels.DispatchCompleted, refresh));
		unsubscribes.push(options.bus.on(BusChannels.DispatchFailed, refresh));
	}

	return {
		...handle,
		hide(): void {
			for (const off of unsubscribes) off();
			handle.hide();
		},
	};
}
