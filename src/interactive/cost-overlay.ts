import {
	addResponseModelIdObservationCounts,
	type ResponseModelIdObservationCounts,
	responseModelIdObservationCountsLabel,
} from "../core/response-model-id.js";
import {
	aggregateCostAmounts,
	type CostAggregate,
	type CostEntry,
	formatCostAggregate,
	type ObservabilityContract,
	type ObservabilitySnapshot,
} from "../domains/observability/index.js";
import type { Component, OverlayHandle, TUI } from "../engine/tui.js";
import { buildHint, showClioOverlayFrame } from "./overlay-frame.js";
import { clioTheme, rule } from "./theme/index.js";

const DEFAULT_CONTENT_WIDTH = 80;

export const COST_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

export interface CostRow {
	providerId: string;
	attributedModelId: string;
	requestedModelIds: string[];
	responseModelIdObservationCounts: ResponseModelIdObservationCounts;
	runs: number;
	tokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoningTokens: number;
	apiCalls: number;
	cost: CostAggregate;
}

function formatTokens(n: number): string {
	return n.toLocaleString("en-US");
}

export function aggregateCostEntries(entries: ReadonlyArray<CostEntry>): CostRow[] {
	const grouped = new Map<
		string,
		{
			row: Omit<CostRow, "cost" | "requestedModelIds" | "responseModelIdObservationCounts">;
			requestedModelIds: Set<string>;
			responseModelIdObservationCounts: ResponseModelIdObservationCounts;
			entries: CostEntry[];
		}
	>();
	for (const entry of entries) {
		const key = `${entry.providerId}::${entry.attributedModelId}`;
		const existing = grouped.get(key);
		if (existing) {
			existing.row.runs += 1;
			existing.row.tokens += entry.tokens;
			existing.row.input += entry.input;
			existing.row.output += entry.output;
			existing.row.cacheRead += entry.cacheRead;
			existing.row.cacheWrite += entry.cacheWrite;
			existing.row.reasoningTokens += entry.reasoningTokens;
			existing.row.apiCalls += entry.apiCalls ?? 1;
			for (const requestedModelId of entry.requestedModelIds) existing.requestedModelIds.add(requestedModelId);
			addResponseModelIdObservationCounts(
				existing.responseModelIdObservationCounts,
				entry.responseModelIdObservationCounts,
			);
			existing.entries.push(entry);
			continue;
		}
		grouped.set(key, {
			row: {
				providerId: entry.providerId,
				attributedModelId: entry.attributedModelId,
				runs: 1,
				tokens: entry.tokens,
				input: entry.input,
				output: entry.output,
				cacheRead: entry.cacheRead,
				cacheWrite: entry.cacheWrite,
				reasoningTokens: entry.reasoningTokens,
				apiCalls: entry.apiCalls ?? 1,
			},
			requestedModelIds: new Set(entry.requestedModelIds),
			responseModelIdObservationCounts: { ...entry.responseModelIdObservationCounts },
			entries: [entry],
		});
	}
	const rows = Array.from(grouped.values(), ({ row, entries, requestedModelIds, responseModelIdObservationCounts }) => ({
		...row,
		requestedModelIds: [...requestedModelIds].sort(),
		responseModelIdObservationCounts,
		cost: aggregateCostAmounts(entries.map((entry) => ({ usd: entry.usd, provenance: entry.provenance }))),
	}));
	rows.sort((a, b) => {
		if (a.providerId !== b.providerId) return a.providerId < b.providerId ? -1 : 1;
		if (a.attributedModelId !== b.attributedModelId) return a.attributedModelId < b.attributedModelId ? -1 : 1;
		return 0;
	});
	return rows;
}

function sumRows(
	rows: ReadonlyArray<CostRow>,
): Omit<
	CostRow,
	"providerId" | "attributedModelId" | "requestedModelIds" | "responseModelIdObservationCounts" | "cost"
> {
	return rows.reduce(
		(acc, row) => ({
			runs: acc.runs + row.runs,
			tokens: acc.tokens + row.tokens,
			input: acc.input + row.input,
			output: acc.output + row.output,
			cacheRead: acc.cacheRead + row.cacheRead,
			cacheWrite: acc.cacheWrite + row.cacheWrite,
			reasoningTokens: acc.reasoningTokens + row.reasoningTokens,
			apiCalls: acc.apiCalls + row.apiCalls,
		}),
		{ runs: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, apiCalls: 0 },
	);
}

// Cache read splits into a primary value and an optional per-request average
// annotation, so the number joins the aligned column while the aside hangs
// after it.
function cacheReadValue(cacheRead: number, apiCalls: number): readonly [value: string, annotation?: string] {
	if (apiCalls > 1 && cacheRead > 0) {
		return [formatTokens(cacheRead), `(avg/call ${formatTokens(Math.round(cacheRead / apiCalls))})`];
	}
	return [formatTokens(cacheRead)];
}

/**
 * This tally sums what providers reported and never estimates, while the chat
 * panel falls back to estimating from the reasoning text a turn displayed. On a
 * model that reports nothing the two disagree by construction, so the row says
 * which of the two it is rather than leaving a footer reading `r≈900` beside an
 * overlay reading `reasoning 0`.
 */
function reasoningValue(reasoningTokens: number): readonly [value: string, annotation?: string] {
	return [formatTokens(reasoningTokens), "provider-reported only"];
}

// A block of key-value rows in the design-system grammar: a dim padded key and
// a muted value. Primary values are right-aligned inside the block so the
// numbers line up under one another; an optional annotation renders dim after
// its value and stays outside the alignment math, so a long aside never drags
// the whole column right.
function kvBlock(entries: ReadonlyArray<readonly [string, string, string?]>): string[] {
	const theme = clioTheme();
	const keyWidth = entries.reduce((max, [key]) => Math.max(max, key.length), 0);
	const valueWidth = entries.reduce((max, [, value]) => Math.max(max, value.length), 0);
	return entries.map(([key, value, annotation]) => {
		const row = `${theme.fg("dim", key.padEnd(keyWidth))}  ${theme.fg("muted", value.padStart(valueWidth))}`;
		return annotation ? `${row} ${theme.fg("dim", annotation)}` : row;
	});
}

function summaryBlock(totalCost: CostAggregate, totalTokens: number, rows: ReadonlyArray<CostRow>): string[] {
	const totals = sumRows(rows);
	const resolvedTotal = totalTokens > 0 ? totalTokens : totals.tokens;
	// No priced call, no cost row: neither the `cost $0.00` the overlay used to
	// print above its own "no token usage recorded" line, nor the `cost cost
	// unknown` it printed for a target that reports no pricing. The token rows
	// below are measured and stay either way. See formatCostAggregate.
	const cost = formatCostAggregate(totalCost);
	return kvBlock([
		["turns", formatTokens(totals.runs)],
		["model calls", formatTokens(totals.apiCalls)],
		...(cost === null ? [] : [["cost", cost] as const]),
		["input", formatTokens(totals.input)],
		["output", formatTokens(totals.output)],
		["reasoning", ...reasoningValue(totals.reasoningTokens)],
		["cache read", ...cacheReadValue(totals.cacheRead, totals.apiCalls)],
		["cache write", formatTokens(totals.cacheWrite)],
		["processed", `${formatTokens(resolvedTotal)} tokens`],
	]);
}

function modelBlock(row: CostRow): string[] {
	// A row exists because calls were folded into it, so its tokens are measured.
	// Its cost is a separate question: a target that reports no pricing leaves the
	// block with token rows and no cost row.
	const cost = formatCostAggregate(row.cost);
	return kvBlock([
		["requested model ids", row.requestedModelIds.join(", ")],
		["response model id observation", responseModelIdObservationCountsLabel(row.responseModelIdObservationCounts)],
		["turns", formatTokens(row.runs)],
		["model calls", formatTokens(row.apiCalls)],
		...(cost === null ? [] : [["cost", cost] as const]),
		["input", formatTokens(row.input)],
		["output", formatTokens(row.output)],
		["reasoning", ...reasoningValue(row.reasoningTokens)],
		["cache read", ...cacheReadValue(row.cacheRead, row.apiCalls)],
		["cache write", formatTokens(row.cacheWrite)],
		["processed", `${formatTokens(row.tokens)} tokens`],
	]);
}

export function formatCostOverlayBodyLines(
	totalCost: CostAggregate,
	totalTokens: number,
	rows: ReadonlyArray<CostRow>,
	contentWidth: number,
): string[] {
	const theme = clioTheme();
	const lines: string[] = [];
	for (const line of summaryBlock(totalCost, totalTokens, rows)) {
		lines.push(line);
	}
	lines.push(rule(theme, contentWidth));
	if (rows.length === 0) {
		lines.push(theme.fg("muted", "no token usage recorded for this session"));
	} else {
		for (const [index, row] of rows.entries()) {
			if (index > 0) lines.push("");
			lines.push(theme.style("accent", `${row.providerId} · attributed model ${row.attributedModelId}`, { bold: true }));
			for (const line of modelBlock(row)) {
				lines.push(line);
			}
		}
	}
	return lines;
}

export interface CostSnapshot {
	sessionId: string | null;
	totalCost: CostAggregate;
	totalTokens: number;
	rows: CostRow[];
}

// Session totals come from the observability projection: when a snapshot is
// supplied (the subscribe path holds the latest one), the running USD total is
// read from `snapshot.session.costUsd`. The per-provider/model rows still fold
// `costEntries()`, which the snapshot schema deliberately does not carry.
function buildCostSnapshot(
	observability: ObservabilityContract,
	sessionId: string | null,
	snapshot?: ObservabilitySnapshot,
): CostSnapshot {
	const entries = observability.costEntries();
	const rows = aggregateCostEntries(entries);
	const totalTokens = rows.reduce((sum, r) => sum + r.tokens, 0);
	return {
		sessionId,
		totalCost: snapshot?.session.cost ?? observability.sessionCostSummary(),
		totalTokens,
		rows,
	};
}

export interface OpenCostOverlayOptions {
	sessionId?: string | null;
}

class CostOverlayBody implements Component {
	constructor(private readonly getSnapshot: () => CostSnapshot) {}

	render(width: number): string[] {
		const contentWidth = Math.max(1, Math.floor(width));
		const snapshot = this.getSnapshot();
		return formatCostOverlayBodyLines(snapshot.totalCost, snapshot.totalTokens, snapshot.rows, contentWidth);
	}

	invalidate(): void {}
}

/**
 * Mount a read-only session-cost overlay. The running USD total comes from the
 * observability projection's `snapshot().session.costUsd`, while the
 * per-provider/model rows fold `observability.costEntries()`. The overlay is
 * kept live by `observability.subscribe()`: the projection already folds the
 * dispatch terminal channels and every `recordTokens()` into one coalesced
 * update, so a single subscription replaces the former DispatchCompleted /
 * DispatchFailed / chat-turn refresh wiring. `hide()` unsubscribes.
 */
export function openCostOverlay(
	tui: TUI,
	observability: ObservabilityContract,
	options?: OpenCostOverlayOptions,
): OverlayHandle {
	const sessionId = options?.sessionId ?? null;
	let latest: ObservabilitySnapshot = observability.snapshot();
	const body = new CostOverlayBody(() => buildCostSnapshot(observability, sessionId, latest));
	const handle = showClioOverlayFrame(tui, body, {
		anchor: "center",
		width: COST_OVERLAY_WIDTH,
		title: sessionId && sessionId.length > 0 ? `Session usage (${sessionId})` : "Session usage",
		footerHint: buildHint([]),
	});

	// subscribe() fires immediately with the current snapshot, then on each
	// coalesced projection change while the overlay is open.
	const unsubscribe = observability.subscribe((snapshot) => {
		latest = snapshot;
		body.invalidate();
		tui.requestRender();
	});

	return {
		...handle,
		hide(): void {
			unsubscribe();
			handle.hide();
		},
	};
}
