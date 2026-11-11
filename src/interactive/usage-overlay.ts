import type { OutputStyle } from "../core/defaults.js";
import type { FactMetric, Quantity, RunTelemetryV1 } from "../core/telemetry/dto.js";
import { factRef } from "../core/telemetry/dto.js";
import type { AgentRole } from "../core/telemetry/enums.js";
import { factKnownValue } from "../core/telemetry/known.js";
import type { VerifiedOutcomeCount } from "../domains/evidence/verified-outcomes.js";
import { createQuotaSummaryFeed } from "../domains/quota/summary-feed.js";
import type { RecallTelemetry, SessionEntry } from "../domains/session/index.js";
import { foldRecallTelemetry, formatRecallTelemetry, hasRecallTelemetry } from "../domains/session/index.js";
import type { GitChanges } from "../domains/session/workspace/git-probe.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import type { TelemetryContract } from "../domains/telemetry/index.js";
import type { Component, OverlayHandle, TUI } from "../engine/tui.js";
import { matchesKey, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { USAGE_TAB_NAMES, type UsageTab } from "../session-control/slash-commands.js";
import { ACTIVITY_SPAN_DAYS, bucketActivity, renderActivityHeatmap } from "./activity-view.js";
import type { DispatchBoardRow } from "./dispatch-board.js";
import { machineBlock } from "./footer/pages.js";
import { createLocalMachineSampler } from "./footer/system-metrics.js";
import { type HealthDataOptions, healthData, healthLines } from "./health-overlay.js";
import { buildResponsiveHint, showClioOverlayFrame } from "./overlay-frame.js";
import type { QuotaProviders, RecordedWorkerRun } from "./quota-view.js";
import { quotaMeter, renderQuotaAccounts, renderWorkerUsage } from "./quota-view.js";
import { clioTheme, formatCompactMs, padAnsi, positionRow, rule } from "./theme/index.js";
import {
	NO_VERIFIED_OUTCOME,
	sentCallCount,
	sessionVerifiedOutcomes,
	USAGE_NOT_MEASURED,
	usageCoverage,
	usageEstimatedCalls,
	usageEstimates,
	usageFigure,
	usageGap,
	usageLineFigure,
	usageLineNotes,
	usageSaysNothing,
	usageStillRunning,
	usageUnmeasured,
	verifiedOutcomeWords,
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
	if (contentWidth < 32)
		return entries.flatMap(([key, value, annotation]) => [
			...wrapTextWithAnsi(theme.fg("fieldName", key), contentWidth),
			...wrapTextWithAnsi(
				`${theme.fg("counter", value)}${annotation ? ` ${theme.fg("annotation", annotation)}` : ""}`,
				contentWidth,
			),
		]);
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
function tokenRows(
	view: TelemetryView,
	model?: string,
	style: OutputStyle = "standard",
): Array<readonly [string, string, string?]> {
	// Each row is the figure alone; the coverage row above the table says once how many calls reported nothing (F4).
	// One mark at most: `≥~27,252` stacked two qualifiers; the usage data row says once which calls Clio estimated.
	const display = (metric: FactMetric) =>
		usageLineFigure(
			view.quantity(
				factRef({
					scope: "session",
					owner: view.sessionId,
					metric,
					...(model === undefined ? {} : { group: { by: "model", key: model } }),
				}),
			),
		);
	if (style === "compact") return [["processed", tokensText(display("total"))]];
	return [
		["input", display("input")],
		["output", display("output")],
		["cache read", display("cacheRead")],
		...(style === "detailed"
			? [["reasoning", display("reasoning"), REASONING_NOTE] as const, ["cache write", display("cacheWrite")] as const]
			: []),
		["processed", tokensText(display("total"))],
	];
}

/**
 * What the session's token figures leave out, in the exit card's words. `1 of 2 calls had no usage data` counted a
 * missing cache-read figure as a call and a never-sent call as a second one, beside a receipt that measured the turn.
 */
function sessionUsageNotes(view: TelemetryView): string[] {
	const quantity = (metric: FactMetric) => view.quantity(factRef({ scope: "session", owner: view.sessionId, metric }));
	const { notes } = usageLineNotes(
		[
			{ label: "in", quantity: quantity("input") },
			{ label: "out", quantity: quantity("output") },
			{ label: "cache read", quantity: quantity("cacheRead") },
			{ label: "cache write", quantity: quantity("cacheWrite") },
			{ label: "reasoning", quantity: quantity("reasoning") },
		],
		callsStillRunning(view),
	);
	const estimates = usageEstimates(usageEstimatedCalls(quantity("total")));
	return [...notes, ...(estimates !== null ? [estimates] : [])];
}

/** When this process started, as the journal writes times: every attempt it began after this, it also settles. */
const PROCESS_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

/**
 * The session's own calls still out on the wire. This process settles every attempt it starts, so an unsettled one it
 * began is in flight; one an earlier process began and never settled is a call with no usage data. `/usage` opened
 * during a wait counted the waiting call as one that had no usage data.
 */
function callsStillRunning(view: TelemetryView): number {
	try {
		return view.calls({ dispositions: ["incomplete"], from: PROCESS_STARTED_AT }).matched;
	} catch {
		// A read model that cannot list calls leaves every gap as the read model counts it.
		return 0;
	}
}

/**
 * Calls per agent as the exit card counts them: the ones that went out, with the attempts that never left beside them.
 * A role whose every step was skipped reads `0 · 8 never sent` rather than eight model calls nobody made.
 */
function callRows(
	view: TelemetryView,
	groups: ReadonlyArray<{ key: string; calls: Quantity }>,
): Array<readonly [string, string, string?]> {
	const caption = (key: string): string => ROLE_CAPTION[key as AgentRole] ?? `${key} calls`;
	const total = sentCallCount(view);
	if (Number.isNaN(total))
		return [
			...groups.map((group) => [caption(group.key), group.calls.display] as const),
			["model calls", view.cost("role").total.calls.display],
		];
	const unsent = (all: Quantity, sent: number): string | undefined => {
		const known = factKnownValue(all.fact);
		const left = Number.isFinite(known) ? known - sent : 0;
		return left > 0 ? `sent · ${left.toLocaleString("en-US")} more never sent` : "sent";
	};
	type Row = readonly [string, string, string?];
	const row = (label: string, value: number, note: string | undefined): Row =>
		note === undefined ? [label, value.toLocaleString("en-US")] : [label, value.toLocaleString("en-US"), note];
	const rows = groups.map((group) => {
		const sent = sentCallCount(view, { roles: [group.key as AgentRole] });
		const note = unsent(group.calls, sent);
		return row(caption(group.key), sent, note);
	});
	const note = unsent(view.cost("role").total.calls, total);
	return [...rows, row("model calls", total, note)];
}

/**
 * The Session tab: every call this session paid for, across every branch, as the telemetry read model folds it
 * (#434 §11.3). Nothing here adds or subtracts; an unknown cache read reads `unknown`, never `0`.
 */
function summaryBlock(
	view: TelemetryView,
	recall: RecallTelemetry | null,
	verified: VerifiedOutcomeCount | null,
	contentWidth: number,
	style: OutputStyle,
): string[] {
	const session = view.session();
	const byRole = view.cost("role");
	const cache = view.cache();
	const neverSent = session.own.counts.dispositions.neverSent;
	const groups = [...byRole.groups].sort((a, b) =>
		a.key === "main" ? -1 : b.key === "main" ? 1 : a.key.localeCompare(b.key),
	);
	// A measured zero read is a cache that served nothing, which the rows say; only a session no call fed hides them.
	const cached = contributed(cache.cacheRead) || contributed(cache.cacheWrite) || contributed(cache.rePrefilled);
	const v = cache.verdicts;
	const calls = callRows(view, groups);
	return kvBlock(
		[
			...(style === "compact" ? calls.slice(-1) : calls),
			...(style !== "compact" ? [["harness overhead", session.overhead.share.display] as const] : []),
			...(sessionUsageNotes(view).length > 0 ? [["usage data", sessionUsageNotes(view).join(" · ")] as const] : []),
			// The calls rows carry their never-sent count beside them; a separate row is needed only when they could not.
			...(nonZero(neverSent) && Number.isNaN(sentCallCount(view))
				? [["never sent", `${neverSent.display} ${neverSent.display === "1" ? "call" : "calls"}`] as const]
				: []),
			...(contributed(byRole.total.usd) ? [["cost", byRole.total.usd.display] as const] : []),
			...(verified !== null ? verifiedRows(view, verified) : []),
			...tokenRows(view, undefined, style),
			...(cached && style === "detailed"
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

/**
 * The session's verified outcomes and what each cost, beside the totals they divide. Cost per outcome is the cost row's
 * own mark, so an unpriced route reads `not measured` on both; with no outcome there is no per-outcome row at all.
 */
function verifiedRows(view: TelemetryView, outcomes: VerifiedOutcomeCount): Array<readonly [string, string, string?]> {
	const words = verifiedOutcomeWords(view, outcomes);
	if (words.kind === "none") return [["verified outcomes", "none", NO_VERIFIED_OUTCOME.replace(/^none /u, "")]];
	return [
		["verified outcomes", words.count, words.parts.join(" · ")],
		["tokens per outcome", words.tokens],
		["cost per outcome", words.cost],
	];
}

/** The Models tab: one block per `target/model`, the reported model where the provider named one. */
function modelLines(view: TelemetryView, contentWidth: number, style: OutputStyle): string[] {
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
					...tokenRows(view, group.key, style),
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
	/** The session's verified outcomes, re-read with the recall fold rather than per frame; null without a ledger. */
	verified: VerifiedOutcomeCount | null;
}

export interface OpenUsageOverlayOptions {
	getOutputStyle?: () => OutputStyle;
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
	/** The tab it opens on; Activity when absent. */
	tab?: UsageTab;
	/** Route and System One state for the Health tab, read live on each frame. */
	health?: HealthDataOptions;
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
	const tokenFigure = usageLineFigure(totals.tokens);
	const tokensKnown = !usageSaysNothing(tokenFigure);
	const costShown = contributed(totals.usd);
	const costKnown = costShown && !usageUnmeasured(totals.usd);
	const known = [costKnown ? totals.usd.display : null, tokensKnown ? tokensText(tokenFigure) : null].filter(
		(part) => part !== null,
	);
	const unknown = [tokensKnown ? null : "tokens", costShown && !costKnown ? "cost" : null].filter(
		(part) => part !== null,
	);
	const running = callsStillRunning(view);
	const missing = usageCoverage(Math.max(0, usageGap(totals.tokens) - running));
	const why = tokensKnown
		? null
		: [missing, running > 0 ? usageStillRunning(running) : null].filter((part) => part !== null).join(", ") || null;
	// Figures a running call will still report are not unmeasured yet, only not in.
	const pending = running > 0 && missing === null;
	const gap =
		unknown.length > 0
			? `${unknown.join(" and ")} ${pending ? "not reported yet" : USAGE_NOT_MEASURED}${why === null ? "" : ` (${why})`}`
			: null;
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
	style: OutputStyle,
): string[] {
	const theme = clioTheme();
	const label = (text: string): string => padAnsi(theme.fg("fieldName", text), 12);
	// A value that wraps continues under its own column, not under the label, so a narrow Session row still reads
	// as one row.
	const row = (name: string, value: string): string[] =>
		contentWidth < 32
			? kvBlock([[name, value]], contentWidth)
			: wrapTextWithAnsi(value, Math.max(1, contentWidth - 12)).map(
					(line, index) => `${index === 0 ? label(name) : " ".repeat(12)}${line}`,
				);
	const lines = [
		...(style === "detailed" || (style === "standard" && sessions > 0)
			? [
					...renderActivityHeatmap(
						days,
						now,
						contentWidth,
						`last ${ACTIVITY_SPAN_DAYS} days · ${sessions} session${sessions === 1 ? "" : "s"} in this workspace`,
					),
					"",
				]
			: []),
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
		const reported = factKnownValue(window.item.usedPct.fact);
		const pct = Math.max(0, Math.min(100, reported));
		const meter =
			Number.isFinite(reported) && style !== "compact"
				? `${quotaMeter(pct, Math.min(28, Math.max(1, contentWidth - 30)))} `
				: "";
		lines.push(
			...row(
				"Plan",
				`${meter}${window.item.usedPct.display} used ${theme.fg("annotation", `· ${window.entry.provider} ${window.item.label}`)}`,
			),
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

const USAGE_TABS = ["Activity", "Accounts", "Session", "Models", "Workers", "Health"] as const;

class UsageOverlayBody implements Component {
	tab = 0;
	private offsets = [0, 0, 0, 0, 0, 0];
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
		private readonly getOutputStyle: () => OutputStyle,
		private readonly getHealthLines: (width: number, style: OutputStyle) => string[],
		/** Told which tab each frame shows, so the machine sampler runs only under Health. */
		private readonly onTabShown: (tab: number) => void = () => {},
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
		const selected = (["1", "2", "3", "4", "5", "6"] as const).findIndex((key) => matchesKey(data, key));
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
		this.onTabShown(this.tab);
		const style = this.getOutputStyle();
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
				style,
			);
		else if (this.tab === 1)
			body = [
				...(style === "compact"
					? []
					: [theme.fg("annotation", "Account-wide limits · filled = used · shared across sessions and devices"), ""]),
				// An empty tab said only that nothing was journaled; it now says what would fill it.
				...(quota.length > 0
					? renderQuotaAccounts(quota, contentWidth, { compact: style === "compact" })
					: wrapTextWithAnsi(
							theme.fg(
								"annotation",
								"No account quota is known. It appears here once a signed-in subscription target reports its limits; local and API-key targets report none.",
							),
							contentWidth,
						)),
			];
		else if (this.tab === 2)
			body = [
				theme.style("sectionHeading", "Session tokens & cost", { bold: true }),
				...(style === "detailed"
					? [
							theme.fg("annotation", "Every call this session paid for, across every branch · estimates and gaps are marked"),
							"",
						]
					: []),
				...(data.view
					? summaryBlock(data.view, data.recall, data.verified, contentWidth, style)
					: [theme.fg("annotation", data.missing)]),
				"",
				rule(theme, contentWidth),
				...(style === "detailed"
					? [theme.fg("annotation", "Session tokens cannot be converted to subscription percentages.")]
					: []),
				...(data.view && !nonZero(data.view.cost("role").total.calls) ? ["no calls recorded for this session"] : []),
			];
		else if (this.tab === 3) {
			body = [
				theme.style("sectionHeading", "Model activity · this session", { bold: true }),
				...(style === "detailed"
					? [
							theme.fg(
								"annotation",
								"Recorded calls per model across every branch, including cache traffic; not account quota.",
							),
							"",
						]
					: []),
				...(data.view ? modelLines(data.view, contentWidth, style) : [theme.fg("annotation", data.missing)]),
			];
		} else if (this.tab === 5) body = this.getHealthLines(contentWidth, style);
		else body = renderWorkerUsage(this.getDispatchRows(), this.recordedRuns(data.view), quota, contentWidth, style);
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
	const readVerified = (): VerifiedOutcomeCount | null => {
		const view = readModel?.live() ?? null;
		return view && options?.getSessionEntries ? sessionVerifiedOutcomes(view, options.getSessionEntries()) : null;
	};
	let verified = readVerified();
	const now = options?.now ?? (() => Date.now());
	const sessions = options?.listSessions?.() ?? [];
	// The local machine is sampled only while the Health tab is on screen.
	const machine = createLocalMachineSampler(() => tui.requestRender());
	const body = new UsageOverlayBody(
		() => ({ view: readModel?.live() ?? null, missing: readModel ? NOT_STARTED : NOT_AVAILABLE, recall, verified }),
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
		options?.getOutputStyle ?? (() => "standard"),
		(width, style) => [
			...healthLines(healthData(readModel, options?.health), width, style),
			"",
			...machineBlock(machine.snapshot(), now(), width),
		],
		(tab) => machine.setActive(tab === 5),
	);
	if (options?.tab) body.tab = Math.max(0, USAGE_TAB_NAMES.indexOf(options.tab));
	const handle = showClioOverlayFrame(tui, body, {
		anchor: "center",
		width: USAGE_OVERLAY_WIDTH,
		markerId: "usage",
		title: "Usage",
		// The scroll keys are named only while the open view has more than it shows.
		footerHint: (innerWidth) =>
			buildResponsiveHint([
				{ key: "1–6 / Tab", verb: "view", critical: true },
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
		verified = readVerified();
		tui.requestRender();
	};
	const offs = readModel
		? (["session", "calls", "cost", "cache", "runs", "quota", "health"] as const).map((topic) =>
				readModel.subscribe(topic, refresh),
			)
		: [];

	return {
		...handle,
		hide(): void {
			quotaFeed.dispose();
			machine.dispose();
			unsubscribe();
			for (const off of offs) off();
			handle.hide();
		},
	};
}
