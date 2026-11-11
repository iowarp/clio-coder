/**
 * Expanded footer pages: dense inspection, separate from transcript output style.
 *
 * Each page answers one operator question in its first rows and keeps the
 * detail beneath: Activity says what is running, Context says how full the
 * window is, Status says what the session costs and what the machine is doing.
 * The pages compose the shared primitives (chip rows, section rules, tables,
 * meters, fact rows) so a worker row here reads like a worker row on the Fleet
 * Runs board and a quota meter here reads like one in `/usage`.
 */

import { outputStyleLabel } from "../../core/defaults.js";
import { renderUsdLimit } from "../../core/telemetry/render.js";
import type { AutonomyStatus } from "../../domains/safety/autonomy-window.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { redactSecretString } from "../../domains/safety/redaction.js";
import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { contextPercentRole, renderContextMeterBar } from "../context-meter.js";
import type { DispatchBoardRow } from "../dispatch-board.js";
import { dispatchBoardItems, renderDispatchActivity, runTableRows } from "../dispatch-board.js";
import { ACTIVE_DISPATCH_STATUSES, FAILED_DISPATCH_STATUSES, formatFooterTokens } from "../footer-panel.js";
import { actionKeyLabel, formatKeyLabel } from "../keybinding-manager.js";
import type { QuotaProviders } from "../quota-view.js";
import { routeWeeklyQuota } from "../quota-view.js";
import {
	brandMark,
	type ClioTheme,
	chipRow,
	chipRows,
	clioTheme,
	emptyState,
	factRows,
	formatCompactMs,
	formatContextPercent,
	GLYPH,
	meter,
	metricText,
	padAnsi,
	positionRow,
	rule,
	sectionRule,
	type Tone,
} from "../theme/index.js";
import { fitIdentityLabel, fitPathLabel, modelNickname } from "../theme/labels.js";
import type { FooterDashboardRenderState } from "./dashboard.js";
import { footerKeyHint } from "./key-hints.js";
import {
	formatNotificationPanel,
	type Notification,
	notificationGlyph,
	notificationToken,
	topNotification,
} from "./notifications.js";
import type { FooterTelemetry } from "./spend.js";
import type { LocalMachineMetrics } from "./system-metrics.js";
import {
	activeTaskLine,
	blockedTaskLines,
	buildHarnessStatePill,
	compactContextUsage,
	contextUsageText,
	formattedThroughput,
	lastTurnDetails,
	lastTurnOutcome,
	liveTokenValue,
	meaningfulToolTally,
	taskBoardValue,
	zipColumns,
} from "./widgets.js";

/** A plan row stands for a whole fleet plan, and a finished one can predate this process. Neither is a worker. */
function workerRowsOf(rows: ReadonlyArray<DispatchBoardRow>): ReadonlyArray<DispatchBoardRow> {
	return rows.filter((row) => row.plan === undefined);
}

/** At this width and above a page lays its sections out in two columns. */
const FOOTER_SPLIT_COLUMNS = 84;
const clean = (value: string) => sanitizeCallTargetText(redactSecretString(value));

/** `label value`, the dim label first, for a chip that names what its figure is. */
function labelled(label: string, value: string): string {
	const theme = clioTheme();
	return `${theme.fg("annotation", label)} ${value}`;
}

/** Two column blocks beside each other, or stacked when the page is narrow. */
function columns(left: string[], right: string[], width: number): string[] {
	if (width < FOOTER_SPLIT_COLUMNS) return [...left, ...right];
	const leftWidth = Math.floor((width - 3) / 2);
	return zipColumns(left, right, leftWidth, width - leftWidth - 3, "   ");
}

/**
 * Activity: what is running. The harness phase and the live figures on the
 * first row, the session's totals and the task board on the second, then one
 * table row per worker, live runs first, so the question is answered before
 * the page scrolls. Finished runs stop at {@link ACTIVITY_HISTORY_ROWS} and
 * each live run keeps its detail below the table.
 */
/** Finished runs the page lists; the Fleet Runs board has the rest. */
const ACTIVITY_HISTORY_ROWS = 4;

/**
 * What the table row has no column for: the route the run is on, whose account
 * it draws from, the task once progress has taken the row's activity cell, and
 * what the worker just did, which a fast tool call would otherwise take off
 * the page before anyone reads it.
 */
function liveWorkerDetail(row: DispatchBoardRow, width: number, quota: QuotaProviders): string[] {
	const theme = clioTheme();
	const field = (label: string, value: string): string[] =>
		wrapTextWithAnsi(`${theme.fg("annotation", `${label}  `)}${clean(value)}`, width);
	const internal = row.agentAudience === "shadow" || row.agentAudience === "internal";
	const weekly = routeWeeklyQuota(row, quota);
	return [
		sectionRule(theme, width, clean(row.agentId), { meta: internal ? "internal agent" : "fleet agent" }),
		...field("Route", `${row.targetId}/${row.wireModelId}`),
		...(weekly ? field("Account", `Shared ${weekly.account} · ${weekly.label}`) : []),
		...(row.progress && row.taskSummary ? field("Task", row.taskSummary) : []),
		...renderDispatchActivity(row, width),
		...field("Inspect", `/view dispatch:${row.runId}`),
	];
}

/**
 * The session's measured tokens. A bound such as `≥~13.1k +?` is true but unreadable on this row, so the footer states
 * what was measured, as the receipt and the turn row do, and points at /usage when nothing was.
 */
function sessionTokens(theme: ClioTheme, measured: string | null, width: number): string {
	if (measured === null)
		return theme.fg("annotation", width < 60 ? "usage not measured" : "session usage not measured (/usage)");
	// Cost and never-sent share this row, so a narrow page keeps the figure and `tok`.
	return theme.fg("counter", width < 60 ? `${measured} tok` : `session ${measured} tokens`);
}

/**
 * The tool tally as one chip that fits its row: the registered count gives way first, so a narrow page keeps what ran
 * and what failed. At 40 columns `tools 8 available · bash 1 · 1 failed` wrapped and lost `failed` below the fold.
 */
function toolChip(tally: string, width: number): string {
	const room = Math.max(1, width - 2 - visibleWidth("tools "));
	if (visibleWidth(tally) <= room) return tally;
	const called = tally.replace(/^\d+ available · /u, "");
	return called.length > 0 ? called : tally;
}

/** A settled rate says which call it belongs to; beside `last turn` it read as a live figure. */
function lastCallThroughput(state: FooterDashboardRenderState): string | null {
	const figures = formattedThroughput(clioTheme(), state.throughput, state.telemetry);
	return figures === null ? null : labelled("last call", figures);
}

function activityPage(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();
	const streaming = state.status.phase !== "idle" && state.status.phase !== "ended";
	const lastTurn = state.agent.lastTurn;
	const contextWork = state.agent.contextActivity;
	// The headline and the session row wrap between whole chips rather than give
	// the tail up to an ellipsis: the last chip is the one that did not fit the
	// row's end, and dropping it left free width beside a `…` that hid a fact.
	const headline = chipRows(
		theme,
		[
			// Idle has one name, the rail's `is ready` two rows down; `◌ Idle` here was a third (HS01). With nothing running
			// the row leads with the last turn, or says there has been none.
			state.status.phase === "idle" && (state.toolCounts.active ?? 0) <= 0
				? lastTurn
					? null
					: theme.fg("counter", "no turn yet")
				: buildHarnessStatePill(theme, state.status, state.toolCounts, state.tick, state.now, Math.max(width, 40)),
			contextWork
				? theme.fg(
						contextWork.status === "failed" ? "error" : contextWork.status === "completed" ? "success" : "activity",
						`${GLYPH.phaseCompact} ${clean(contextWork.message)}`,
					)
				: null,
			...(state.background ?? []).map((call) =>
				theme.fg(
					"activity",
					`${call.purpose} on ${modelNickname(call.model)} · ${formatCompactMs(state.now - call.startedAt)}`,
				),
			),
			streaming ? formattedThroughput(theme, state.throughput, undefined) : null,
			streaming ? liveTokenValue(theme, state.throughput, state.telemetry, state.context.used) : null,
			!streaming && lastTurn ? labelled("last turn", lastTurnOutcome(theme, lastTurn)) : null,
			!streaming && lastTurn ? lastTurnDetails(theme, lastTurn, state.telemetry) : null,
			!streaming ? lastCallThroughput(state) : null,
		],
		width,
	);
	const tools = meaningfulToolTally(state.agent.toolTally);
	const board = state.agent.taskBoard;
	const spend = state.telemetry;
	const session = chipRows(
		theme,
		[
			...(spend.kind === "unavailable"
				? [theme.fg("unknownValue", "spend not available")]
				: spend.kind === "reading"
					? [theme.fg("unknownValue", "reading the call journal")]
					: [
							spend.tokens === null && spend.neverSent === null
								? null
								: sessionTokens(theme, spend.tokens === null ? "0" : spend.measuredTokens, width),
							spend.neverSent ? theme.fg("counter", spend.neverSent) : null,
							// A bare `not measured` beside the token count read as the tokens' own qualifier.
							spend.cost === null
								? null
								: theme.fg("counter", /^[≥~]*\$/u.test(spend.cost) ? spend.cost : `cost ${spend.cost}`),
						]),
			tools === null ? null : labelled("tools", theme.fg("counter", toolChip(clean(tools), width))),
			ceilingChip(state),
		],
		width,
	);
	// The board keeps a row of its own, because at the tail of the session row its blocked count was the first thing cut.
	const tasks =
		board && board.tasks.length > 0
			? [
					chipRow(theme, [labelled("tasks", taskBoardValue(theme, board)), activeTaskLine(theme, board)], width),
					...blockedTaskLines(theme, board, width),
				]
			: [];
	const rows = workerRowsOf(state.dispatchRows);
	const active = rows.filter((row) => ACTIVE_DISPATCH_STATUSES.has(row.status));
	const done = rows.filter((row) => row.status === "completed");
	// A run someone stopped did not fail: `12 failed` sat over rows that each read `⊘ cancelled`.
	const cancelled = rows.filter((row) => row.status === "aborted");
	const failed = rows.filter((row) => FAILED_DISPATCH_STATUSES.has(row.status) && row.status !== "aborted");
	const counts = [
		active.length > 0 ? `${active.length} active` : null,
		done.length > 0 ? `${done.length} done` : null,
		failed.length > 0 ? `${failed.length} failed` : null,
		cancelled.length > 0 ? `${cancelled.length} cancelled` : null,
	]
		.filter((part): part is string => part !== null)
		.join(" · ");
	// Runs from before this Clio started are history: `12 cancelled` beside an exit card's `0 workers` read as this visit's.
	const pastOnly = rows.length > 0 && rows.every((row) => row.earlier === true);
	const capacity = state.agent.localCapacity;
	const cap = capacity ? `cap ${capacity.limit} · ${capacity.bound}` : "";
	const meta = [pastOnly ? `earlier sessions · ${counts}` : counts, cap].filter(Boolean).join(" · ");
	const liveNotices = state.notices.filter((notice) => notice.presentation !== "setting");
	const notices = formatNotificationPanel(liveNotices, width, {
		maxRows: liveNotices.length,
		ended: state.endedNotices ?? [],
		now: state.now,
		...(state.dismissKeyLabel ? { dismissKeyLabel: state.dismissKeyLabel } : {}),
		theme,
	});
	const lines = [
		...headline,
		...session,
		...tasks,
		...notices,
		contextLine(state, width),
		sectionRule(theme, width, "Workers", { ...(meta ? { meta } : {}) }),
	];
	if (rows.length === 0) {
		lines.push(
			...emptyState(theme, "No workers yet.", width, {
				remedy: "Rows appear here as agents start; /run starts one.",
			}),
		);
		return lines;
	}
	const history = rows.filter((row) => !ACTIVE_DISPATCH_STATUSES.has(row.status));
	const listed = history.slice(0, ACTIVITY_HISTORY_ROWS);
	lines.push(
		...runTableRows(dispatchBoardItems([...active, ...listed]), width, {
			compact: true,
			inspectFinished: true,
			tick: state.tick,
			now: state.now,
			quota: state.quota ?? [],
		}),
	);
	// How a run ended can be longer than the activity column, and it is the row's whole point.
	// One row each: the cause in the run's own words, without the worker's stderr dump, and where the rest is.
	for (const row of listed) {
		// A run the operator cancelled already says so in its row; only a cause beyond that earns a line.
		if (row.status !== "completed" && row.outcomeDetail && !/^operator abort\b/u.test(row.outcomeDetail)) {
			const where = ` · /view dispatch:${row.runId}`;
			const cause =
				clean(row.outcomeDetail)
					.split(/;\s*stderr:/u)[0]
					?.trim() ?? "";
			const lead = `${clean(row.agentId)}: ${cause}`;
			const room = Math.max(8, width - visibleWidth(where));
			lines.push(theme.fg("annotation", `${truncateToWidth(lead, room, GLYPH.ellipsis, false)}${where}`));
		}
	}
	if (listed.length < history.length) {
		const boardKey = actionKeyLabel("clio-coder.dispatchBoard.toggle") ?? "/fleet";
		lines.push(
			theme.fg("annotation", `${history.length - listed.length} more finished runs · ${boardKey} for full history`),
		);
	}
	for (const row of active) lines.push(...liveWorkerDetail(row, width, state.quota ?? []));
	return lines;
}

/** The longest bar a page meter draws; past this a wide terminal gets room, not resolution. */
const PAGE_METER_CELLS = 48;

/** `label ━━━━━━──── 62%` for a page meter whose tone names the limit it approaches. */
function pageMeter(label: string, value: number | null, max: number, width: number, amount?: string): string {
	const theme = clioTheme();
	if (value === null || !Number.isFinite(value)) {
		return `${theme.fg("fieldName", label)} ${theme.fg("unknownValue", "warming up")}`;
	}
	const ratio = max > 0 ? value / max : 0;
	const tone: Tone | "meter" = ratio >= 0.95 ? "error" : ratio >= 0.8 ? "warning" : "meter";
	const shown = amount ?? `${Math.round(ratio * 100)}%`;
	const capped = Math.min(width, visibleWidth(label) + 1 + PAGE_METER_CELLS + 1 + visibleWidth(shown));
	return meter(theme, { label, value, max, width: capped, tone, amount: shown });
}

/**
 * The dashboard's one context line: the category meter with its figure when the
 * ledger is known, the budget's own figure otherwise. `/context` has the rest.
 */
function contextLine(state: FooterDashboardRenderState, width: number): string {
	const theme = clioTheme();
	const ledger = state.context.ledger;
	const facts = state.context;
	// The budget's own figure, which a live session has beside its ledger.
	const budgetFigure = (): string => {
		const used = facts.used;
		const window = facts.contextWindow;
		const percent = used !== null && window ? (used / window) * 100 : null;
		return `${contextUsageText(facts)} ${theme.fg("metricUnit", "tokens")}${
			percent === null ? "" : ` · ${theme.fg(contextPercentRole(percent), formatContextPercent(percent))}`
		}`;
	};
	if (!ledger) {
		const window = facts.contextWindow;
		if (!window) return `${theme.fg("fieldName", "context")} ${theme.fg("unknownValue", "window unknown")}`;
		// A known window with no input figure yet is not an unknown window.
		return facts.used === null
			? `${theme.fg("fieldName", "context")} ${budgetFigure()}`
			: pageMeter("context", facts.used, window, width, budgetFigure());
	}
	const figure = facts.budget
		? budgetFigure()
		: `${theme.fg("metricValue", `${formatFooterTokens(ledger.usedTokens)} / ${ledger.contextWindow > 0 ? formatFooterTokens(ledger.contextWindow) : "unknown"}`)}${
				ledger.percent === null
					? ""
					: ` · ${theme.fg(contextPercentRole(ledger.percent), formatContextPercent(ledger.percent))}`
			}`;
	const barCells = Math.max(4, width - visibleWidth(figure) - 2);
	// Every live session has a budget beside its ledger: the figure is the budget's, the categories the ledger's.
	return `${renderContextMeterBar(ledger, barCells, theme)}  ${figure}`;
}

/** Whole-session spend across every branch (#434 §11.3, decision A). */
function sessionSpendChips(telemetry: FooterTelemetry): string[] {
	const theme = clioTheme();
	if (telemetry.kind === "unavailable") return [theme.fg("unknownValue", "spend not available")];
	if (telemetry.kind === "reading") return [theme.fg("unknownValue", "reading the call journal")];
	return [
		labelled(
			"session",
			telemetry.tokens !== null && telemetry.measuredTokens === null
				? theme.fg("unknownValue", "usage not measured (/usage)")
				: `${theme.fg("metricValue", telemetry.measuredTokens ?? "0")} ${theme.fg("metricUnit", "tokens")}`,
		),
		theme.fg("metricValue", telemetry.cost ?? "nothing charged yet"),
		...(telemetry.neverSent ? [theme.fg("warning", telemetry.neverSent)] : []),
	];
}

/** The session cost ceiling beside the spend on the dashboard's session row; `/usage` has the rest. */
function ceilingChip(state: FooterDashboardRenderState): string {
	const theme = clioTheme();
	return labelled(
		"ceiling",
		theme.fg(
			"counter",
			state.costCeilingUsd === undefined
				? "unknown"
				: state.costCeilingUsd === 0
					? "none"
					: `${renderUsdLimit(state.costCeilingUsd)} tracked pricing only`,
		),
	);
}

/**
 * The local machine: CPU, memory, GPU, network and disk, as the Health tab of
 * `/usage` shows them while it samples.
 */
export function machineBlock(resource: LocalMachineMetrics | null, now: number, width: number): string[] {
	const theme = clioTheme();
	const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
	const mib = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
	const throughput = (value: number) =>
		value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB/s` : `${(value / 1024).toFixed(1)} KiB/s`;
	const value = (text: string): string =>
		theme.fg(
			/^(unknown|unreported|unavailable|not sampled|sampling|warming up|pending|not available|not reported)/u.test(text)
				? "unknownValue"
				: "fieldValue",
			clean(text),
		);
	const facts = (entries: ReadonlyArray<readonly [string, string]>, room: number): string[] =>
		factRows(
			theme,
			entries.map(([label, text]) => ({ label, value: value(text), fit: "clip" as const })),
			room,
			{ labelWidth: 14 },
		);
	const half = Math.floor((width - 3) / 2);
	const cpu = pageMeter("CPU", resource ? resource.cpuPercent : null, 100, width >= FOOTER_SPLIT_COLUMNS ? half : width);
	const ramUsed = resource ? resource.hostTotalBytes - resource.hostFreeBytes : null;
	const ram = resource
		? pageMeter(
				"RAM",
				ramUsed,
				resource.hostTotalBytes,
				width >= FOOTER_SPLIT_COLUMNS ? width - half - 3 : width,
				`${Math.round(((ramUsed ?? 0) / resource.hostTotalBytes) * 100)}% ${theme.fg("fieldValue", `${gib(ramUsed ?? 0)} / ${gib(resource.hostTotalBytes)}`)}`,
			)
		: pageMeter("RAM", null, 100, width);
	const gpu = resource?.gpu
		? resource.gpu.busyPercent === null
			? `${theme.fg("fieldName", "GPU")} ${value(
					`${resource.gpu.name} · load unavailable${
						resource.gpu.usedBytes != null && resource.gpu.totalBytes != null
							? ` · ${gib(resource.gpu.usedBytes)} / ${gib(resource.gpu.totalBytes)}`
							: ""
					}`,
				)}`
			: pageMeter(
					`GPU ${clean(resource.gpu.name)}`,
					resource.gpu.busyPercent,
					100,
					width >= FOOTER_SPLIT_COLUMNS ? half : width,
					`${resource.gpu.busyPercent}%${
						resource.gpu.usedBytes != null && resource.gpu.totalBytes != null
							? ` ${theme.fg("fieldValue", `${gib(resource.gpu.usedBytes)} / ${gib(resource.gpu.totalBytes)}`)}`
							: ""
					}`,
				)
		: `${theme.fg("fieldName", "GPU")} ${value("unavailable on this OS/driver")}`;
	const rss = `${theme.fg("fieldName", "Clio RSS")} ${resource ? theme.fg("fieldValue", mib(resource.processRssBytes)) : value("sampling")}`;
	const machine = [
		sectionRule(theme, width, "Machine", {
			meta: resource
				? `${resource.scope} · sampled ${Math.max(0, Math.round((now - resource.sampledAt) / 1000))}s ago`
				: "local OS · sampling",
		}),
		...columns([cpu], [ram], width),
		...columns([gpu], [rss], width),
		...facts(
			[
				[
					"Network",
					resource?.network
						? `${resource.network.name} ${GLYPH.down} ${throughput(resource.network.receivedPerSecond)} ${GLYPH.up} ${throughput(resource.network.sentPerSecond)}`
						: "warming up / unavailable",
				],
				[
					"Disk I/O",
					resource?.disk
						? `${resource.disk.name} R ${throughput(resource.disk.readPerSecond)} W ${throughput(resource.disk.writtenPerSecond)}`
						: "warming up / unavailable",
				],
				["Sampling", resource ? "every 2s" : "pending"],
				["Scope", `${resource?.scope ?? "local OS"} · busiest interface/disk · local only`],
			],
			width,
		),
	];

	return machine;
}

/**
 * As many whole names as fit `room` after `prefix`, closing on `…` when some
 * did not; the first name is cut only when it alone does not fit.
 */
function fitNames(prefix: string, names: readonly string[], room: number): string {
	for (let kept = names.length; kept > 0; kept -= 1) {
		const candidate = `${prefix}${names.slice(0, kept).join(", ")}${kept < names.length ? GLYPH.ellipsis : ""}`;
		if (visibleWidth(candidate) <= room) return candidate;
	}
	return truncateToWidth(`${prefix}${names[0] ?? ""}`, Math.max(1, room), GLYPH.ellipsis);
}

/**
 * The autonomous window beside the hints: `412/600 calls · 38/120 min · 1.9M/5M tok`, the nearest cap alone when
 * narrow, and the way back once it has paused.
 */
function autonomyWindowFact(theme: ClioTheme, status: AutonomyStatus, narrow: boolean): string {
	if (status.halted !== null) {
		return theme.fg("warning", narrow ? "yolo paused" : `yolo paused ${GLYPH.dot} Enter continues`);
	}
	const { caps, usage } = status;
	const minutes = Math.floor(usage.activeMs / 60_000);
	const meters = [
		{ used: usage.toolCalls, cap: caps.toolCalls, text: `${usage.toolCalls}/${caps.toolCalls} calls` },
		{ used: minutes, cap: caps.minutes, text: `${minutes}/${caps.minutes} min` },
		{
			used: usage.tokens,
			cap: caps.tokens,
			text: `${formatFooterTokens(usage.tokens)}/${formatFooterTokens(caps.tokens)} tok`,
		},
	].filter((meter) => meter.cap > 0);
	if (meters.length === 0) return "";
	const nearest = meters.reduce((best, meter) => (meter.used / meter.cap > best.used / best.cap ? meter : best));
	const shown = narrow ? [nearest] : meters;
	return theme.fg(
		nearest.used / nearest.cap >= 0.8 ? "warning" : "counter",
		shown.map((meter) => meter.text).join(` ${GLYPH.dot} `),
	);
}

/** The widest stats a row carries, `272K/272K (100.0%) · last 999 tok/s`. */
const STATS_RESERVE_WIDTH = 35;

/** Workspace and counts above; notices and active harness facts below. */
export function renderCompactDashboard(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();
	const w = Math.max(1, width);
	const style = state.outputStyle ?? "standard";
	const minimal = style === "compact";
	const learning = !minimal && state.demo !== false;
	const autonomy = state.session.autonomy;
	const narrow = w <= 60;
	// Contained yolo is the warning tone; the unconfined opt-out is the error tone and shouts (ob-yolo D9).
	const unconfined = autonomy === "yolo" && state.session.yoloConfinement === "unconfined";
	// Contained with no OS sandbox backend keeps only the judge and the floor, and says so (D9).
	const unsandboxed = autonomy === "yolo" && !unconfined && state.session.autonomyWindow?.osSandbox === false;
	const mode = autonomy
		? autonomy === "yolo"
			? theme.fg(
					unconfined ? "error" : "warning",
					unconfined
						? `YOLO ${GLYPH.dot} UNCONFINED`
						: unsandboxed
							? narrow
								? `YOLO ${GLYPH.dot} no sandbox`
								: `YOLO ${GLYPH.dot} contained (no OS sandbox)`
							: `YOLO ${GLYPH.dot} contained`,
				)
			: theme.fg("annotation", clean(autonomy))
		: "";
	const modeLead = mode ? `${mode}${theme.fg("separator", ` ${GLYPH.dot} `)}` : "";
	const identityWidth = Math.max(1, w - visibleWidth(modeLead));
	const fit = (text: string, room = w) =>
		theme.base("counter", truncateToWidth(text, Math.max(1, room), GLYPH.ellipsis, true));
	const separator = theme.fg("separator", ` ${GLYPH.dot} `);
	const counter = compactContextUsage(state.context, theme, Math.floor(w * 0.4));
	// The streaming turn's live rate, else the newest settled main call's from the read model (#434).
	const newest = state.throughput ? null : state.telemetry.kind === "ready" ? state.telemetry.speed : null;
	// A rate read back from a resumed session, or left by the route the session moved off, says nothing about the next
	// call. It stays on the Activity page, labelled as the last call, and leaves this row until a call settles here (J1-F3).
	const settled =
		newest !== null &&
		state.context.budget?.historical !== true &&
		newest.targetId === (state.session.targetId ?? newest.targetId) &&
		newest.modelId === (state.session.modelId ?? newest.modelId)
			? newest
			: null;
	const rate = state.throughput ? state.throughput.tokensPerSecond : settled?.tokensPerSecond;
	const estimated = state.throughput ? state.throughput.estimated === true : settled?.estimated === true;
	// A rate is live only while tokens are arriving; during a tool the turn's figure is as historical as a settled call's (HF03).
	const flowing = state.throughput !== null && (state.status.phase === "writing" || state.status.phase === "thinking");
	const speed =
		typeof rate === "number" && Number.isFinite(rate) && rate > 0
			? `${flowing ? "" : theme.fg("annotation", "last ")}${metricText(theme, `${estimated ? "≈" : ""}${rate >= 10 ? Math.round(rate) : Math.round(rate * 10) / 10}`, "tok/s")}`
			: "";
	// The row's one separator: a `|` beside the `·` of the workspace read as a table rule with nothing under it (F3).
	const metrics = [counter, speed].filter(Boolean).join(separator);
	const statsCap = Math.floor(identityWidth * 0.4);
	const values = !minimal && visibleWidth(metrics) <= statsCap ? metrics : counter;
	// Once a figure shows, the stats column keeps its widest width (and the dirty
	// marker its two columns) whatever the turn adds or drops, so the path's cut
	// point stays where it was. With no figure yet the path has the whole row.
	const valueWidth = values === "" ? 0 : Math.min(statsCap, Math.max(visibleWidth(values), STATS_RESERVE_WIDTH));
	const workspaceWidth = Math.max(1, valueWidth === 0 ? identityWidth : identityWidth - valueWidth - 3);
	// Until the first probe lands the branch is unknown, not absent: say nothing.
	// A detached HEAD is still a repository: name the commit rather than claim there is no branch to speak of.
	const unnamed =
		state.workspace.detachedAt !== undefined ? `detached at ${state.workspace.detachedAt}` : "no Git branch";
	const named = state.workspace.branchPending ? "" : clean(state.workspace.branch ?? unnamed);
	const dirtyMarker = state.workspace.dirty ? theme.fg("warning", " *") : "  ";
	const gitRoom = Math.max(4, Math.floor(workspaceWidth * 0.3));
	// A branch name may lose its middle; the sentence that says there is none is whole or absent (`no Gi…ranch`).
	const git = state.workspace.branch == null && visibleWidth(named) + visibleWidth(dirtyMarker) > gitRoom ? "" : named;
	const gitWidth = git === "" ? 0 : Math.min(visibleWidth(git) + visibleWidth(dirtyMarker), gitRoom);
	const cwdWidth = git === "" ? workspaceWidth : Math.max(1, workspaceWidth - gitWidth - 3);
	const cwdLabel = theme.fg("workspacePath", fitPathLabel(clean(state.workspace.cwd), cwdWidth));
	const workspace =
		git === ""
			? cwdLabel
			: `${cwdLabel}${separator}${theme.fg("branch", fitIdentityLabel(git, Math.max(1, gitWidth - visibleWidth(dirtyMarker))))}${dirtyMarker}`;
	const statsGap = " ".repeat(Math.max(0, valueWidth - visibleWidth(values)));
	const firstRow = fit(
		modeLead +
			(valueWidth === 0
				? fit(workspace, workspaceWidth)
				: `${fit(workspace, workspaceWidth)}   ${statsGap}${fit(values, valueWidth - statsGap.length)}`),
	);

	const feedback = topNotification(
		state.notices.filter((notice) => notice.presentation === "setting"),
		state.now,
	);
	const keyContext = state.keyContext ?? "send";
	const surfaceOwnsKeys = keyContext === "surface";
	// The keys that answer this moment, which a tip must not cover and a notice may.
	const immediateKeys = keyContext !== "surface" && keyContext !== "idle" && keyContext !== "send";
	// A tip is teaching for the idle composer. Under a card or an overlay, or while
	// a run holds the keys, the slot stays with what applies; a real notice still shows.
	const liveNotices = state.notices.filter(
		(entry) =>
			entry.presentation !== "setting" && !((surfaceOwnsKeys || immediateKeys) && entry.text.startsWith("tip: ")),
	);
	const notice = topNotification(liveNotices, state.now);
	const otherNotices = notice
		? liveNotices.filter((entry) => entry !== notice && (entry.expiresAt === null || entry.expiresAt > state.now)).length
		: 0;
	const key = actionKeyLabel("clio-coder.status.toggle") ?? "Dashboard";
	const leaderKey = formatKeyLabel(getKeybindings().getKeys("clio-coder.leader")[0], "");
	const urgent = state.session.shutdownArmed
		? typeof state.session.shutdownArmed === "string"
			? state.session.shutdownArmed
			: "Ctrl+C again to quit"
		: // The leader also opens the action menu, whose own rail lists the keys: a second legend under it said `choose key`
			// for a choice already on screen.
			state.session.leaderArmed && !surfaceOwnsKeys
			? leaderKey
				? `${leaderKey} ${GLYPH.next} choose key`
				: "Choose key"
			: null;
	const liveWorkers = workerRowsOf(state.dispatchRows).filter((row) => ACTIVE_DISPATCH_STATUSES.has(row.status));
	const queuedWorkers = liveWorkers.filter((row) => row.status === "enqueued").length;
	const workers = liveWorkers.length - queuedWorkers;
	const plans = state.dispatchRows.filter((row) => row.plan !== undefined && row.status === "running").length;
	const skills = state.session.activeSkills ?? [];
	const weekly = state.quotaRoute ? routeWeeklyQuota(state.quotaRoute, state.quota ?? []) : null;
	// Idle and off say nothing: the line names memory only while it works or cannot.
	const guardian = state.session.memoryIntervention?.guardian;
	// The rail names a memory call from its first moment, with route and elapsed.
	const memoryOnRail = (state.background ?? []).some((call) => call.purpose === "memory review");
	const memoryFact =
		guardian === "reviewing"
			? memoryOnRail
				? ""
				: theme.fg("activity", "memory reviewing")
			: // Memory yields the model to the turn on purpose and nothing waits on it, so its wait says nothing: `memory waits`
				// beside a retry read as a second fault (N9), and in the hint row as a cryptic third party.
				guardian === "unavailable"
				? theme.fg("unknownValue", "memory review paused")
				: "";
	const facts = [
		autonomy === "yolo" && state.session.autonomyWindow
			? autonomyWindowFact(theme, state.session.autonomyWindow, narrow)
			: "",
		!minimal && state.session.name ? theme.fg("footerIdentity", clean(state.session.name)) : "",
		!minimal && state.session.duckBadge ? theme.fg("counter", "🦆") : "",
		workers ? theme.fg("activity", `${workers} ${workers === 1 ? "worker" : "workers"}`) : "",
		queuedWorkers ? theme.fg("annotation", `${queuedWorkers} queued`) : "",
		plans ? theme.fg("activity", `${plans} ${plans === 1 ? "plan" : "plans"}`) : "",
		memoryFact,
		skills.length
			? `${theme.fg("skillAction", "skill ")}${theme.fg("counter", fitNames("", skills.map(clean), Math.max(8, Math.floor(w / 3))))}`
			: "",
		weekly && (!minimal || weekly.severity === "critical")
			? theme.fg(
					weekly.severity === "critical" ? "error" : weekly.severity === "normal" ? "counter" : "warning",
					weekly.label,
				)
			: "",
		...(state.extensionFacts ?? []),
		...(style === "detailed"
			? [
					theme.fg("annotation", outputStyleLabel(style)),
					...(state.telemetry.kind === "ready" ? sessionSpendChips(state.telemetry) : []),
				]
			: []),
	]
		.filter(Boolean)
		.join(separator);
	const tail = facts;
	const silence = state.silenceNotes ?? null;
	const silenceNote = silence?.find((form) => visibleWidth(form) <= w) ?? silence?.at(-1) ?? null;
	// A narrow footer drops its idle hint row, but never the silence note that row exists to carry (HS16).
	if (narrow && !immediateKeys && !urgent && !notice && !feedback && !facts && silenceNote === null) return [firstRow];
	const alone = urgent !== null || silenceNote !== null || !tail;
	// A wide footer gives its facts half the row, so two extension statuses both fit beside the key hints.
	const tailWidth = alone ? 0 : Math.min(Math.floor(w * (w >= 100 ? 0.5 : 0.4)), visibleWidth(tail));
	const room = alone ? w : w - tailWidth - 3;
	// The controls that answer this moment. A notice has its own row above them, so it never takes their place.
	const controls = urgent
		? theme.fg("warning", urgent)
		: silenceNote !== null
			? theme.fg("warning", silenceNote)
			: feedback
				? theme.fg("changedValue", clean(feedback.text))
				: surfaceOwnsKeys
					? ""
					: learning && state.demoHint && !immediateKeys && !notice
						? `${theme.fg("guidance", "Tip")} ${theme.fg("counter", clean(state.demoHint))}`
						: theme.fg(
								"keyboardHint",
								state.welcomeVisible
									? ""
									: (footerKeyHint(state.now, narrow, room, keyContext, {
											...state.keyHintFacts,
											learning,
										}) ?? ""),
							);
	const row = (text: string): string => (alone ? fit(text) : fit(`${fit(text, room)}   ${fit(tail, tailWidth)}`));
	const hasControls = visibleWidth(controls) > 0;
	if (!notice) return !hasControls && !tail ? [firstRow] : [firstRow, row(controls)];
	// A narrow footer spends no row on hints it cannot fit, so there the notice keeps the shared row it always had;
	// only a quit or leader prompt outranks it.
	if (narrow)
		return [
			firstRow,
			row(urgent ? controls : renderNoticeRow(theme, notice, otherNotices, room, key, state.dismissKeyLabel)),
		];
	const noticeRow = renderNoticeRow(theme, notice, otherNotices, w, key, state.dismissKeyLabel);
	const hintRow = row(controls);
	// With nothing else to say on the hint row, the notice keeps the one row it always had.
	if (!hasControls && !tail) return [firstRow, noticeRow];
	return [firstRow, noticeRow, hintRow];
}

/**
 * The top notice on its own row: severity glyph and text first, then how to read the rest and how to clear it.
 * One line flattens a multi-line notice and cuts the end, where a remediation command sits, so the row names the
 * key that opens the dashboard, whose notice panel wraps the full text.
 */
function renderNoticeRow(
	theme: ClioTheme,
	notice: Notification,
	otherNotices: number,
	width: number,
	dashboardKey: string,
	dismissKeyLabel: string | undefined,
): string {
	const body = `${notificationGlyph(notice.level)} ${clean(notice.text)}`;
	const message = theme.fg(notificationToken(notice.level), body);
	const cut = otherNotices > 0 || notice.text.includes("\n") || visibleWidth(body) > width;
	const dismiss =
		dismissKeyLabel && !dismissKeyLabel.startsWith("unbound") ? `${dismissKeyLabel.split(" · ").at(-1)} dismiss` : "";
	const more = cut ? `${dashboardKey} ${otherNotices > 0 ? `+${otherNotices} more` : "more"}` : "";
	const actions = [more, dismiss].filter(Boolean).join(" · ");
	const actionText = actions ? theme.fg("keyboardHint", ` ${actions}`) : "";
	// A narrow row keeps the notice itself; the keys only ride along when the notice keeps enough room to read.
	const fitted = (cells: number): string => theme.fg(notificationToken(notice.level), fitNoticeWords(body, cells));
	if (!actionText || width - visibleWidth(actionText) < 24) return fitted(width);
	const room = width - visibleWidth(actionText);
	const shown = visibleWidth(body) <= room ? message : fitted(room);
	const gap = " ".repeat(Math.max(0, room - visibleWidth(shown)));
	return `${shown}${gap}${actionText}`;
}

/**
 * A notice cut to its row at a word boundary: `the whole prompt is r…` left a fragment where the next word was. A
 * cut that would lose more than a third of the row to reach a space keeps the plain cut.
 */
function fitNoticeWords(text: string, width: number): string {
	const room = Math.max(1, width);
	if (visibleWidth(text) <= room) return text;
	const cut = truncateToWidth(text, room, "", false);
	const space = cut.lastIndexOf(" ");
	const whole = space >= Math.ceil(room * 0.66) ? cut.slice(0, space).replace(/[\s·:;,]+$/u, "") : null;
	return whole === null ? truncateToWidth(text, room, GLYPH.ellipsis, false) : `${whole}${GLYPH.ellipsis}`;
}

/**
 * The expanded footer: one glance page. Title row, rule, a bounded content viewport, rule, hint.
 * Height is a function of the terminal alone, so a page never changes height
 * as its live values change; content that does not fit scrolls.
 */
export function dashboardPageViewport(
	state: FooterDashboardRenderState,
	width: number,
	terminalRows: number,
	toggleKey: string,
	scrollOffset = 0,
): { rows: string[]; offset: number; maxOffset: number } {
	const theme = clioTheme();
	const safeWidth = Math.max(1, width);
	const gutter = safeWidth >= 20 ? 2 : 0;
	const innerWidth = Math.max(1, safeWidth - gutter * 2);
	const pad = " ".repeat(gutter);
	const inset = (line: string): string =>
		theme.base(
			"fieldValue",
			padAnsi(`${pad}${truncateToWidth(line, innerWidth, GLYPH.ellipsis, true)}${pad}`, safeWidth),
		);
	// A glance, not a standing view: the transcript keeps two thirds of the terminal, and the workers list scrolls.
	const budget = Math.max(6, Math.min(8, Math.floor(terminalRows / 3)));
	// The rule keeps the brand from reading as part of the title.
	const tabText = `${brandMark(theme)} ${theme.fg("border", GLYPH.rail)} ${theme.style("selectedOption", "Dashboard", { bold: true })}`;
	// The route sits flush right, the way a title row carries its meta, so the
	// tabs and the identity read as one row with two ends rather than a sentence.
	const identityRoom = innerWidth - visibleWidth(tabText) - 4;
	const identity = `${state.session.duckBadge ? "🦆 " : ""}${clean(state.session.target ?? "No model selected")}`;
	const identityText = identityRoom >= 20 ? theme.fg("footerIdentity", fitIdentityLabel(identity, identityRoom)) : "";
	const heading =
		identityText.length > 0
			? `${tabText}${" ".repeat(Math.max(1, innerWidth - visibleWidth(tabText) - visibleWidth(identityText)))}${identityText}`
			: truncateToWidth(tabText, innerWidth, GLYPH.ellipsis, true);
	const cycle = `${toggleKey || "Dashboard"} ${GLYPH.next} close`;
	const where = "/context · /usage · /fleet for detail";
	const available = budget - 4;
	let content = activityPage(state, innerWidth);
	content = content.flatMap((line) => (visibleWidth(line) > innerWidth ? wrapTextWithAnsi(line, innerWidth) : [line]));
	const maxOffset = Math.max(0, content.length - available);
	const offset = Math.max(0, Math.min(maxOffset, Math.floor(scrollOffset)));
	const hint =
		maxOffset > 0
			? positionRow(
					theme,
					{
						start: offset + 1,
						end: Math.min(content.length, offset + available),
						total: content.length,
						keys: innerWidth >= 64 ? ["Alt+PgUp/PgDn scroll", cycle, where] : [cycle],
					},
					innerWidth,
				)
			: truncateToWidth(theme.fg("keyboardHint", `${cycle}   ·   ${where}`), innerWidth, GLYPH.ellipsis, true);
	content = content.slice(offset, offset + available);
	while (content.length < available) content.push("");
	return {
		rows: [inset(heading), rule(theme, safeWidth), ...content.map(inset), rule(theme, safeWidth), inset(hint)],
		offset,
		maxOffset,
	};
}

export function renderDashboardPage(
	state: FooterDashboardRenderState,
	width: number,
	terminalRows: number,
	toggleKey: string,
	scrollOffset = 0,
): string[] {
	return dashboardPageViewport(state, width, terminalRows, toggleKey, scrollOffset).rows;
}
