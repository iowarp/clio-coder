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
import type { UsageSnapshot } from "../domains/quota/types.js";
import {
	foldPromptCacheTelemetry,
	hasPromptCacheTelemetry,
	type PromptCacheTelemetry,
	type SessionEntry,
} from "../domains/session/index.js";
import { type Component, matchesKey, type OverlayHandle, type TUI, wrapTextWithAnsi } from "../engine/tui.js";
import type { DispatchBoardRow } from "./dispatch-board.js";
import { buildResponsiveHint, showClioOverlayFrame } from "./overlay-frame.js";
import { quotaMeter, renderQuotaAccounts, renderWorkerUsage } from "./quota-view.js";
import { clioTheme, rule } from "./theme/index.js";

const DEFAULT_CONTENT_WIDTH = 104;

export const USAGE_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

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
	/** Calls in this row that were `/btw` side questions rather than turns. */
	sideQuestions: number;
	/** Calls in this row that were `/handoff` extraction rounds rather than turns. */
	handoffs: number;
	/** Calls in this row that were session pre-warms rather than turns. */
	prewarms: number;
	/** Calls in this row that were proactive-memory steps on the background target. */
	backgroundMemory: number;
	failedCompaction: number;
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
			if (entry.label === "side-question") existing.row.sideQuestions += 1;
			if (entry.label === "handoff") existing.row.handoffs += 1;
			if (entry.label === "prewarm") existing.row.prewarms += 1;
			if (entry.label === "background-memory") existing.row.backgroundMemory += 1;
			if (entry.label === "failed-compaction") existing.row.failedCompaction += 1;
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
				sideQuestions: entry.label === "side-question" ? 1 : 0,
				handoffs: entry.label === "handoff" ? 1 : 0,
				prewarms: entry.label === "prewarm" ? 1 : 0,
				backgroundMemory: entry.label === "background-memory" ? 1 : 0,
				failedCompaction: entry.label === "failed-compaction" ? 1 : 0,
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
			sideQuestions: acc.sideQuestions + row.sideQuestions,
			handoffs: acc.handoffs + row.handoffs,
			prewarms: acc.prewarms + row.prewarms,
			backgroundMemory: acc.backgroundMemory + row.backgroundMemory,
			failedCompaction: acc.failedCompaction + row.failedCompaction,
		}),
		{
			runs: 0,
			tokens: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoningTokens: 0,
			apiCalls: 0,
			sideQuestions: 0,
			handoffs: 0,
			prewarms: 0,
			backgroundMemory: 0,
			failedCompaction: 0,
		},
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

function summaryBlock(
	totalCost: CostAggregate,
	totalTokens: number,
	rows: ReadonlyArray<CostRow>,
	promptCache: PromptCacheTelemetry | null,
): string[] {
	const totals = sumRows(rows);
	const resolvedTotal = totalTokens > 0 ? totalTokens : totals.tokens;
	// No priced call, no cost row: neither the `cost $0.00` the overlay used to
	// print above its own "no token usage recorded" line, nor the `cost cost
	// unknown` it printed for a target that reports no pricing. The token rows
	// below are measured and stay either way. See formatCostAggregate.
	const cost = formatCostAggregate(totalCost);
	// A side question is billed like anything else and is counted here, but it is
	// deliberately not a turn: it never entered the session, so `turns` above
	// excludes it and this row says how much of the spend sat beside the session.
	const cacheRows =
		promptCache !== null && hasPromptCacheTelemetry(promptCache)
			? [
					[
						"uncached prefill",
						promptCache.uncachedPrefillTokens === null ? "not reported" : formatTokens(promptCache.uncachedPrefillTokens),
					] as const,
					[
						"cache verdicts",
						`hot ${promptCache.verdictCounts.hot} · partial ${promptCache.verdictCounts.partial} · cold ${promptCache.verdictCounts.cold} · small ${promptCache.verdictCounts.small} · unknown ${promptCache.verdictCounts.unknown}`,
					] as const,
				]
			: [];
	return kvBlock([
		[
			"turns",
			formatTokens(
				totals.runs -
					totals.sideQuestions -
					totals.handoffs -
					totals.prewarms -
					totals.backgroundMemory -
					totals.failedCompaction,
			),
		],
		["model calls", formatTokens(totals.apiCalls)],
		...(totals.sideQuestions > 0 ? [["side questions", formatTokens(totals.sideQuestions)] as const] : []),
		...(totals.handoffs > 0 ? [["handoffs", formatTokens(totals.handoffs)] as const] : []),
		...(totals.prewarms > 0 ? [["pre-warms", formatTokens(totals.prewarms)] as const] : []),
		...(totals.backgroundMemory > 0 ? [["memory steps", formatTokens(totals.backgroundMemory)] as const] : []),
		...(totals.failedCompaction > 0
			? [
					["failed compaction calls", formatTokens(totals.failedCompaction)] as const,
					["compaction usage", "known subtotals; missing usage is unknown"] as const,
				]
			: []),
		...(cost === null ? [] : [["cost", cost] as const]),
		["input", formatTokens(totals.input)],
		["output", formatTokens(totals.output)],
		["reasoning", ...reasoningValue(totals.reasoningTokens)],
		["cache read", ...cacheReadValue(totals.cacheRead, totals.apiCalls)],
		["cache write", formatTokens(totals.cacheWrite)],
		...cacheRows,
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
		[
			"turns",
			formatTokens(
				row.runs - row.sideQuestions - row.handoffs - row.prewarms - row.backgroundMemory - row.failedCompaction,
			),
		],
		["model calls", formatTokens(row.apiCalls)],
		...(row.sideQuestions > 0 ? [["side questions", formatTokens(row.sideQuestions)] as const] : []),
		...(row.handoffs > 0 ? [["handoffs", formatTokens(row.handoffs)] as const] : []),
		...(row.prewarms > 0 ? [["pre-warms", formatTokens(row.prewarms)] as const] : []),
		...(row.backgroundMemory > 0 ? [["memory steps", formatTokens(row.backgroundMemory)] as const] : []),
		...(row.failedCompaction > 0 ? [["failed compaction calls", formatTokens(row.failedCompaction)] as const] : []),
		...(cost === null ? [] : [["cost", cost] as const]),
		["input", formatTokens(row.input)],
		["output", formatTokens(row.output)],
		["reasoning", ...reasoningValue(row.reasoningTokens)],
		["cache read", ...cacheReadValue(row.cacheRead, row.apiCalls)],
		["cache write", formatTokens(row.cacheWrite)],
		["processed", `${formatTokens(row.tokens)} tokens`],
	]);
}

function modelDetailLines(rows: ReadonlyArray<CostRow>, contentWidth: number): string[] {
	const theme = clioTheme();
	const lines: string[] = [rule(theme, contentWidth)];
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
	promptCache: PromptCacheTelemetry | null;
}

// Session totals come from the observability projection: when a snapshot is
// supplied (the subscribe path holds the latest one), the running USD total is
// read from `snapshot.session.costUsd`. The per-provider/model rows still fold
// `costEntries()`, which the snapshot schema deliberately does not carry.
function buildCostSnapshot(
	observability: ObservabilityContract,
	sessionId: string | null,
	snapshot?: ObservabilitySnapshot,
	getSessionEntries?: () => ReadonlyArray<SessionEntry>,
): CostSnapshot {
	const entries = observability.costEntries();
	const rows = aggregateCostEntries(entries);
	const totalTokens = rows.reduce((sum, r) => sum + r.tokens, 0);
	return {
		sessionId,
		totalCost: snapshot?.session.cost ?? observability.sessionCostSummary(),
		totalTokens,
		rows,
		promptCache: getSessionEntries ? foldPromptCacheTelemetry(getSessionEntries()) : null,
	};
}

export interface OpenUsageOverlayOptions {
	getDispatchRows?: () => ReadonlyArray<DispatchBoardRow>;
	getQuotaSnapshots?: () => ReadonlyArray<UsageSnapshot>;
	sessionId?: string | null;
	/** Session ledger, read on every render so newly settled and branched calls appear. */
	getSessionEntries?: () => ReadonlyArray<SessionEntry>;
}

const USAGE_TABS = ["Accounts", "Session", "Models", "Workers"] as const;

class UsageOverlayBody implements Component {
	private tab = 0;
	private offsets = [0, 0, 0, 0];
	private height = 20;
	private pageHeight = 16;
	private lineCount = 0;

	constructor(
		private readonly getSnapshot: () => CostSnapshot,
		private readonly getQuotaSnapshots: () => ReadonlyArray<UsageSnapshot>,
		private readonly getDispatchRows: () => ReadonlyArray<DispatchBoardRow>,
		private readonly requestRender: () => void,
	) {}

	setHeight(rows: number): void {
		this.height = Math.max(1, rows - 3);
	}

	handleInput(data: string): void {
		const selected = (["1", "2", "3", "4"] as const).findIndex((key) => matchesKey(data, key));
		if (selected >= 0) this.tab = selected;
		else if (matchesKey(data, "tab") || matchesKey(data, "right")) this.tab = (this.tab + 1) % USAGE_TABS.length;
		else if (matchesKey(data, "shift+tab") || matchesKey(data, "left"))
			this.tab = (this.tab + USAGE_TABS.length - 1) % USAGE_TABS.length;
		else {
			let offset = this.offsets[this.tab] ?? 0;
			if (matchesKey(data, "up")) offset--;
			else if (matchesKey(data, "down")) offset++;
			else if (matchesKey(data, "pageUp")) offset -= this.pageHeight;
			else if (matchesKey(data, "pageDown")) offset += this.pageHeight;
			else if (matchesKey(data, "home") || matchesKey(data, "ctrl+home")) offset = 0;
			else if (matchesKey(data, "end") || matchesKey(data, "ctrl+end")) offset = this.lineCount;
			else return;
			this.offsets[this.tab] = Math.max(0, Math.min(offset, this.lineCount - this.pageHeight));
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, Math.floor(width));
		const snapshot = this.getSnapshot();
		const quota = this.getQuotaSnapshots();
		const theme = clioTheme();
		const tabs = wrapTextWithAnsi(
			USAGE_TABS.map((name, index) =>
				index === this.tab
					? theme.style("accent", `${index + 1} ${name}`, { bold: true, underline: true })
					: theme.fg("dim", `${index + 1} ${name}`),
			).join("   "),
			contentWidth,
		);
		let body: string[];
		if (this.tab === 0)
			body = [
				theme.fg("dim", "Account-wide limits · filled = used · shared across sessions and devices"),
				"",
				...renderQuotaAccounts(quota, contentWidth),
			];
		else if (this.tab === 1)
			body = [
				theme.style("accent", "Session tokens & cost", { bold: true }),
				theme.fg("dim", "Recorded calls in this session · estimates are marked in the cost totals"),
				"",
				...summaryBlock(snapshot.totalCost, snapshot.totalTokens, snapshot.rows, snapshot.promptCache),
				"",
				rule(theme, contentWidth),
				theme.fg("dim", "Session tokens cannot be converted to subscription percentages."),
				...(snapshot.rows.length ? [] : ["no token usage recorded for this session"]),
			];
		else if (this.tab === 2) {
			body = [
				theme.style("accent", "Model activity · this session", { bold: true }),
				theme.fg("dim", "Share of recorded processed tokens, including cache traffic; not account quota."),
				"",
			];
			for (const row of [...snapshot.rows].sort((a, b) => b.tokens - a.tokens)) {
				const share = snapshot.totalTokens > 0 ? (row.tokens / snapshot.totalTokens) * 100 : 0;
				body.push(
					`${row.providerId} · ${row.attributedModelId}`,
					`${quotaMeter(share, Math.min(24, contentWidth), "normal")} ${share.toFixed(1)}% · ${formatTokens(row.tokens)} tokens`,
				);
			}
			body.push("", ...modelDetailLines(snapshot.rows, contentWidth));
		} else body = renderWorkerUsage(this.getDispatchRows(), quota, contentWidth);
		const lines = body.flatMap((line) => wrapTextWithAnsi(line, contentWidth));
		this.lineCount = lines.length;
		this.pageHeight = Math.max(1, this.height - tabs.length - 1);
		const offset = Math.max(0, Math.min(this.offsets[this.tab] ?? 0, lines.length - this.pageHeight));
		this.offsets[this.tab] = offset;
		const visible = [...tabs, "", ...lines.slice(offset, offset + this.pageHeight)];
		if (lines.length > this.pageHeight)
			visible.push(theme.fg("dim", `${offset + 1}–${Math.min(lines.length, offset + this.pageHeight)} / ${lines.length}`));
		return visible;
	}

	invalidate(): void {}
}

/**
 * Mount the read-only usage overlay. Quota comes from the shared presentation feed. The running USD total comes from the
 * observability projection's `snapshot().session.costUsd`, while the
 * per-provider/model rows fold `observability.costEntries()`. The overlay is
 * kept live by `observability.subscribe()`: the projection already folds the
 * dispatch terminal channels and every `recordTokens()` into one coalesced
 * update, so a single subscription replaces the former DispatchCompleted /
 * DispatchFailed / chat-turn refresh wiring. `hide()` unsubscribes.
 */
export function openUsageOverlay(
	tui: TUI,
	observability: ObservabilityContract,
	options?: OpenUsageOverlayOptions,
): OverlayHandle {
	const sessionId = options?.sessionId ?? null;
	let latest: ObservabilitySnapshot = observability.snapshot();
	const body = new UsageOverlayBody(
		() => buildCostSnapshot(observability, sessionId, latest, options?.getSessionEntries),
		options?.getQuotaSnapshots ?? (() => []),
		options?.getDispatchRows ?? (() => []),
		() => tui.requestRender(),
	);
	const handle = showClioOverlayFrame(tui, body, {
		anchor: "center",
		width: USAGE_OVERLAY_WIDTH,
		// Not derived from the title: that one carries the session id.
		markerId: "usage",
		title: sessionId && sessionId.length > 0 ? `Usage (${sessionId})` : "Usage",
		footerHint: buildResponsiveHint([
			{ key: "1–4 / Tab", verb: "view", critical: true },
			{ key: "↑↓", verb: "scroll" },
			{ key: "PgUp/PgDn", verb: "page" },
		]),
		visible: (_width, height) => {
			body.setHeight(height);
			return true;
		},
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
