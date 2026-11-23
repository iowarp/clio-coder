import type { OutputStyle } from "../core/defaults.js";
import { tierPolicy, type UsageSections } from "../core/presentation-tier.js";
import type { FactMetric, Quantity, RunTelemetryV1 } from "../core/telemetry/dto.js";
import { factRef } from "../core/telemetry/dto.js";
import type { EconomyProjection } from "../core/telemetry/economy.js";
import type { AgentRole } from "../core/telemetry/enums.js";
import { factKnownValue } from "../core/telemetry/known.js";
import { renderUpperBound } from "../core/telemetry/render.js";
import type { VerifiedOutcomeCount } from "../domains/evidence/verified-outcomes.js";
import { createQuotaSummaryFeed } from "../domains/quota/summary-feed.js";
import type { RecallTelemetry, SessionEntry } from "../domains/session/index.js";
import { foldRecallTelemetry, formatRecallTelemetry, hasRecallTelemetry } from "../domains/session/index.js";
import type { GitChanges } from "../domains/session/workspace/git-probe.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import type { TelemetryContract } from "../domains/telemetry/index.js";
import type { Component, OverlayHandle, TUI } from "../engine/tui.js";
import { matchesKey, stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { USAGE_TAB_NAMES, type UsageTab } from "../session-control/slash-commands.js";
import {
	ACTIVITY_SPAN_DAYS,
	ACTIVITY_SPARK_WEEKS,
	bucketActivity,
	renderActivityHeatmap,
	weeklyActivity,
} from "./activity-view.js";
import type { DispatchBoardRow } from "./dispatch-board.js";
import { machineBlock } from "./footer/pages.js";
import { createLocalMachineSampler } from "./footer/system-metrics.js";
import { type HealthDataOptions, healthData, healthLines } from "./health-overlay.js";
import { buildResponsiveHint, showClioOverlayFrame } from "./overlay-frame.js";
import type { QuotaProviders, RecordedWorkerRun } from "./quota-view.js";
import {
	bindingQuotaWindow,
	bindingWindowPart,
	linkedQuotaAccounts,
	quotaMeter,
	renderQuotaAccounts,
	renderWorkerUsage,
} from "./quota-view.js";
import {
	clioTheme,
	formatElapsed,
	GLYPH,
	heightClass,
	padAnsi,
	positionRow,
	sectionRule,
	sparkline,
} from "./theme/index.js";
import {
	economyEvidence,
	economyReceipt,
	NO_VERIFIED_OUTCOME,
	type ReceiptPart,
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

/** Each agent role's share of the calls row, in the note column; a role added later still shows, under its own name. */
const ROLE_WORD: Readonly<Record<AgentRole, string>> = {
	main: "conversation",
	coordinator: "coordinator",
	worker: "workers",
	compaction: "compaction",
	memory: "memory",
	"system-one": "System One",
	prewarm: "pre-warms",
	btw: "side questions",
	handoff: "handoffs",
	helper: "helpers",
	"safety-judge": "safety judge",
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

/** One fact: its label, the figure for the number column, and a note for the third column. */
type FactRow = readonly [string, string, string?];

/** A figure no wider than this sits in the number column; a longer value is read in the note column instead. */
const VALUE_MAX = 12;
const NOTE_GAP = 3;
/** Under this many cells a note column would hold a word or two, so notes take the row under their figure. */
const NOTE_MIN = 16;
/** The cell of a figure nothing measured; the note column says why, once. */
const NO_VALUE = "—";

/** Where a fact's parts go: a figure stays in the number column, a word or a long value moves to the note column. */
function placeFact([key, value, note]: FactRow): { key: string; value: string; note: string } {
	const theme = clioTheme();
	const annotation = (text: string) => theme.fg("annotation", text);
	const text = stripTerminalSequences(value);
	// The number column holds figures and the dash; a word such as `unknown` is said in the note column.
	if (text.length > 0 && text !== NO_VALUE && !/\d/u.test(text))
		return { key, value: NO_VALUE, note: annotation(note ? `${text} ${GLYPH.sep} ${note}` : text) };
	return visibleWidth(value) <= VALUE_MAX
		? { key, value, note: note ? annotation(note) : "" }
		: { key, value: "", note: `${theme.fg("counter", value)}${note ? annotation(` ${GLYPH.sep} ${note}`) : ""}` };
}

/** The label and number columns several fact blocks share, so one tab's figures sit in one column. */
interface FactColumns {
	keyWidth: number;
	valueWidth: number;
}

function factColumns(entries: ReadonlyArray<FactRow>, contentWidth: number): FactColumns {
	const rows = entries.map(placeFact);
	return {
		keyWidth: Math.min(
			Math.max(0, ...rows.map((row) => visibleWidth(row.key))),
			Math.max(4, Math.floor(contentWidth * 0.4)),
		),
		valueWidth: Math.max(0, ...rows.map((row) => visibleWidth(row.value))),
	};
}

/**
 * Fact rows in three columns (7.8): labels left, every figure right-aligned in one column, every note starting in one
 * column and wrapping inside it. A word or a value too wide for the number column moves to the note column, so a
 * sentence never pushes the figures of its neighbours apart. Blocks of one tab pass the same `columns`. Under 32 cells
 * each label sits above its value.
 */
function kvBlock(
	entries: ReadonlyArray<FactRow>,
	contentWidth: number,
	columns: FactColumns = factColumns(entries, contentWidth),
): string[] {
	const theme = clioTheme();
	const counter = (value: string) => theme.fg("counter", value);
	if (contentWidth < 32)
		return entries.flatMap(([key, value, note]) => [
			...wrapTextWithAnsi(theme.fg("fieldName", key), contentWidth),
			...wrapTextWithAnsi(
				[value.length > 0 ? counter(value) : null, note ? theme.fg("annotation", note) : null]
					.filter((part) => part !== null)
					.join(" "),
				contentWidth,
			),
		]);
	const { keyWidth, valueWidth } = columns;
	const noteColumn = keyWidth + 2 + (valueWidth > 0 ? valueWidth + NOTE_GAP : 0);
	const stacked = contentWidth - noteColumn < NOTE_MIN;
	const noteIndent = stacked ? keyWidth + 2 : noteColumn;
	const noteRoom = Math.max(1, contentWidth - noteIndent);
	return entries.map(placeFact).flatMap((row) => {
		const lead = `${theme.fg("fieldName", padAnsi(row.key, keyWidth, GLYPH.ellipsis))}  ${
			valueWidth > 0 ? `${" ".repeat(valueWidth - visibleWidth(row.value))}${row.value ? counter(row.value) : ""}` : ""
		}`;
		const notes = row.note.length > 0 ? wrapTextWithAnsi(row.note, noteRoom) : [];
		const indent = " ".repeat(noteIndent);
		if (stacked || notes.length === 0) return [lead.trimEnd(), ...notes.map((line) => `${indent}${line}`)];
		const [first, ...rest] = notes;
		return [`${padAnsi(lead, noteColumn)}${first}`, ...rest.map((line) => `${indent}${line}`)];
	});
}

/** A titled rule whose meta drops before the title would be cut, so a narrow tab still names its block whole. */
function titledRule(contentWidth: number, label: string, meta: string): string {
	const fits = visibleWidth(label) + visibleWidth(meta) + 6 <= contentWidth;
	return sectionRule(clioTheme(), contentWidth, label, fits ? { meta } : {});
}

/** A figure for the number column; one nothing measured is the dash there and says `not measured` in the note. */
function figureRow(label: string, figure: string, note?: string): FactRow {
	if (figure === USAGE_NOT_MEASURED)
		return [label, NO_VALUE, note === undefined ? USAGE_NOT_MEASURED : `${USAGE_NOT_MEASURED} ${GLYPH.sep} ${note}`];
	return note === undefined ? [label, figure] : [label, figure, note];
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
function tokenRows(view: TelemetryView, model: string | undefined, sections: UsageSections): FactRow[] {
	// Each row is the figure alone; the coverage row above the table says once how many calls reported nothing (F4).
	// One mark at most: `≥~27,252` stacked two qualifiers; the usage data row says once which calls Clio estimated.
	const quantity = (metric: FactMetric) =>
		view.quantity(
			factRef({
				scope: "session",
				owner: view.sessionId,
				metric,
				...(model === undefined ? {} : { group: { by: "model", key: model } }),
			}),
		);
	const display = (metric: FactMetric) => usageLineFigure(quantity(metric));
	if (sections === "totals") return [figureRow("processed", display("total"), "tokens")];
	// `processed` counts the cache write, so Standard shows it whenever it is not zero, as the exit summary does.
	const cacheWrite = sections === "provenance" || nonZero(quantity("cacheWrite"));
	return [
		figureRow("input", display("input")),
		figureRow("output", display("output")),
		figureRow("cache read", display("cacheRead")),
		...(sections === "provenance" ? [figureRow("reasoning", display("reasoning"), REASONING_NOTE)] : []),
		...(cacheWrite ? [figureRow("cache write", display("cacheWrite"))] : []),
		figureRow("processed", display("total"), "tokens"),
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
 * The calls row as the exit card counts them: the ones that went out, then in its note each role's share (from the
 * breakdown tier) and the attempts that never left. A role whose every step was skipped reads `memory 0 (8 never
 * sent)` rather than eight model calls nobody made.
 */
function callRow(
	view: TelemetryView,
	groups: ReadonlyArray<{ key: string; calls: Quantity }>,
	sections: UsageSections,
): FactRow {
	const word = (key: string): string => ROLE_WORD[key as AgentRole] ?? key;
	const breakdown = sections !== "totals";
	const total = sentCallCount(view);
	const row = (value: string, parts: readonly string[]): FactRow =>
		parts.length === 0 ? ["calls", value] : ["calls", value, parts.join(` ${GLYPH.sep} `)];
	if (Number.isNaN(total))
		return row(
			view.cost("role").total.calls.display,
			breakdown ? groups.map((group) => `${word(group.key)} ${group.calls.display}`) : [],
		);
	const unsent = (all: Quantity, sent: number): number => {
		const known = factKnownValue(all.fact);
		return Number.isFinite(known) ? Math.max(0, known - sent) : 0;
	};
	const count = (value: number) => value.toLocaleString("en-US");
	const roles = breakdown
		? groups.map((group) => {
				const sent = sentCallCount(view, { roles: [group.key as AgentRole] });
				const left = unsent(group.calls, sent);
				return `${word(group.key)} ${count(sent)}${left > 0 ? ` (${count(left)} never sent)` : ""}`;
			})
		: [];
	const left = unsent(view.cost("role").total.calls, total);
	return row(count(total), [...roles, ...(left > 0 ? [`${count(left)} more never sent`] : [])]);
}

/**
 * The Session tab: every call this session paid for, across every branch, as the telemetry read model folds it
 * (#434 §11.3). Nothing here adds or subtracts; an unknown cache read reads `not measured`, never `0`. The totals show
 * at every tier, the breakdown rows from standard, the cache accounting and recall from detailed.
 */
function summaryRows(
	view: TelemetryView,
	recall: RecallTelemetry | null,
	verified: VerifiedOutcomeCount | null,
	sections: UsageSections,
	receipt: readonly ReceiptPart[] = [],
): FactRow[] {
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
	const usageNotes = sessionUsageNotes(view);
	const receiptNote = receipt.length > 0 ? receiptText(receipt) : undefined;
	const usd = byRole.total.usd;
	return [
		callRow(view, groups, sections),
		...(sections !== "totals" ? [["harness overhead", session.overhead.share.display] as const] : []),
		...(usageNotes.length > 0 ? [["usage data", "", usageNotes.join(` ${GLYPH.sep} `)] as const] : []),
		// The calls row carries its never-sent count; a separate row is needed only when it could not.
		...(nonZero(neverSent) && Number.isNaN(sentCallCount(view))
			? [["never sent", neverSent.display, neverSent.display === "1" ? "call" : "calls"] as const]
			: []),
		// The receipt is the cost's evidence in words, so it is the cost row's note.
		...(contributed(usd)
			? [figureRow("cost", usageUnmeasured(usd) ? USAGE_NOT_MEASURED : usd.display, receiptNote)]
			: receiptNote !== undefined
				? [["receipt", "", receiptNote] as const]
				: []),
		...(verified !== null ? verifiedRows(view, verified) : []),
		...tokenRows(view, undefined, sections),
		...(cached && sections === "provenance"
			? [
					["uncached prefill", usageFigure(cache.uncachedPrefill)] as const,
					[
						"re-prefilled",
						renderUpperBound(cache.rePrefilled.fact, usageFigure(cache.rePrefilled)),
						`${cache.breaks.length} breaks`,
					] as const,
					["cache-break bill", renderUpperBound(cache.breakUsd.fact, usageFigure(cache.breakUsd))] as const,
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
	];
}

/**
 * The session's verified outcomes and what each cost, beside the totals they divide. Cost per outcome is the cost row's
 * own mark, so an unpriced route reads `not measured` on both; with no outcome there is no per-outcome row at all.
 */
function verifiedRows(view: TelemetryView, outcomes: VerifiedOutcomeCount): FactRow[] {
	const words = verifiedOutcomeWords(view, outcomes);
	if (words.kind === "none") return [["verified outcomes", NO_VALUE, NO_VERIFIED_OUTCOME.replace(/^none /u, "")]];
	return [
		["verified outcomes", words.count, words.parts.join(" · ")],
		["tokens per outcome", words.tokens],
		["cost per outcome", words.cost],
	];
}

/** The receipt's parts on one line; a part with an unknown is drawn in the neutral unknown tone, never as a fault. */
function receiptText(parts: readonly ReceiptPart[]): string {
	const theme = clioTheme();
	return parts
		.map((part) => (part.unknown ? theme.fg("unknownValue", part.text) : part.text))
		.join(theme.fg("annotation", " · "));
}

/**
 * The session's receipt with the binding window of the quota accounts its calls draw on, linked by the calls' runtimes
 * and targets, when any is linked.
 */
function sessionReceipt(economy: SessionEconomy, quota: QuotaProviders, now: number): ReceiptPart[] {
	const binding = bindingQuotaWindow(
		linkedQuotaAccounts(quota, {
			runtimeIds: economy.runtimeIds,
			targetIds: economy.projection.groups.target.map((group) => group.key),
		}),
	);
	return economyReceipt(economy.projection.total, binding === null ? null : bindingWindowPart(binding, now));
}

/** The receipt's evidence, expanded under the Session tab; a value with an unknown keeps the neutral tone. */
function evidenceRows(economy: EconomyProjection): FactRow[] {
	const theme = clioTheme();
	return economyEvidence(economy, "session").map(([label, value, note, unknown]) => {
		const shown = unknown ? theme.fg("unknownValue", value) : value;
		return note === undefined ? ([label, shown] as const) : ([label, shown, note] as const);
	});
}

/**
 * The Session tab's facts under its titled rule, and the receipt's evidence under its own when shown. The two blocks
 * share their label and number columns, so every figure of the tab ends in one column and every note starts in one.
 */
function sessionLines(rows: readonly FactRow[], evidence: readonly FactRow[], contentWidth: number): string[] {
	const theme = clioTheme();
	const columns = factColumns([...rows, ...evidence], contentWidth);
	return [
		...kvBlock(rows, contentWidth, columns),
		...(evidence.length > 0
			? ["", sectionRule(theme, contentWidth, "Receipt evidence"), ...kvBlock(evidence, contentWidth, columns)]
			: []),
	];
}

/**
 * The funding pools this session's calls drew on, beside the account limits: each pool's extra cost and API
 * equivalent. A session's projection carries no declared fee, which belongs to its pool's period; any it does carry
 * is listed once per period.
 */
function poolLines(economy: EconomyProjection, contentWidth: number): string[] {
	const theme = clioTheme();
	const pools = economy.groups.pool;
	if (pools.length === 0) return [];
	return [
		"",
		sectionRule(theme, contentWidth, "Funding pools", { meta: "this session" }),
		...wrapTextWithAnsi(
			theme.fg("annotation", "Declared fees belong to their period, not a session: clio-coder usage report."),
			contentWidth,
		),
		...kvBlock(
			pools.flatMap((pool) => [
				pool.contributions > 0
					? ([`pool ${pool.key}`, pool.display.extra, pool.display.apiEquivalent] as const)
					: ([`pool ${pool.key}`, theme.fg("annotation", "no calls this session")] as const),
				...pool.periods.flatMap((period) =>
					period.fees.map(
						(fee) =>
							[
								"  fee",
								fee.display,
								`from ${fee.period.start.slice(0, 10)} · paid by ${fee.payer} · once per period`,
							] as const,
					),
				),
			]),
			contentWidth,
		),
	];
}

/** The Models tab: one block per `target/model`, the reported model where the provider named one. */
function modelLines(view: TelemetryView, contentWidth: number, sections: UsageSections): string[] {
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
					...(contributed(group.usd)
						? [figureRow("cost", usageUnmeasured(group.usd) ? USAGE_NOT_MEASURED : group.usd.display)]
						: []),
					...tokenRows(view, group.key, sections),
				],
				contentWidth,
			),
		);
	}
	return lines;
}

/** What the overlay reads: the live view, and the ledger's recall fold, re-read on updates rather than per frame. */
interface UsageData {
	view: TelemetryView | null;
	/** Why `view` is null: no read model at all, or no session for it to read yet. */
	missing: string;
	recall: RecallTelemetry | null;
	/** The session's verified outcomes, re-read with the recall fold rather than per frame; null without a ledger. */
	verified: VerifiedOutcomeCount | null;
	/** The session's economics folded once (token economy S10), re-read when the view changes; null without a view. */
	economy: SessionEconomy | null;
}

/** The session's folded economics and the runtimes its calls ran on, which link its quota accounts. */
interface SessionEconomy {
	projection: EconomyProjection;
	runtimeIds: readonly string[];
}

export interface OpenUsageOverlayOptions {
	/** Ignored: `/usage` reads the tier from `tierPolicy()` like every surface (3.1). The sweep row removes it. */
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
 * The glance tab: the activity graph, then the four facts an operator asks for before any table, each `label  value`
 * on one column so the eye reads down the labels. The graph is a 26-week sparkline from the breakdown tier, and the
 * full heatmap only with provenance on a terminal of the H3 class or taller.
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
	sections: UsageSections,
	terminalRows: number,
): string[] {
	const theme = clioTheme();
	const sparkLabel = `${ACTIVITY_SPARK_WEEKS} weeks`;
	const labelWidth = Math.max(visibleWidth(sparkLabel), visibleWidth("receipt")) + 2;
	// A value that wraps continues under its own column, not under the label, so a narrow Session row still reads
	// as one row.
	const row = (name: string, value: string): string[] =>
		contentWidth < 32
			? kvBlock([[name, value]], contentWidth)
			: wrapTextWithAnsi(value, Math.max(1, contentWidth - labelWidth)).map(
					(line, index) =>
						`${index === 0 ? padAnsi(theme.fg("fieldName", name), labelWidth) : " ".repeat(labelWidth)}${line}`,
				);
	const workspace = `${sessions} session${sessions === 1 ? "" : "s"} in this workspace`;
	const tall = heightClass(terminalRows) === "H3" || heightClass(terminalRows) === "H4";
	const lines: string[] = [];
	if (sections === "provenance" && tall)
		lines.push(
			...renderActivityHeatmap(days, now, contentWidth, `last ${ACTIVITY_SPAN_DAYS} days ${GLYPH.sep} ${workspace}`),
			"",
		);
	else if (sections !== "totals") {
		const cells = Math.max(1, Math.min(ACTIVITY_SPARK_WEEKS, contentWidth - labelWidth));
		lines.push(
			...row(sparkLabel, `${sparkline(theme, weeklyActivity(days, now), cells)}  ${theme.fg("annotation", workspace)}`),
		);
	}
	const changesValue =
		changes === null
			? theme.fg("annotation", "not observed")
			: `${theme.fg("success", `+${changes.insertions}`)} ${theme.fg("error", `-${changes.deletions}`)} ${theme.fg("annotation", `${GLYPH.sep} ${changes.files} file${changes.files === 1 ? "" : "s"}`)}`;
	lines.push(...row("changes", changesValue));
	const started = startedAt ? Date.parse(startedAt) : Number.NaN;
	const elapsed = Number.isFinite(started) ? `${formatElapsed(Math.max(0, now - started))} so far` : null;
	const view = data.view;
	if (!view)
		lines.push(
			...row(
				"session",
				theme.fg("annotation", [elapsed, data.missing].filter((part) => part !== null).join(` ${GLYPH.sep} `)),
			),
		);
	else {
		lines.push(...row("session", sessionValue(view, elapsed)));
		// A token total nothing measured already says why on the session row, so its coverage is not said again here.
		const tokens = view.session().totals.tokens;
		const tokenCoverage = usageSaysNothing(usageFigure(tokens)) ? [] : sessionUsageNotes(view);
		const neverSent = view.session().own.counts.dispositions.neverSent;
		const usage = [
			...tokenCoverage,
			nonZero(neverSent) ? `${neverSent.display} ${neverSent.display === "1" ? "call" : "calls"} never sent` : null,
		].filter((part) => part !== null);
		if (usage.length > 0) lines.push(...row("usage", theme.fg("annotation", usage.join(` ${GLYPH.sep} `))));
	}
	// The window that binds first, the fullest one, not whichever account happened to be listed first.
	const window = bindingQuotaWindow(quota);
	if (window) {
		const meter =
			window.pct !== null && sections !== "totals"
				? `${quotaMeter(Math.min(100, window.pct), Math.min(28, Math.max(1, contentWidth - 30)), window.severity)} `
				: "";
		lines.push(
			...row(
				"plan",
				`${meter}${window.used} used ${theme.fg("annotation", `${GLYPH.sep} ${window.stale ? `STALE ${GLYPH.sep} ` : ""}${window.provider} ${window.window}`)}`,
			),
		);
	} else lines.push(...row("plan", theme.fg("annotation", "no subscription window reported")));
	// The plan row above names the binding window, so the receipt here starts at the extra cost.
	const receipt = data.economy ? economyReceipt(data.economy.projection.total, null) : [];
	if (receipt.length > 0) lines.push(...row("receipt", receiptText(receipt)));
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
	/** The Session tab shows the receipt's evidence; `e` toggles it, and Detailed opens with it shown. */
	evidence: boolean | null = null;
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
		private readonly getHealthLines: (width: number, sections: UsageSections) => string[],
		/** Terminal rows: the heatmap needs the H3 class or taller. */
		private readonly terminalRows: () => number,
		/** Told which tab each frame shows, so the machine sampler runs only under Health. */
		private readonly onTabShown: (tab: number) => void = () => {},
	) {}

	showsEvidence(): boolean {
		return this.evidence ?? tierPolicy().usageSections === "provenance";
	}

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
		else if (matchesKey(data, "e") && this.tab === 2) this.evidence = !this.showsEvidence();
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
		const sections = tierPolicy().usageSections;
		const data = this.getData();
		const quota = this.getQuotaSnapshots();
		const theme = clioTheme();
		// The active tab carries the cursor; a no-break space keeps a tab's number with its name when the row wraps.
		const tabs = wrapTextWithAnsi(
			USAGE_TABS.map((name, index) =>
				index === this.tab
					? theme.style("selectedOption", `${GLYPH.cursor}${index + 1}\u00a0${name}`, { bold: true })
					: theme.fg("menuOption", `${index + 1}\u00a0${name}`),
			).join("  "),
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
				sections,
				this.terminalRows(),
			);
		else if (this.tab === 1)
			body = [
				...(sections === "totals"
					? []
					: [theme.fg("annotation", "Account-wide limits · filled = used · shared across sessions and devices"), ""]),
				// An empty tab said only that nothing was journaled; it now says what would fill it.
				...(quota.length > 0
					? renderQuotaAccounts(quota, contentWidth, { compact: sections === "totals" })
					: wrapTextWithAnsi(
							theme.fg(
								"annotation",
								"No account quota is known. It appears here once a signed-in subscription target reports its limits; local and API-key targets report none.",
							),
							contentWidth,
						)),
				...(data.economy ? poolLines(data.economy.projection, contentWidth) : []),
			];
		else if (this.tab === 2)
			body = [
				titledRule(contentWidth, "Session", "this session, every branch"),
				...(data.view
					? sessionLines(
							summaryRows(
								data.view,
								data.recall,
								data.verified,
								sections,
								data.economy ? sessionReceipt(data.economy, quota, this.activity.now()) : [],
							),
							data.economy && this.showsEvidence() ? evidenceRows(data.economy.projection) : [],
							contentWidth,
						)
					: [theme.fg("annotation", data.missing)]),
				...(data.view && !nonZero(data.view.cost("role").total.calls)
					? [theme.fg("annotation", "no calls recorded for this session")]
					: []),
				...(sections === "provenance"
					? [
							"",
							theme.fg(
								"annotation",
								"Estimates and gaps are marked. Session tokens cannot be converted to subscription percentages.",
							),
						]
					: []),
			];
		else if (this.tab === 3) {
			body = [
				titledRule(contentWidth, "Models", "this session, every branch"),
				...(sections === "provenance"
					? [
							theme.fg(
								"annotation",
								"Recorded calls per model across every branch, including cache traffic; not account quota.",
							),
							"",
						]
					: []),
				...(data.view ? modelLines(data.view, contentWidth, sections) : [theme.fg("annotation", data.missing)]),
			];
		} else if (this.tab === 5) body = this.getHealthLines(contentWidth, sections);
		else body = renderWorkerUsage(this.getDispatchRows(), this.recordedRuns(data.view), quota, contentWidth);
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
	// The fold reads every settled call, so it runs once per view, not once per frame.
	const economies = new WeakMap<TelemetryView, SessionEconomy>();
	const economyOf = (view: TelemetryView | null): SessionEconomy | null => {
		if (!view) return null;
		const cached = economies.get(view);
		if (cached) return cached;
		const runtimeIds = new Set<string>();
		for (const record of view.callRecords())
			if (record.k === "call.started") runtimeIds.add(record.data.target.runtimeId);
		const economy = { projection: view.economy(), runtimeIds: [...runtimeIds] };
		economies.set(view, economy);
		return economy;
	};
	const body = new UsageOverlayBody(
		() => {
			const view = readModel?.live() ?? null;
			return {
				view,
				missing: readModel ? NOT_STARTED : NOT_AVAILABLE,
				recall,
				verified,
				economy: economyOf(view),
			};
		},
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
		// The machine block is healthy detail, so it joins the Health rows from the breakdown tier.
		(width, sections) => {
			const lines = healthLines(healthData(readModel, options?.health), width);
			return sections === "totals" ? lines : [...lines, "", ...machineBlock(machine.snapshot(), now(), width)];
		},
		() => tui.terminal.rows,
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
				{ key: "1–6/Tab", verb: "view", critical: true },
				// The evidence is folded away in Standard, so its key outlives the scroll keys on a narrow rail.
				...(body.tab === 2
					? [
							{
								key: "e",
								verb: body.showsEvidence() ? "hide evidence" : "evidence",
								short: body.showsEvidence() ? "hide" : "evidence",
								critical: true,
							},
						]
					: []),
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
