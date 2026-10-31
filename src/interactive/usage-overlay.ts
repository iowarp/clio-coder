import type { FactMetric, Quantity } from "../core/telemetry/dto.js";
import { factRef } from "../core/telemetry/dto.js";
import type { AgentRole } from "../core/telemetry/enums.js";
import { factKnownValue } from "../core/telemetry/known.js";
import { renderCoverage } from "../core/telemetry/render.js";
import { createQuotaSummaryFeed } from "../domains/quota/summary-feed.js";
import type { RecallTelemetry, SessionEntry } from "../domains/session/index.js";
import { foldRecallTelemetry, formatRecallTelemetry, hasRecallTelemetry } from "../domains/session/index.js";
import type { GitChanges } from "../domains/session/workspace/git-probe.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import type { TelemetryContract } from "../domains/telemetry/index.js";
import type { Component, OverlayHandle, TUI } from "../engine/tui.js";
import { matchesKey, wrapTextWithAnsi } from "../engine/tui.js";
import { ACTIVITY_SPAN_DAYS, bucketActivity, renderActivityHeatmap } from "./activity-view.js";
import type { DispatchBoardRow } from "./dispatch-board.js";
import { buildResponsiveHint, showClioOverlayFrame } from "./overlay-frame.js";
import type { QuotaProviders } from "./quota-view.js";
import { quotaMeter, renderQuotaAccounts, renderWorkerUsage } from "./quota-view.js";
import { clioTheme, formatCompactMs, padAnsi, rule } from "./theme/index.js";

const DEFAULT_CONTENT_WIDTH = 104;

export const USAGE_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

/** What each agent role's count reads as; a role added later still shows, under its own name. */
const ROLE_CAPTION: Readonly<Record<AgentRole, string>> = {
	main: "conversation calls",
	coordinator: "coordinator calls",
	worker: "worker calls",
	compaction: "compaction calls",
	memory: "memory steps",
	"system-one": "System One calls",
	prewarm: "pre-warms",
	btw: "side questions",
	handoff: "handoffs",
	helper: "helper calls",
	"safety-judge": "safety judge calls",
};
const NOT_AVAILABLE = "spend not available: this session has no telemetry read model";

/** Any contribution at all: a count of zero calls, or a sum over nothing, hides its row. */
function nonZero(quantity: Quantity | null | undefined): quantity is Quantity {
	if (!quantity) return false;
	const fact = quantity.fact;
	return "kind" in fact
		? fact.kind === "unknown" || fact.kind === "estimated" || (fact.kind === "measured" && fact.value > 0)
		: fact.unknownCount > 0 || factKnownValue(fact) > 0;
}

function hasUnknown(quantity: Quantity): boolean {
	return "kind" in quantity.fact ? quantity.fact.kind === "unknown" : quantity.fact.unknownCount > 0;
}

/** Some call fed this sum, so its value (a measured zero, a local `$0.00`, or `not measured`) is worth a row. */
function contributed(quantity: Quantity): boolean {
	const fact = quantity.fact;
	return "kind" in fact
		? fact.kind !== "absent"
		: fact.coverage.measured + fact.coverage.estimated + fact.unknownCount > 0;
}

/**
 * This tally sums what providers reported and never estimates, while the chat
 * panel falls back to estimating from the reasoning text a turn displayed. On a
 * model that reports nothing the two disagree by construction, so the row says
 * which of the two it is rather than leaving a footer reading `r≈900` beside an
 * overlay reading `reasoning 0`.
 */
const REASONING_NOTE = "provider-reported only";

// A block of key-value rows in the design-system grammar: a dim padded key and
// a muted value. Primary values are right-aligned inside the block so the
// Numbers line up under one another; an optional annotation uses supporting ink after
// its value and stays outside the alignment math, so a long aside never drags
// the whole column right.
function kvBlock(entries: ReadonlyArray<readonly [string, string, string?]>): string[] {
	const theme = clioTheme();
	const keyWidth = entries.reduce((max, [key]) => Math.max(max, key.length), 0);
	const valueWidth = entries.reduce((max, [, value]) => Math.max(max, value.length), 0);
	return entries.map(([key, value, annotation]) => {
		const row = `${theme.fg("fieldName", key.padEnd(keyWidth))}  ${theme.fg("counter", value.padStart(valueWidth))}`;
		return annotation ? `${row} ${theme.fg("annotation", annotation)}` : row;
	});
}

const BARE_COUNT = /^~?\d[\d,]*$/;

/**
 * A token display with its unit. The unit follows a bare count ("5,120 tokens"); a display that carries its own gap
 * clause ("≥5,120 (1 call unknown)") takes it as a label, since a unit after the clause misreads (#434).
 */
function tokensText(display: string): string {
	return BARE_COUNT.test(display) ? `${display} tokens` : `tokens: ${display}`;
}

/** Whole-session token rows, optionally for one model group; every value is the read model's own display. */
function tokenRows(view: TelemetryView, model?: string): Array<readonly [string, string, string?]> {
	const display = (metric: FactMetric) =>
		view.quantity(
			factRef({
				scope: "session",
				owner: view.sessionId,
				metric,
				...(model === undefined ? {} : { group: { by: "model", key: model } }),
			}),
		)?.display ?? "unknown";
	return [
		["input", display("input")],
		["output", display("output")],
		["reasoning", display("reasoning"), REASONING_NOTE],
		["cache read", display("cacheRead")],
		["cache write", display("cacheWrite")],
		["processed", tokensText(display("total"))],
	];
}

/**
 * The Session tab: every call this session paid for, across every branch, as the telemetry read model folds it
 * (#434 §11.3). Nothing here adds or subtracts; an unknown cache read reads `unknown`, never `0`.
 */
function summaryBlock(view: TelemetryView, recall: RecallTelemetry | null): string[] {
	const session = view.session();
	const byRole = view.cost("role");
	const cache = view.cache();
	const tokenCoverage = session.totals.tokens;
	const neverSent = session.own.counts.dispositions.neverSent;
	const groups = [...byRole.groups].sort((a, b) =>
		a.key === "main" ? -1 : b.key === "main" ? 1 : a.key.localeCompare(b.key),
	);
	// A measured zero read is a cache that served nothing, which the rows say; only a session no call fed hides them.
	const cached = contributed(cache.cacheRead) || contributed(cache.cacheWrite) || contributed(cache.rePrefilled);
	const v = cache.verdicts;
	return kvBlock([
		...groups.map(
			(group) => [ROLE_CAPTION[group.key as AgentRole] ?? `${group.key} calls`, group.calls.display] as const,
		),
		["model calls", byRole.total.calls.display],
		["harness overhead", session.overhead.share.display],
		...(hasUnknown(tokenCoverage) ? [["token coverage", renderCoverage(tokenCoverage.fact)] as const] : []),
		...(nonZero(neverSent) ? [["never sent", `${neverSent.display} calls`] as const] : []),
		...(contributed(byRole.total.usd) ? [["cost", byRole.total.usd.display] as const] : []),
		...tokenRows(view),
		...(cached
			? [
					["uncached prefill", cache.uncachedPrefill.display] as const,
					["re-prefilled", cache.rePrefilled.display, `${cache.breaks.length} breaks`] as const,
					["cache-break bill", cache.breakUsd.display] as const,
					[
						"cache verdicts",
						`hot ${v.hot} · partial ${v.partial} · cold ${v.cold} · small ${v.small} · unknown ${v.unknown}`,
					] as const,
				]
			: []),
		// #422: a recalled body is written to the cache once and read on every later
		// request, the same as if it had never left; the tokens here are what the
		// model asked back, not the recall requests' own prefix reads.
		...(recall !== null && hasRecallTelemetry(recall)
			? [["recalled into context", formatRecallTelemetry(recall), "estimate · excludes operator recalls"] as const]
			: []),
	]);
}

/** The Models tab: one block per `target/model`, the reported model where the provider named one. */
function modelLines(view: TelemetryView, contentWidth: number): string[] {
	const theme = clioTheme();
	const groups = view.cost("model").groups;
	if (groups.length === 0) return [theme.fg("menuDescription", "no model calls recorded for this session")];
	const lines: string[] = [];
	for (const [index, group] of groups.entries()) {
		if (index > 0) lines.push("");
		lines.push(theme.style("modelIdentity", group.key, { bold: true }));
		lines.push(
			...kvBlock([
				["model calls", group.calls.display],
				...(contributed(group.usd) ? [["cost", group.usd.display] as const] : []),
				...tokenRows(view, group.key),
			]),
		);
	}
	return [rule(theme, contentWidth), ...lines];
}

/** What the overlay reads: the live view, and the ledger's recall fold, re-read on updates rather than per frame. */
interface UsageData {
	view: TelemetryView | null;
	recall: RecallTelemetry | null;
}

export interface OpenUsageOverlayOptions {
	getDispatchRows?: () => ReadonlyArray<DispatchBoardRow>;
	sessionId?: string | null;
	/** Session ledger, read on every render so newly settled and branched calls appear. */
	getSessionEntries?: () => ReadonlyArray<SessionEntry>;
	/** Sessions of this workspace, for the activity graph. Read once on open. */
	listSessions?: () => ReadonlyArray<{ createdAt?: string; lastActivityAt?: string; messageCount?: number }>;
	/** Working-tree changes; null until the probe lands or when there is no repository. */
	getChanges?: () => GitChanges | null;
	/** ISO instant this session began, for the elapsed time. */
	sessionStartedAt?: string | null;
	now?: () => number;
}

/**
 * The glance tab: the activity graph, then the four facts an operator asks for
 * before any table. Every row is `label  value` on one column so the eye reads
 * down the labels, the way the Copilot usage card does.
 */
function renderActivity(
	days: ReadonlyMap<string, number>,
	sessions: number,
	data: UsageData,
	quota: QuotaProviders,
	changes: GitChanges | null,
	startedAt: string | null,
	now: number,
	contentWidth: number,
): string[] {
	const theme = clioTheme();
	const label = (text: string): string => padAnsi(theme.fg("fieldName", text), 12);
	const lines = [
		...renderActivityHeatmap(
			days,
			now,
			contentWidth,
			`last ${ACTIVITY_SPAN_DAYS} days · ${sessions} session${sessions === 1 ? "" : "s"} in this workspace`,
		),
		"",
	];
	const changesValue =
		changes === null
			? theme.fg("annotation", "not observed")
			: `${theme.fg("success", `+${changes.insertions}`)} ${theme.fg("error", `-${changes.deletions}`)} ${theme.fg("annotation", `· ${changes.files} file${changes.files === 1 ? "" : "s"}`)}`;
	lines.push(`${label("Changes")}${changesValue}`);
	const started = startedAt ? Date.parse(startedAt) : Number.NaN;
	const elapsed = Number.isFinite(started)
		? ` ${theme.fg("annotation", `(${formatCompactMs(Math.max(0, now - started))})`)}`
		: "";
	const view = data.view;
	if (!view) lines.push(`${label("Session")}${theme.fg("annotation", NOT_AVAILABLE)}${elapsed}`);
	else {
		const totals = view.session().totals;
		const cost = contributed(totals.usd) ? `${totals.usd.display} · ` : "";
		lines.push(`${label("Session")}${cost}${theme.fg("counter", tokensText(totals.tokens.display))}${elapsed}`);
		const tokenCoverage = hasUnknown(totals.tokens) ? renderCoverage(totals.tokens.fact) : null;
		const neverSent = view.session().own.counts.dispositions.neverSent;
		const usage = [tokenCoverage, nonZero(neverSent) ? `${neverSent.display} never sent` : null].filter(
			(part) => part !== null,
		);
		if (usage.length > 0) lines.push(`${label("Usage")}${theme.fg("annotation", usage.join(" · "))}`);
	}
	const window = quota.flatMap((entry) => entry.windows.map((item) => ({ entry, item })))[0];
	if (window) {
		const pct = Math.max(0, Math.min(100, factKnownValue(window.item.usedPct.fact)));
		lines.push(
			`${label("Plan")}${quotaMeter(pct, Math.min(28, Math.max(8, contentWidth - 30)))} ${window.item.usedPct.display} used ${theme.fg("annotation", `· ${window.entry.provider} ${window.item.label}`)}`,
		);
	} else lines.push(`${label("Plan")}${theme.fg("annotation", "no subscription window reported")}`);
	return lines;
}

const USAGE_TABS = ["Activity", "Accounts", "Session", "Models", "Workers"] as const;

class UsageOverlayBody implements Component {
	private tab = 0;
	private offsets = [0, 0, 0, 0, 0];
	private height = 20;
	private pageHeight = 16;
	private lineCount = 0;

	constructor(
		private readonly getData: () => UsageData,
		private readonly getQuotaSnapshots: () => QuotaProviders,
		private readonly getDispatchRows: () => ReadonlyArray<DispatchBoardRow>,
		private readonly requestRender: () => void,
		private readonly activity: {
			days: ReadonlyMap<string, number>;
			sessions: number;
			getChanges: () => GitChanges | null;
			startedAt: string | null;
			now: () => number;
		},
	) {}

	setHeight(rows: number): void {
		// The dock reports its own viewport: body rows plus the two rails.
		this.height = Math.max(1, rows - 2);
	}

	handleInput(data: string): void {
		const selected = (["1", "2", "3", "4", "5"] as const).findIndex((key) => matchesKey(data, key));
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
		const data = this.getData();
		const quota = this.getQuotaSnapshots();
		const theme = clioTheme();
		const tabs = wrapTextWithAnsi(
			USAGE_TABS.map((name, index) =>
				index === this.tab
					? theme.style("selectedOption", `${index + 1} ${name}`, { bold: true, underline: true })
					: theme.fg("menuOption", `${index + 1} ${name}`),
			).join("   "),
			contentWidth,
		);
		let body: string[];
		if (this.tab === 0)
			body = renderActivity(
				this.activity.days,
				this.activity.sessions,
				data,
				quota,
				this.activity.getChanges(),
				this.activity.startedAt,
				this.activity.now(),
				contentWidth,
			);
		else if (this.tab === 1)
			body = [
				theme.fg("annotation", "Account-wide limits · filled = used · shared across sessions and devices"),
				"",
				...renderQuotaAccounts(quota, contentWidth),
			];
		else if (this.tab === 2)
			body = [
				theme.style("sectionHeading", "Session tokens & cost", { bold: true }),
				theme.fg("annotation", "Every call this session paid for, across every branch · estimates and gaps are marked"),
				"",
				...(data.view ? summaryBlock(data.view, data.recall) : [theme.fg("annotation", NOT_AVAILABLE)]),
				"",
				rule(theme, contentWidth),
				theme.fg("annotation", "Session tokens cannot be converted to subscription percentages."),
				...(data.view && !nonZero(data.view.cost("role").total.calls) ? ["no calls recorded for this session"] : []),
			];
		else if (this.tab === 3) {
			body = [
				theme.style("sectionHeading", "Model activity · this session", { bold: true }),
				theme.fg("annotation", "Recorded calls per model across every branch, including cache traffic; not account quota."),
				"",
				...(data.view ? modelLines(data.view, contentWidth) : [theme.fg("annotation", NOT_AVAILABLE)]),
			];
		} else body = renderWorkerUsage(this.getDispatchRows(), quota, contentWidth);
		const lines = body.flatMap((line) => wrapTextWithAnsi(line, contentWidth));
		this.lineCount = lines.length;
		// One row stays free for the `n–m / N` indicator a scrolled page carries.
		this.pageHeight = Math.max(1, this.height - tabs.length - 1);
		const offset = Math.max(0, Math.min(this.offsets[this.tab] ?? 0, lines.length - this.pageHeight));
		this.offsets[this.tab] = offset;
		const visible = [...tabs, ...lines.slice(offset, offset + this.pageHeight)];
		if (lines.length > this.pageHeight)
			visible.push(
				theme.fg("annotation", `${offset + 1}–${Math.min(lines.length, offset + this.pageHeight)} / ${lines.length}`),
			);
		return visible;
	}

	invalidate(): void {}
}

/**
 * Mount the read-only usage overlay. Quota comes from the shared presentation feed; spend and tokens come from the
 * telemetry read model's live session view (#434). `hide()` unsubscribes.
 */
export function openUsageOverlay(
	tui: TUI,
	telemetry: TelemetryContract,
	options?: OpenUsageOverlayOptions,
): OverlayHandle {
	const sessionId = options?.sessionId ?? null;
	const readModel = telemetry.read;
	const quotaFeed = createQuotaSummaryFeed({ onUpdate: () => tui.requestRender() });
	const readRecall = () => (options?.getSessionEntries ? foldRecallTelemetry(options.getSessionEntries()) : null);
	let recall = readRecall();
	const now = options?.now ?? (() => Date.now());
	const sessions = options?.listSessions?.() ?? [];
	const body = new UsageOverlayBody(
		() => ({ view: readModel?.live() ?? null, recall }),
		() => {
			quotaFeed.peekSnapshots();
			return readModel?.quota().providers ?? [];
		},
		options?.getDispatchRows ?? (() => []),
		() => tui.requestRender(),
		{
			days: bucketActivity(
				sessions.map((meta) => ({ at: meta.lastActivityAt ?? meta.createdAt, weight: meta.messageCount ?? 1 })),
				now(),
			),
			sessions: sessions.length,
			getChanges: options?.getChanges ?? (() => null),
			startedAt: options?.sessionStartedAt ?? null,
			now,
		},
	);
	const handle = showClioOverlayFrame(tui, body, {
		anchor: "center",
		width: USAGE_OVERLAY_WIDTH,
		// Not derived from the title: that one carries the session id.
		markerId: "usage",
		title: sessionId && sessionId.length > 0 ? `Usage (${sessionId})` : "Usage",
		footerHint: buildResponsiveHint([
			{ key: "1–5 / Tab", verb: "view", critical: true },
			{ key: "↑↓", verb: "scroll" },
			{ key: "PgUp/PgDn", verb: "page" },
		]),
		visible: (_width, height) => {
			body.setHeight(height);
			return true;
		},
	});

	// The Workers tab reads the dispatch board, which the projection keeps current.
	const unsubscribe = telemetry.subscribe(() => tui.requestRender());
	// Spend changes arrive as persisted batches, at most 10 Hz; the ledger's recall fold is re-read then, not per frame.
	const refresh = () => {
		recall = readRecall();
		tui.requestRender();
	};
	const offs = readModel
		? (["session", "calls", "cost", "cache", "runs", "quota"] as const).map((topic) =>
				readModel.subscribe(topic, refresh),
			)
		: [];

	return {
		...handle,
		hide(): void {
			quotaFeed.dispose();
			unsubscribe();
			for (const off of offs) off();
			handle.hide();
		},
	};
}
