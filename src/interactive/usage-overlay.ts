import type { FactMetric, Quantity, RunTelemetryV1 } from "../core/telemetry/dto.js";
import { factRef } from "../core/telemetry/dto.js";
import type { AgentRole } from "../core/telemetry/enums.js";
import { factKnownValue } from "../core/telemetry/known.js";
import { createQuotaSummaryFeed } from "../domains/quota/summary-feed.js";
import type { RecallTelemetry, SessionEntry } from "../domains/session/index.js";
import { foldRecallTelemetry, formatRecallTelemetry, hasRecallTelemetry } from "../domains/session/index.js";
import type { GitChanges } from "../domains/session/workspace/git-probe.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import type { TelemetryContract } from "../domains/telemetry/index.js";
import type { Component, OverlayHandle, TUI } from "../engine/tui.js";
import { matchesKey, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { ACTIVITY_SPAN_DAYS, bucketActivity, renderActivityHeatmap } from "./activity-view.js";
import type { DispatchBoardRow } from "./dispatch-board.js";
import { buildResponsiveHint, showClioOverlayFrame } from "./overlay-frame.js";
import type { QuotaProviders, RecordedWorkerRun } from "./quota-view.js";
import { quotaMeter, renderQuotaAccounts, renderWorkerUsage } from "./quota-view.js";
import { clioTheme, formatCompactMs, padAnsi, positionRow, rule } from "./theme/index.js";
import {
	USAGE_NOT_MEASURED,
	usageCoverage,
	usageFigure,
	usageGap,
	usageLineNotes,
	usageSaysNothing,
	usageUnmeasured,
} from "./usage-words.js";

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
const NOT_STARTED = "nothing recorded yet: the session starts with its first prompt";

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

function kvBlock(entries: ReadonlyArray<readonly [string, string, string?]>, contentWidth: number): string[] {
	const theme = clioTheme();
	const keyWidth = entries.reduce((max, [key]) => Math.max(max, visibleWidth(key)), 0);
	const columnLimit = Math.min(12, Math.max(0, contentWidth - keyWidth - 2));
	const valueWidth = entries.reduce((max, [, value]) => {
		const width = visibleWidth(value);
		return width <= columnLimit ? Math.max(max, width) : max;
	}, 0);
	return entries.flatMap(([key, value, annotation]) => {
		const text = `${theme.fg("counter", value)}${annotation ? ` ${theme.fg("annotation", annotation)}` : ""}`;
		const textWidth = visibleWidth(text);
		const rowKeyWidth =
			visibleWidth(key) + 2 + textWidth <= contentWidth ? Math.min(keyWidth, contentWidth - textWidth - 2) : keyWidth;
		const prefix = `${theme.fg("fieldName", padAnsi(key, rowKeyWidth))}  `;
		const availableWidth = Math.max(1, contentWidth - rowKeyWidth - 2);
		const padding = Math.max(0, Math.min(valueWidth - visibleWidth(value), availableWidth - textWidth));
		return wrapTextWithAnsi(`${" ".repeat(padding)}${text}`, availableWidth).map(
			(line, index) => `${index === 0 ? prefix : " ".repeat(rowKeyWidth + 2)}${line}`,
		);
	});
}

const BARE_COUNT = /^[≥~]*\d[\d,]*$/u;

/**
 * A token display with its unit. The unit follows a bare count ("5,120 tokens"); a display that carries its own gap
 * clause ("≥5,120 (1 call unknown)") takes it as a label, since a unit after the clause misreads (#434).
 */
function tokensText(display: string): string {
	return BARE_COUNT.test(display) ? `${display} tokens` : `tokens: ${display}`;
}

/** Whole-session token rows, optionally for one model group; every value is the read model's own display. */
function tokenRows(view: TelemetryView, model?: string): Array<readonly [string, string, string?]> {
	// Each row is the figure alone; the coverage row above the table says once how many calls reported nothing (F4).
	const display = (metric: FactMetric) =>
		usageFigure(
			view.quantity(
				factRef({
					scope: "session",
					owner: view.sessionId,
					metric,
					...(model === undefined ? {} : { group: { by: "model", key: model } }),
				}),
			),
		);
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
 * What the session's token figures leave out, in the exit card's words. `1 of 2 calls had no usage data` counted a
 * missing cache-read figure as a call and a never-sent call as a second one, beside a receipt that measured the turn.
 */
function sessionUsageNotes(view: TelemetryView): string[] {
	const quantity = (metric: FactMetric) => view.quantity(factRef({ scope: "session", owner: view.sessionId, metric }));
	const { notes } = usageLineNotes([
		{ label: "in", quantity: quantity("input") },
		{ label: "out", quantity: quantity("output") },
		{ label: "cache read", quantity: quantity("cacheRead") },
		{ label: "cache write", quantity: quantity("cacheWrite") },
		{ label: "reasoning", quantity: quantity("reasoning") },
	]);
	return notes;
}

/**
 * The Session tab: every call this session paid for, across every branch, as the telemetry read model folds it
 * (#434 §11.3). Nothing here adds or subtracts; an unknown cache read reads `unknown`, never `0`.
 */
function summaryBlock(view: TelemetryView, recall: RecallTelemetry | null, contentWidth: number): string[] {
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
	return kvBlock(
		[
			...groups.map(
				(group) => [ROLE_CAPTION[group.key as AgentRole] ?? `${group.key} calls`, group.calls.display] as const,
			),
			["model calls", byRole.total.calls.display],
			["harness overhead", session.overhead.share.display],
			...(hasUnknown(tokenCoverage) && sessionUsageNotes(view).length > 0
				? [["usage data", sessionUsageNotes(view).join(" · ")] as const]
				: []),
			...(nonZero(neverSent)
				? [["never sent", `${neverSent.display} ${neverSent.display === "1" ? "call" : "calls"}`] as const]
				: []),
			...(contributed(byRole.total.usd) ? [["cost", byRole.total.usd.display] as const] : []),
			...tokenRows(view),
			...(cached
				? [
						["uncached prefill", usageFigure(cache.uncachedPrefill)] as const,
						["re-prefilled", usageFigure(cache.rePrefilled), `${cache.breaks.length} breaks`] as const,
						["cache-break bill", usageFigure(cache.breakUsd)] as const,
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
		],
		contentWidth,
	);
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
			...kvBlock(
				[
					["model calls", group.calls.display],
					...(contributed(group.usd) ? [["cost", group.usd.display] as const] : []),
					...tokenRows(view, group.key),
				],
				contentWidth,
			),
		);
	}
	return [rule(theme, contentWidth), ...lines];
}

/** What the overlay reads: the live view, and the ledger's recall fold, re-read on updates rather than per frame. */
interface UsageData {
	view: TelemetryView | null;
	/** Why `view` is null: no read model at all, or no session for it to read yet. */
	missing: string;
	recall: RecallTelemetry | null;
}

export interface OpenUsageOverlayOptions {
	getDispatchRows?: () => ReadonlyArray<DispatchBoardRow>;
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
 * The glance tab's Session row: how long the session has run, what is known, then what is not, said once. It used to
 * read `not measured · tokens: not measured (18s)`, which named the gap twice and left the elapsed time unexplained.
 * A total nothing measured, or only a lower bound of zero, is not a figure, so it joins the unknown clause with the
 * calls that had no usage data, in the words every usage surface uses.
 */
function sessionValue(view: TelemetryView, elapsed: string | null): string {
	const theme = clioTheme();
	const totals = view.session().totals;
	const tokenFigure = usageFigure(totals.tokens);
	const tokensKnown = !usageSaysNothing(tokenFigure);
	const costShown = contributed(totals.usd);
	const costKnown = costShown && !usageUnmeasured(totals.usd);
	const known = [costKnown ? totals.usd.display : null, tokensKnown ? tokensText(tokenFigure) : null].filter(
		(part) => part !== null,
	);
	const unknown = [tokensKnown ? null : "tokens", costShown && !costKnown ? "cost" : null].filter(
		(part) => part !== null,
	);
	const why = tokensKnown ? null : usageCoverage(usageGap(totals.tokens));
	const gap =
		unknown.length > 0 ? `${unknown.join(" and ")} ${USAGE_NOT_MEASURED}${why === null ? "" : ` (${why})`}` : null;
	return [
		...(elapsed === null ? [] : [theme.fg("annotation", elapsed)]),
		...known.map((part) => theme.fg("counter", part)),
		...(gap === null ? [] : [theme.fg("annotation", gap)]),
	].join(theme.fg("annotation", " · "));
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
	// A value that wraps continues under its own column, not under the label, so a narrow Session row still reads
	// as one row.
	const row = (name: string, value: string): string[] =>
		wrapTextWithAnsi(value, Math.max(1, contentWidth - 12)).map(
			(line, index) => `${index === 0 ? label(name) : " ".repeat(12)}${line}`,
		);
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
	lines.push(...row("Changes", changesValue));
	const started = startedAt ? Date.parse(startedAt) : Number.NaN;
	const elapsed = Number.isFinite(started) ? `${formatCompactMs(Math.max(0, now - started))} so far` : null;
	const view = data.view;
	if (!view)
		lines.push(
			...row("Session", theme.fg("annotation", [elapsed, data.missing].filter((part) => part !== null).join(" · "))),
		);
	else {
		lines.push(...row("Session", sessionValue(view, elapsed)));
		// A token total nothing measured already says why on the Session row, so its coverage is not said again here.
		const tokens = view.session().totals.tokens;
		const tokenCoverage = usageSaysNothing(usageFigure(tokens)) ? [] : sessionUsageNotes(view);
		const neverSent = view.session().own.counts.dispositions.neverSent;
		const usage = [
			...tokenCoverage,
			nonZero(neverSent) ? `${neverSent.display} ${neverSent.display === "1" ? "call" : "calls"} never sent` : null,
		].filter((part) => part !== null);
		if (usage.length > 0) lines.push(...row("Usage", theme.fg("annotation", usage.join(" · "))));
	}
	const window = quota.flatMap((entry) => entry.windows.map((item) => ({ entry, item })))[0];
	if (window) {
		const pct = Math.max(0, Math.min(100, factKnownValue(window.item.usedPct.fact)));
		lines.push(
			`${label("Plan")}${quotaMeter(pct, Math.min(28, Math.max(8, contentWidth - 30)))} ${window.item.usedPct.display} used ${theme.fg("annotation", `· ${window.entry.provider} ${window.item.label}`)}`,
		);
	} else lines.push(...row("Plan", theme.fg("annotation", "no subscription window reported")));
	return lines;
}

/**
 * The runs a session's telemetry references, newest first, read once per view. `view.run` reads and verifies the run's
 * scope files synchronously, so a settled run, whose rendered facts no later record changes, is read only once.
 */
function recordedRunReader(): (view: TelemetryView | null) => ReadonlyArray<RecordedWorkerRun> {
	const settled = new Map<string, RunTelemetryV1>();
	let latest: { view: TelemetryView; runs: RecordedWorkerRun[] } | null = null;
	return (view) => {
		if (!view) return [];
		if (latest?.view === view) return latest.runs;
		const rows = [...view.runs()].sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
		const runs = rows.flatMap((row) => {
			const run = settled.get(row.runId) ?? view.run(row.runId);
			if (!run) return [];
			if (run.settled) settled.set(row.runId, run);
			return [{ run, enqueued: run.settled ? null : view.runEnqueued(row.runId) }];
		});
		latest = { view, runs };
		return runs;
	};
}

const USAGE_TABS = ["Activity", "Accounts", "Session", "Models", "Workers"] as const;

class UsageOverlayBody implements Component {
	private tab = 0;
	private offsets = [0, 0, 0, 0, 0];
	private height = 20;
	private pageHeight = 16;
	private lineCount = 0;
	private readonly recordedRuns = recordedRunReader();

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

	/** Whether the open view has more than it shows, so the scroll keys move something. */
	overflows(): boolean {
		return this.lineCount > this.pageHeight;
	}

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
					? theme.style("selectedOption", `${index + 1}\u00a0${name}`, { bold: true, underline: true })
					: // A no-break space keeps a tab's number with its name when the row wraps (`5` above `Workers`).
						theme.fg("menuOption", `${index + 1}\u00a0${name}`),
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
				...(data.view ? summaryBlock(data.view, data.recall, contentWidth) : [theme.fg("annotation", data.missing)]),
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
				...(data.view ? modelLines(data.view, contentWidth) : [theme.fg("annotation", data.missing)]),
			];
		} else body = renderWorkerUsage(this.getDispatchRows(), this.recordedRuns(data.view), quota, contentWidth);
		const lines = body.flatMap((line) => wrapTextWithAnsi(line, contentWidth));
		this.lineCount = lines.length;
		// One row stays free for the `n–m / N` indicator a scrolled page carries.
		this.pageHeight = Math.max(1, this.height - tabs.length - 1);
		const offset = Math.max(0, Math.min(this.offsets[this.tab] ?? 0, lines.length - this.pageHeight));
		this.offsets[this.tab] = offset;
		const visible = [...tabs, ...lines.slice(offset, offset + this.pageHeight)];
		// The same position row every scrolling overlay draws; the keys that move it are on the rail, once.
		if (lines.length > this.pageHeight)
			visible.push(
				positionRow(
					theme,
					{ start: offset + 1, end: Math.min(lines.length, offset + this.pageHeight), total: lines.length },
					contentWidth,
				),
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
	const readModel = telemetry.read;
	const quotaFeed = createQuotaSummaryFeed({ onUpdate: () => tui.requestRender() });
	const readRecall = () => (options?.getSessionEntries ? foldRecallTelemetry(options.getSessionEntries()) : null);
	let recall = readRecall();
	const now = options?.now ?? (() => Date.now());
	const sessions = options?.listSessions?.() ?? [];
	const body = new UsageOverlayBody(
		() => ({ view: readModel?.live() ?? null, missing: readModel ? NOT_STARTED : NOT_AVAILABLE, recall }),
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
		markerId: "usage",
		title: "Usage",
		// The scroll keys are named only while the open view has more than it shows.
		footerHint: (innerWidth) =>
			buildResponsiveHint([
				{ key: "1–5 / Tab", verb: "view", critical: true },
				...(body.overflows()
					? [
							{ key: "↑↓", verb: "scroll" },
							{ key: "PgUp/PgDn", verb: "page" },
						]
					: []),
			])(innerWidth),
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
