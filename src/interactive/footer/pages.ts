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

import { renderUsdLimit } from "../../core/telemetry/render.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { redactSecretString } from "../../domains/safety/redaction.js";
import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { contextCategorySwatch, contextPercentRole, renderContextMeterBar } from "../context-meter.js";
import type { DispatchBoardRow } from "../dispatch-board.js";
import { dispatchBoardItems, renderDispatchActivity, runTableRows } from "../dispatch-board.js";
import { ACTIVE_DISPATCH_STATUSES, FAILED_DISPATCH_STATUSES, formatFooterTokens } from "../footer-panel.js";
import { formatKeyLabel } from "../keybinding-manager.js";
import type { QuotaProviders } from "../quota-view.js";
import { quotaAccountRows, routeWeeklyQuota } from "../quota-view.js";
import {
	brandMark,
	chipRow,
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
import { fitIdentityLabel, modelNickname } from "../theme/labels.js";
import type { FooterDashboardRenderState } from "./dashboard.js";
import { footerKeyHint } from "./key-hints.js";
import { formatNotificationPanel, notificationGlyph, notificationToken, topNotification } from "./notifications.js";
import type { FooterTelemetry } from "./spend.js";
import {
	activeTaskLine,
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

export const DASHBOARD_PAGES = ["Activity", "Context", "Status"] as const;
export type DashboardPage = (typeof DASHBOARD_PAGES)[number];
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

/** `≥~888.9k +?` in words: a lower bound, estimated in part, with calls that reported nothing. */
function sessionTokens(display: string, width: number): string {
	const partial = display.endsWith(" +?");
	const figure = partial ? display.slice(0, -3) : display;
	// Cost and never-sent share this row, so a narrow page keeps the figure and `tok`; `≥` still says it is a floor.
	if (width < 60) return `${figure} tok`;
	const worded = figure.replace(/^≥~?/u, (mark) => (mark.endsWith("~") ? "at least ~" : "at least "));
	return `session ${worded} tokens${partial ? ", some calls unknown" : ""}`;
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
	const headline = chipRow(
		theme,
		[
			buildHarnessStatePill(theme, state.status, state.toolCounts, state.tick, state.now, Math.max(width, 40)),
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
	const session = chipRow(
		theme,
		[
			...(spend.kind === "unavailable"
				? [theme.fg("unknownValue", "spend not available")]
				: spend.kind === "reading"
					? [theme.fg("unknownValue", "reading the call journal")]
					: [
							spend.tokens === null && spend.neverSent === null
								? null
								: theme.fg("counter", sessionTokens(spend.tokens ?? "0", width)),
							spend.neverSent ? theme.fg("counter", spend.neverSent) : null,
							spend.cost === null ? null : theme.fg("counter", spend.cost),
						]),
			board && board.tasks.length > 0 ? labelled("tasks", taskBoardValue(theme, board)) : null,
			board ? activeTaskLine(theme, board) : null,
			tools === null ? null : labelled("tools", theme.fg("counter", clean(tools))),
		],
		width,
	);
	const rows = workerRowsOf(state.dispatchRows);
	const active = rows.filter((row) => ACTIVE_DISPATCH_STATUSES.has(row.status));
	const done = rows.filter((row) => row.status === "completed");
	const failed = rows.filter((row) => FAILED_DISPATCH_STATUSES.has(row.status));
	const meta = [
		active.length > 0 ? `${active.length} active` : null,
		done.length > 0 ? `${done.length} done` : null,
		failed.length > 0 ? `${failed.length} failed` : null,
	]
		.filter((part): part is string => part !== null)
		.join(" · ");
	const liveNotices = state.notices.filter((notice) => notice.presentation !== "setting");
	const notices = formatNotificationPanel(liveNotices, width, {
		maxRows: liveNotices.length,
		ended: state.endedNotices ?? [],
		now: state.now,
		...(state.dismissKeyLabel ? { dismissKeyLabel: state.dismissKeyLabel } : {}),
		theme,
	});
	const lines = [headline, session, ...notices, sectionRule(theme, width, "Workers", { ...(meta ? { meta } : {}) })];
	if (rows.length === 0) {
		lines.push(
			...emptyState(theme, "No workers yet.", width, {
				remedy: "Rows appear here as agents start; /run or /delegate starts one.",
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
	for (const row of listed) {
		if (row.status !== "completed" && row.outcomeDetail) {
			lines.push(
				...wrapTextWithAnsi(
					theme.fg("annotation", `${clean(row.agentId)}: ${clean(row.outcomeDetail)} · /view dispatch:${row.runId}`),
					width,
				),
			);
		}
	}
	if (listed.length < history.length) {
		const boardKey =
			getKeybindings()
				.getKeys("clio-coder.dispatchBoard.toggle")
				.map((key) => formatKeyLabel(key))
				.join("/") || "Workers shortcut";
		lines.push(
			theme.fg("annotation", `${history.length - listed.length} more finished runs · ${boardKey} for full history`),
		);
	}
	for (const row of active) lines.push(...liveWorkerDetail(row, width, state.quota ?? []));
	return lines;
}

/** The longest bar a page meter draws; past this a wide terminal gets room, not resolution. */
const PAGE_METER_CELLS = 48;
/** A legend column wider than this puts its numbers too far from their labels to read as one row. */
const LEGEND_COLUMN_MAX = 52;

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
 * Context: how full the window is. The category meter with its figure on the
 * first row, the headroom facts on the second, then the composition with its
 * numbers aligned and the cache facts beneath.
 */
function contextPage(state: FooterDashboardRenderState, width: number): string[] {
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
	const budgetBar = (): string => {
		const window = facts.contextWindow;
		if (!window) return `${theme.fg("fieldName", "context")} ${theme.fg("unknownValue", "window unknown")}`;
		// A known window with no input figure yet is not an unknown window.
		return facts.used === null
			? `${theme.fg("fieldName", "context")} ${budgetFigure()}`
			: pageMeter("context", facts.used, window, width, budgetFigure());
	};
	if (!ledger) {
		return [
			budgetBar(),
			chipRow(
				theme,
				[
					facts.compactionThreshold === null
						? null
						: labelled(
								"compaction",
								`${facts.compactionAuto ? "auto" : "manual"} @${Math.round(facts.compactionThreshold * 100)}%`,
							),
					facts.clioMd ? theme.fg("counter", facts.clioMd) : null,
					facts.memory ? theme.fg("counter", facts.memory) : null,
					facts.extensions && facts.extensions.installed > 0
						? labelled("extensions", `${facts.extensions.active}/${facts.extensions.installed}`)
						: null,
					facts.budget ? theme.fg("annotation", `${facts.budget.inputSource} accounting`) : null,
				],
				width,
			),
			...emptyState(theme, "Detailed context accounting appears after the prompt is compiled.", width),
		];
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
	const bar = `${renderContextMeterBar(ledger, barCells, theme)}  ${figure}`;
	const compaction =
		ledger.contextWindow <= 0
			? "on server overflow"
			: ledger.compactionAuto
				? `auto${ledger.compactionThreshold === null ? "" : ` @${Math.round(ledger.compactionThreshold * 100)}%`}`
				: "manual";
	const headroom = chipRow(
		theme,
		[
			labelled("free", theme.fg("counter", ledger.contextWindow > 0 ? formatFooterTokens(ledger.freeTokens) : "unknown")),
			ledger.reserveTokens > 0 ? labelled("reserve", theme.fg("counter", formatFooterTokens(ledger.reserveTokens))) : null,
			labelled("compaction", theme.fg("counter", compaction)),
		],
		width,
	);
	// Where the figures came from is a second thought, so it takes the second row.
	const provenance = chipRow(
		theme,
		[
			labelled("tools", theme.fg("counter", String(ledger.toolCount))),
			theme.fg("annotation", ledger.measured ? "provider-anchored" : "estimated"),
			facts.budget && (ledger.measured || facts.budget.inputSource !== "estimated")
				? theme.fg("annotation", `${facts.budget.inputSource} input`)
				: null,
			ledger.contextWindowSource ? theme.fg("annotation", `${ledger.contextWindowSource} window`) : null,
		],
		width,
	);
	const groups = ledger.meter.filter((group) => group.tokens > 0);
	// Swatch, label, tokens and percent: `▰ Tool results    31k  11.8%`, the
	// numbers right-aligned in fixed cells so the column reads down.
	const legend = (entries: typeof groups, room: number): string[] => {
		const labelWidth = Math.max(4, room - 2 - 2 - 7 - 2 - 6);
		return entries.map((group) => {
			const label = padAnsi(theme.fg("legend", group.label), labelWidth);
			const tokens = formatFooterTokens(group.tokens).padStart(7);
			const percent = (group.percent === null ? "?" : `${group.percent.toFixed(1)}%`).padStart(6);
			return `${contextCategorySwatch(group.category, theme)} ${label}  ${theme.fg("counter", tokens)}  ${theme.fg(group.percent === null ? "unknownValue" : "counter", percent)}`;
		});
	};
	const half = Math.ceil(groups.length / 2);
	const composition =
		width >= FOOTER_SPLIT_COLUMNS
			? columns(
					legend(groups.slice(0, half), Math.min(LEGEND_COLUMN_MAX, Math.floor((width - 3) / 2))),
					legend(groups.slice(half), Math.min(LEGEND_COLUMN_MAX, width - Math.floor((width - 3) / 2) - 3)),
					width,
				)
			: legend(groups, Math.min(LEGEND_COLUMN_MAX, width));
	const out = [
		bar,
		headroom,
		provenance,
		sectionRule(theme, width, facts.budget ? "Capture diagnostics" : "Composition", {
			meta: "/context for detail",
		}),
		...composition,
	];
	const journaled = state.telemetry.kind === "ready" ? state.telemetry.promptCache : null;
	const cache = chipRow(
		theme,
		[
			journaled ? labelled("cache read", theme.fg("counter", journaled.read)) : null,
			journaled ? labelled("write", theme.fg("counter", journaled.write)) : null,
			journaled ? labelled("uncached", theme.fg("counter", journaled.uncached)) : null,
			journaled ? labelled("backend", theme.fg("counter", journaled.verdict)) : null,
			ledger.promptCache
				? labelled("shell", theme.fg("counter", ledger.promptCache.shellReused ? "reused" : "rebuilt"))
				: null,
		],
		width,
	);
	if (cache.length > 0) out.push(cache);
	const history = chipRow(
		theme,
		[
			ledger.lastCompaction
				? labelled(
						"last compaction",
						theme.fg(
							"counter",
							`${formatFooterTokens(ledger.lastCompaction.tokensBefore)} ${GLYPH.next} ${formatFooterTokens(ledger.lastCompaction.tokensAfter)} · ${clean(ledger.lastCompaction.trigger)}`,
						),
					)
				: null,
			ledger.prewarm
				? labelled(
						"prewarm",
						theme.fg(
							"counter",
							`${ledger.prewarm.tokens === null ? "tokens unreported" : `${formatFooterTokens(ledger.prewarm.tokens)} tokens`} in ${formatCompactMs(ledger.prewarm.ms)}${ledger.prewarm.aborted ? " · interrupted" : ""}`,
						),
					)
				: null,
		],
		width,
	);
	if (history.length > 0) out.push(history);
	out.push(theme.fg("annotation", "Context is per request · subscription limits are account-wide · /usage"));
	const key = [
		"Filled = context · empty = available · shaded = reserve; small buckets receive one cell.",
		"Filled = context · empty = available · shaded = reserve",
		`${GLYPH.contextFull} used · ${GLYPH.contextFree} free · ${GLYPH.contextReserve} reserve`,
	].find((text) => visibleWidth(text) <= width);
	if (key !== undefined) out.push(theme.fg("annotation", key));
	return out;
}

/** Whole-session spend across every branch (#434 §11.3, decision A). */
function sessionSpendChips(telemetry: FooterTelemetry): string[] {
	const theme = clioTheme();
	if (telemetry.kind === "unavailable") return [theme.fg("unknownValue", "spend not available")];
	if (telemetry.kind === "reading") return [theme.fg("unknownValue", "reading the call journal")];
	return [
		labelled("session", `${theme.fg("metricValue", telemetry.tokens ?? "0")} ${theme.fg("metricUnit", "tokens")}`),
		theme.fg("metricValue", telemetry.cost ?? "nothing charged yet"),
		...(telemetry.neverSent ? [theme.fg("warning", telemetry.neverSent)] : []),
	];
}

function trackedCost(telemetry: FooterTelemetry): string {
	if (telemetry.kind === "unavailable") return "not available";
	if (telemetry.kind === "reading") return "reading";
	return telemetry.cost ?? "nothing charged yet";
}

/** Guardian wording for the expanded memory row; null leaves the step outcome showing. */
function guardianLabel(
	state: "off" | "idle" | "reviewing" | "waiting-capacity" | "unavailable" | undefined,
): string | null {
	switch (state) {
		case "reviewing":
			return "reviewing";
		case "waiting-capacity":
			return "waiting for endpoint capacity";
		case "unavailable":
			return "model tier unavailable";
		default:
			return null;
	}
}

/**
 * Status: what the session costs and what the machine is doing. Spend and the
 * shared account limits lead, because they are the figures that run out; the
 * local machine, the worker cap and the connections follow.
 */
function statusPage(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();
	const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
	const mib = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
	const throughput = (value: number) =>
		value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB/s` : `${(value / 1024).toFixed(1)} KiB/s`;
	const resource = state.resources;
	const capacity = state.agent.localCapacity;
	const memory = state.session.memoryIntervention;
	const workerRows = workerRowsOf(state.dispatchRows);
	const active = workerRows.filter((row) => ACTIVE_DISPATCH_STATUSES.has(row.status)).length;
	const completed = workerRows.filter((row) => row.status === "completed").length;
	const failed = workerRows.filter((row) => FAILED_DISPATCH_STATUSES.has(row.status)).length;
	const toolCalls = Object.values(state.toolCounts.tools).reduce((a, b) => a + b, 0);
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

	const spend = chipRow(
		theme,
		[
			...sessionSpendChips(state.telemetry),
			labelled(
				"ceiling",
				theme.fg(
					"counter",
					state.costCeilingUsd === undefined
						? "unknown"
						: state.costCeilingUsd === 0
							? "none"
							: `${renderUsdLimit(state.costCeilingUsd)} tracked pricing only`,
				),
			),
		],
		width,
	);
	const accounts = quotaAccountRows(state.quota ?? [], width, { compact: true, now: state.now });

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
				? `${resource.scope} · sampled ${Math.max(0, Math.round((state.now - resource.sampledAt) / 1000))}s ago`
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

	const workers = [
		sectionRule(theme, width, "Workers", {
			meta: capacity ? `cap ${capacity.limit} · ${capacity.bound}` : "cap not sampled",
		}),
		...factRows(
			theme,
			[
				{
					label: "Workers",
					value: chipRow(
						theme,
						[
							theme.fg(active > 0 ? "activity" : "counter", `${active} active`),
							theme.fg("counter", `${completed} done`),
							theme.fg(failed > 0 ? "error" : "counter", `${failed} failed`),
						],
						Number.POSITIVE_INFINITY,
					),
				},
				{ label: "Worker cap", value: value(capacity ? `${capacity.limit} · ${capacity.bound}` : "not sampled") },
				{
					label: "Tool calls",
					value: value(
						`${toolCalls} ${toolCalls === 1 ? "call" : "calls"} · ${state.toolCounts.active ?? 0} active · ${state.toolCounts.errors} failed`,
					),
				},
			],
			width,
			{ labelWidth: 14 },
		),
	];

	const names = (items: string[] | undefined) =>
		items === undefined ? "unreported" : items.length ? `${items.length} · ${items.join(", ")}` : "none";
	const left: Array<readonly [string, string]> = [
		...(state.session.name ? [["Session", clean(state.session.name)] as const] : []),
		["Target", state.session.target ?? "No model selected"],
		["Tracked cost", trackedCost(state.telemetry)],
		["MCP connected", names(state.connections?.mcp)],
		["Plugins active", names(state.connections?.plugins)],
		[
			"Extensions",
			state.context.extensions
				? `${state.context.extensions.active} active / ${state.context.extensions.installed} installed`
				: "unreported",
		],
	];
	const right: Array<readonly [string, string]> = [
		[
			"Memory bank",
			memory
				? `${memory.size} entries · ${guardianLabel(memory.guardian) ?? (memory.stepInFlight ? "updating" : (memory.lastDecision ?? "idle"))}`
				: "not reported",
		],
		["Context work", state.agent.contextActivity?.message ?? "idle"],
		[
			"Headroom",
			state.context.ledger?.contextWindow
				? `${formatFooterTokens(state.context.ledger.freeTokens)} tokens free`
				: "unknown",
		],
	];
	const connections = [
		sectionRule(theme, width, "Connections"),
		...columns(
			facts(left, width >= FOOTER_SPLIT_COLUMNS ? half : width),
			facts(right, width >= FOOTER_SPLIT_COLUMNS ? width - half - 3 : width),
			width,
		),
	];
	return [spend, ...accounts, ...workers, ...machine, ...connections];
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

/** The widest stats a row carries, `272K/272K (100.0%) | last 999 tps`. */
const STATS_RESERVE_WIDTH = 33;

/** Workspace and counts above; notices and active harness facts below. */
export function renderCompactDashboard(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();
	const w = Math.max(1, width);
	const narrow = w <= 60;
	const fit = (text: string, room = w) =>
		theme.base("counter", truncateToWidth(text, Math.max(1, room), GLYPH.ellipsis, true));
	const separator = theme.fg("border", " · ");
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
			? `${flowing ? "" : theme.fg("annotation", "last ")}${metricText(theme, `${estimated ? "≈" : ""}${rate >= 10 ? Math.round(rate) : Math.round(rate * 10) / 10}`, "tps")}`
			: "";
	const metrics = [counter, speed].filter(Boolean).join(theme.fg("border", " | "));
	const statsCap = Math.floor(w * 0.4);
	const values = visibleWidth(metrics) <= statsCap ? metrics : counter;
	// Once a figure shows, the stats column keeps its widest width (and the dirty
	// marker its two columns) whatever the turn adds or drops, so the path's cut
	// point stays where it was. With no figure yet the path has the whole row.
	const valueWidth = values === "" ? 0 : Math.min(statsCap, Math.max(visibleWidth(values), STATS_RESERVE_WIDTH));
	const workspaceWidth = Math.max(1, valueWidth === 0 ? w : w - valueWidth - 3);
	// Until the first probe lands the branch is unknown, not absent: say nothing.
	const git = state.workspace.branchPending ? "" : clean(state.workspace.branch ?? "no Git branch");
	const dirtyMarker = state.workspace.dirty ? theme.fg("warning", " *") : "  ";
	const gitWidth =
		git === ""
			? 0
			: Math.min(visibleWidth(git) + visibleWidth(dirtyMarker), Math.max(4, Math.floor(workspaceWidth * 0.3)));
	const cwdWidth = git === "" ? workspaceWidth : Math.max(1, workspaceWidth - gitWidth - 3);
	const cwdLabel = theme.fg("workspacePath", fitIdentityLabel(clean(state.workspace.cwd), cwdWidth));
	const workspace =
		git === ""
			? cwdLabel
			: `${cwdLabel}${separator}${theme.fg("branch", fitIdentityLabel(git, Math.max(1, gitWidth - visibleWidth(dirtyMarker))))}${dirtyMarker}`;
	const statsGap = " ".repeat(Math.max(0, valueWidth - visibleWidth(values)));
	const firstRow = fit(
		valueWidth === 0
			? fit(workspace, workspaceWidth)
			: `${fit(workspace, workspaceWidth)}   ${statsGap}${fit(values, valueWidth - statsGap.length)}`,
	);

	const feedback = topNotification(
		state.notices.filter((notice) => notice.presentation === "setting"),
		state.now,
	);
	const keyContext = state.keyContext ?? "send";
	const surfaceOwnsKeys = keyContext === "surface";
	// The keys that answer this moment, which a tip must not cover and a notice may.
	const immediateKeys = keyContext === "steer" || keyContext === "hold" || keyContext === "shell";
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
	const key =
		getKeybindings()
			.getKeys("clio-coder.status.toggle")
			.map((key) => formatKeyLabel(key))
			.join("/") || "Dashboard";
	const leaderKey = formatKeyLabel(getKeybindings().getKeys("clio-coder.leader")[0], "");
	const urgent = state.session.shutdownArmed
		? typeof state.session.shutdownArmed === "string"
			? state.session.shutdownArmed
			: "Ctrl+C again to quit"
		: state.session.leaderArmed
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
				: theme.fg("activity", "mem reviewing")
			: guardian === "waiting-capacity"
				? theme.fg("warning", "mem waiting")
				: guardian === "unavailable"
					? theme.fg("unknownValue", "mem unavailable")
					: "";
	const facts = [
		state.session.name ? theme.fg("footerIdentity", clean(state.session.name)) : "",
		state.session.duckBadge ? theme.fg("counter", "🦆") : "",
		workers ? theme.fg("activity", `${workers} ${workers === 1 ? "worker" : "workers"}`) : "",
		queuedWorkers ? theme.fg("annotation", `${queuedWorkers} queued`) : "",
		plans ? theme.fg("activity", `${plans} ${plans === 1 ? "plan" : "plans"}`) : "",
		memoryFact,
		skills.length
			? `${theme.fg("skillAction", "skill ")}${theme.fg("counter", fitNames("", skills.map(clean), Math.max(8, Math.floor(w / 3))))}`
			: "",
		weekly
			? theme.fg(
					weekly.severity === "critical" ? "error" : weekly.severity === "normal" ? "counter" : "warning",
					weekly.label,
				)
			: "",
		...(state.extensionFacts ?? []),
	]
		.filter(Boolean)
		.join(separator);
	const tail = notice && feedback ? theme.fg("changedValue", clean(feedback.text)) : facts;
	if (narrow && !urgent && !notice && !feedback && !facts) return [firstRow];
	const alone = urgent !== null || !tail;
	const tailWidth = alone ? 0 : Math.min(Math.floor(w * 0.4), visibleWidth(tail));
	const room = alone ? w : w - tailWidth - 3;
	const message = urgent
		? theme.fg("warning", urgent)
		: notice
			? theme.fg(notificationToken(notice.level), `${notificationGlyph(notice.level)} ${clean(notice.text)}`)
			: feedback
				? theme.fg("changedValue", clean(feedback.text))
				: surfaceOwnsKeys
					? ""
					: state.demoHint && !state.welcomeVisible && !immediateKeys
						? `${theme.fg("guidance", "Tip")} ${theme.fg("counter", clean(state.demoHint))}`
						: theme.fg(
								"keyboardHint",
								state.welcomeVisible
									? ""
									: ((state.demo !== false ? footerKeyHint(state.now, narrow, room, keyContext) : null) ?? `${key} Dashboard`),
							);
	// One line flattens a multi-line notice and cuts the end, which is where a
	// remediation command sits. Name the key that opens the dashboard, whose
	// notice panel wraps the full text.
	const more = theme.fg("keyboardHint", ` ${key} ${otherNotices > 0 ? `+${otherNotices} more` : "more"}`);
	// A narrow row keeps the notice itself; the hint only rides along when
	// the notice keeps enough room to stay readable.
	const clipped =
		room - visibleWidth(more) >= 24 &&
		!urgent &&
		notice !== undefined &&
		(otherNotices > 0 ||
			notice.text.includes("\n") ||
			visibleWidth(`${notificationGlyph(notice.level)} ${clean(notice.text)}`) > room);
	const line = clipped ? `${fit(message, Math.max(1, room - visibleWidth(more)))}${more}` : message;
	if (alone) return [firstRow, fit(line)];
	return [firstRow, fit(`${fit(line, room)}   ${fit(tail, tailWidth)}`)];
}

/**
 * The expanded footer: tab row, rule, a bounded content viewport, rule, hint.
 * Height is a function of the terminal alone, so a page never changes height
 * as its live values change; content that does not fit scrolls.
 */
export function dashboardPageViewport(
	state: FooterDashboardRenderState,
	page: DashboardPage,
	width: number,
	terminalRows: number,
	cycleKey: string,
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
	const budget = Math.max(6, Math.min(12, terminalRows - 6));
	const tabs = DASHBOARD_PAGES.map((name, index) =>
		name === page
			? theme.style("selectedOption", `${GLYPH.cursor} ${index + 1} ${name}`, { bold: true })
			: theme.fg("menuOption", `  ${index + 1} ${name}`),
	);
	// The rule keeps the brand from reading as part of whichever tab sits first.
	const brand = `${brandMark(theme)} ${theme.fg("border", GLYPH.rail)} `;
	const tabText =
		innerWidth >= 52
			? `${brand}${tabs.join(" ")}`
			: `${brand}${theme.style("selectedOption", `${GLYPH.cursor} ${page}`, { bold: true })} ${theme.fg("positionCount", `${DASHBOARD_PAGES.indexOf(page) + 1}/${DASHBOARD_PAGES.length}`)}`;
	// The route sits flush right, the way a title row carries its meta, so the
	// tabs and the identity read as one row with two ends rather than a sentence.
	const identityRoom = innerWidth - visibleWidth(tabText) - 4;
	const identity = `${state.session.duckBadge ? "🦆 " : ""}${clean(state.session.target ?? "No model selected")}`;
	const identityText = identityRoom >= 20 ? theme.fg("footerIdentity", fitIdentityLabel(identity, identityRoom)) : "";
	const heading =
		identityText.length > 0
			? `${tabText}${" ".repeat(Math.max(1, innerWidth - visibleWidth(tabText) - visibleWidth(identityText)))}${identityText}`
			: truncateToWidth(tabText, innerWidth, GLYPH.ellipsis, true);
	const next = page === "Status" ? "close" : DASHBOARD_PAGES[DASHBOARD_PAGES.indexOf(page) + 1];
	const cycle = `${cycleKey || "Dashboard"} ${GLYPH.next} ${next}`;
	const where = page === "Status" ? "/usage · /health · /context" : "composer stays active";
	const available = budget - 4;
	let content: string[];
	if (page === "Activity") content = activityPage(state, innerWidth);
	else if (page === "Context") content = contextPage(state, innerWidth);
	else content = statusPage(state, innerWidth);
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
						keys: innerWidth >= 64 ? ["Alt+PgUp/PgDn scroll", cycle] : [cycle],
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
	page: DashboardPage,
	width: number,
	terminalRows: number,
	cycleKey: string,
	scrollOffset = 0,
): string[] {
	return dashboardPageViewport(state, page, width, terminalRows, cycleKey, scrollOffset).rows;
}
