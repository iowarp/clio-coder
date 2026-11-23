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

import { clioBuildLabel } from "../../core/build-info.js";
import { presentationTier, tierPolicy } from "../../core/presentation-tier.js";
import { COST_NOT_MEASURED, renderUsdLimit } from "../../core/telemetry/render.js";
import { autonomyModeReadout, autonomyWindowReadout } from "../../domains/safety/autonomy-readout.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { redactSecretString } from "../../domains/safety/redaction.js";
import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { tokensPerSecondText } from "../../session-control/assistant-generation-timing.js";
import { contextPercentRole, renderContextMeterBar } from "../context-meter.js";
import type { DispatchBoardRow } from "../dispatch-board.js";
import { dispatchBoardItems, renderDispatchActivity, runTableRows } from "../dispatch-board.js";
import { ACTIVE_DISPATCH_STATUSES, FAILED_DISPATCH_STATUSES, formatFooterTokens } from "../footer-panel.js";
import { actionKeyLabel, formatKeyLabel } from "../keybinding-manager.js";
import type { QuotaProviders } from "../quota-view.js";
import {
	bindingQuotaWindow,
	bindingWindowPart,
	linkedQuotaAccounts,
	quotaWaitWords,
	routeWeeklyQuota,
} from "../quota-view.js";
import {
	brandMark,
	type ClioTheme,
	type ClioToken,
	chipRow,
	chipRows,
	clioTheme,
	emptyState,
	factRows,
	fitSides,
	formatContextPercent,
	formatElapsed,
	GLYPH,
	meter,
	metricText,
	padAnsi,
	positionRow,
	rule,
	type SideUnit,
	sectionRule,
	type Tone,
} from "../theme/index.js";
import { fitIdentityLabel, fitPathLabel, modelNickname } from "../theme/labels.js";
import { economyReceipt } from "../usage-words.js";
import type { FooterDashboardRenderState } from "./dashboard.js";
import { footerKeyHint } from "./key-hints.js";
import {
	formatNotificationPanel,
	type Notification,
	notificationGlyph,
	notificationToken,
	topNotification,
} from "./notifications.js";
import type { LocalMachineMetrics } from "./system-metrics.js";
import {
	activeTaskLine,
	blockedTaskLines,
	buildHarnessStatePill,
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
	// A retry the provider's limit caused waits on a quota window; it names the one that binds, or says none is known.
	const waiting =
		row.status === "retrying" && row.retry && QUOTA_RETRY.test(row.retry.reason)
			? quotaWaitWords(
					bindingQuotaWindow(
						linkedQuotaAccounts(quota, { runtimeIds: [row.runtimeId], targetIds: [row.targetId], node: row.node }),
					),
					Date.now(),
				)
			: null;
	return [
		sectionRule(theme, width, clean(row.agentId), { meta: internal ? "internal agent" : "fleet agent" }),
		...field("Route", `${row.targetId}/${row.wireModelId}`),
		...(weekly ? field("Account", `Shared ${weekly.account} · ${weekly.label}`) : []),
		...(waiting ? field("Waiting", waiting) : []),
		...(row.progress && row.taskSummary ? field("Task", row.taskSummary) : []),
		...renderDispatchActivity(row, width),
		...field("Inspect", `/view dispatch:${row.runId}`),
	];
}

const QUOTA_RETRY = /rate[- ]?limit|quota|usage limit|\b429\b/iu;

/**
 * The session's receipt as chips: the binding window of the account the main route draws on first, then the extra
 * cost, seat credits and API equivalent, each the S10 projection's own words. A part with an unknown keeps the neutral
 * tone. A declared fee is never a chip here: it belongs to its period, not to a turn or a session row.
 */
function receiptChips(theme: ClioTheme, state: FooterDashboardRenderState): string[] {
	const spend = state.telemetry;
	if (spend.kind !== "ready" || !spend.economy) return [];
	const binding = state.quotaRoute
		? bindingQuotaWindow(
				linkedQuotaAccounts(state.quota ?? [], {
					runtimeIds: [state.quotaRoute.runtimeId],
					targetIds: spend.economyTargets ?? [],
					node: state.quotaRoute.node,
				}),
			)
		: null;
	return economyReceipt(spend.economy, binding === null ? null : bindingWindowPart(binding, state.now)).map((part) =>
		theme.fg(part.unknown ? "unknownValue" : "counter", part.text),
	);
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
					`${call.purpose} on ${modelNickname(call.model)} · ${formatElapsed(state.now - call.startedAt)}`,
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
			...receiptChips(theme, state),
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
	// The auto maximum's bound is named "cap"; `cap 8 · cap` read as a row cut mid-word.
	const cap = capacity ? `cap ${capacity.limit} · ${capacity.bound === "cap" ? "built-in max" : capacity.bound}` : "";
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
	const rss = `${theme.fg("fieldName", "CLIO Coder RSS")} ${resource ? theme.fg("fieldValue", mib(resource.processRssBytes)) : value("sampling")}`;
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

/** Terminal rows under this are height class H1, where every tier keeps only the status line (4.2). */
const FOOTER_H1_ROWS = 20;
/** Measured cells under this are width class W1, where every tier keeps only the status line (4.2). */
const FOOTER_W1_CELLS = 44;
/** At or under this width the hint row offers no learning beside the keys that answer the moment. */
const FOOTER_NARROW_CELLS = 60;
/** The notice keeps at least this much of its row before the keys to read the rest ride beside it. */
const NOTICE_MIN_CELLS = 24;
/** A yolo window with less than this left is an alert on the notice row, whatever its meters say. */
const WINDOW_ENDING_MS = 5 * 60_000;

/**
 * The status line's reduction order (4.2), first to go first. Facts beyond the row's own (session name, memory,
 * skills, the weekly and yolo windows while neither is an alert, extension facts) go first. The cwd elides its leading
 * directories (`~/…/proj/x`), session cost goes, then the cwd shortens to its project and its basename, the target
 * goes, the queued count, the word `default`, the branch, the cwd and the workers count. Contained yolo then shortens
 * to `YOLO`. The mark and a non-default autonomy never drop. The model id never drops either; its form is chosen
 * before the fit (`footerStatusLine`). `default` goes before the branch because default autonomy is implied by its
 * absence, while the branch is a fact the row has nowhere else.
 */
const STATUS_RANK = {
	aux: 0,
	auxShort: 0.25,
	/** The yolo window's meters outlast the other extra facts: they bound what runs unattended. */
	windowDrop: 0.4,
	cwdElide: 0.5,
	cost: 1,
	cwdShort: 2,
	target: 3,
	queued: 4,
	autonomyWord: 5,
	branch: 6,
	cwd: 7,
	workers: 8,
	autonomyShort: 9,
	modelElide: 10,
} as const;
const MODEL_ID_MIN_CELLS = 12;

/**
 * The cwd from its fullest form to its basename. `fitPathLabel` cuts at directory boundaries; asking it for one cell
 * less than the last form yields the next `~/…/` form, kept while two directories remain (`~/…/proj/standard`). The
 * project with its parent (`proj/standard`) and the basename (`standard`) follow.
 */
function pathForms(path: string): string[] {
	const parts = path.split("/");
	const root = parts[0] === "~" ? "~/" : parts[0] === "" ? "/" : "";
	const segments = parts.slice(root === "" ? 0 : 1).filter((part) => part.length > 0);
	const lead = `${root}${GLYPH.ellipsis}/`;
	const forms = [path];
	for (let width = visibleWidth(path) - 1; width > 0; ) {
		const form = fitPathLabel(path, width);
		if (!form.includes("/") || visibleWidth(form) > width) break;
		if (form.startsWith(lead) && form.slice(lead.length).split("/").length >= 2) forms.push(form);
		width = visibleWidth(form) - 1;
	}
	if (segments.length >= 2) forms.push(segments.slice(-2).join("/"));
	const base = segments.at(-1);
	if (base !== undefined) forms.push(base);
	return [...new Set(forms)];
}

/**
 * The leading chips that fit `width` whole. A chip that does not fit is absent with every chip after it; none is cut
 * and nothing marks the cut, because a `…` at the row's end hid a fact behind a mark.
 */
function wholeChips(theme: ClioTheme, chips: ReadonlyArray<string | null>, width: number): string {
	const separator = theme.fg("separator", ` ${GLYPH.sep} `);
	let row = "";
	for (const chip of chips) {
		if (chip === null || chip.length === 0) continue;
		const next = row === "" ? chip : `${row}${separator}${chip}`;
		if (visibleWidth(next) > width) break;
		row = next;
	}
	return row;
}

const COMPACT_COUNT = /^(\d+(?:\.\d+)?)([kmgb]?)$/iu;
const COUNT_SCALE: Readonly<Record<string, number>> = { "": 1, k: 1e3, m: 1e6, g: 1e9, b: 1e9 };

/** A measured compact count back to its number; an estimate, a bound or an unknown is no figure to divide. */
function countValue(text: string): number | null {
	const match = COMPACT_COUNT.exec(text.replaceAll(",", ""));
	if (!match) return null;
	const scale = COUNT_SCALE[(match[2] ?? "").toLowerCase()];
	return scale === undefined ? null : Number(match[1]) * scale;
}

/** `cache 87%`: the newest main call's prompt read from cache, stated only when every part was measured. */
function cacheShare(cache: { read: string; write: string; uncached: string } | null): string | null {
	if (cache === null) return null;
	const read = countValue(cache.read);
	const write = countValue(cache.write);
	const uncached = countValue(cache.uncached);
	if (read === null || write === null || uncached === null) return null;
	const prompt = read + write + uncached;
	return prompt > 0 ? `cache ${Math.round((read / prompt) * 100)}%` : null;
}

/**
 * The newest rate the session can stand behind: the streaming turn's, else the newest settled main call's when it ran
 * on the session's route. A rate read back from a resumed session, or left by a route the session moved off, says
 * nothing about the next call (J1-F3); it stays on the dashboard labelled as the last call.
 */
function footerRate(state: FooterDashboardRenderState): { speed: string | null; ttft: string | null } {
	const newest = state.throughput ? null : state.telemetry.kind === "ready" ? state.telemetry.speed : null;
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
	return {
		speed:
			typeof rate === "number" && Number.isFinite(rate) && rate > 0
				? `${flowing ? "" : "last "}${tokensPerSecondText(rate, estimated)} tok/s`
				: null,
		ttft: settled?.ttft ?? null,
	};
}

interface FooterCounts {
	workers: number;
	queued: number;
	plans: number;
}

/**
 * The status line: where on the left (the mark, autonomy, cwd, branch), what runs on the right (worker counts, session
 * cost, target, model id), fitted by {@link fitSides} so a unit drops or shortens whole and the model id never moves.
 */
function footerStatusLine(
	state: FooterDashboardRenderState,
	theme: ClioTheme,
	width: number,
	routeFacts: boolean,
	counts: FooterCounts,
	aux: ReadonlyArray<SideUnit>,
): string {
	const left: SideUnit[] = [{ text: GLYPH.brand, paint: () => brandMark(theme), lead: true }];
	const autonomy = state.session.autonomy ?? "default";
	/** Cells a non-default autonomy keeps at its shortest, with its space after the mark. */
	let autonomyFloor = 0;
	if (autonomy === "yolo") {
		const confinement = state.session.yoloConfinement === "unconfined" ? "unconfined" : "contained";
		const osSandbox = state.session.autonomyWindow?.osSandbox !== false;
		const wide = autonomyModeReadout({ confinement, osSandbox, narrow: false, dot: GLYPH.dot });
		const short = autonomyModeReadout({ confinement, osSandbox, narrow: true, dot: GLYPH.dot }).text;
		// Contained yolo ends as `YOLO`; an unconfined or unsandboxed session keeps the words that say so.
		const last = confinement === "contained" && osSandbox ? "YOLO" : short;
		const forms = [...new Set([short, last])].filter((form) => form !== wide.text);
		autonomyFloor = 1 + visibleWidth(last);
		left.push({
			text: wide.text,
			paint: (text) => theme.fg(wide.tone, text),
			shorter: forms.map((text) => ({ text, rank: STATUS_RANK.autonomyShort })),
		});
	} else {
		left.push({
			text: clean(autonomy),
			paint: (text) => theme.fg("annotation", text),
			// Default autonomy is implied by its absence; any other keeps its word.
			...(autonomy === "default" ? { drop: STATUS_RANK.autonomyWord } : {}),
		});
		if (autonomy !== "default") autonomyFloor = 1 + visibleWidth(clean(autonomy));
	}
	const paths = pathForms(clean(state.workspace.cwd));
	// Compact starts from the project and its parent; standard and up from the whole path.
	const cwdForms = routeFacts ? paths : paths.slice(Math.max(0, paths.length - 2));
	left.push({
		text: cwdForms[0] ?? clean(state.workspace.cwd),
		paint: (text) => theme.fg("workspacePath", text),
		// `~/…/` forms elide leading directories before the cost drops; the project and basename forms come after it.
		shorter: cwdForms.slice(1).map((text) => ({
			text,
			rank: text.includes(`${GLYPH.ellipsis}/`) ? STATUS_RANK.cwdElide : STATUS_RANK.cwdShort,
		})),
		drop: STATUS_RANK.cwd,
	});
	// Until the first probe lands the branch is unknown, not absent: say nothing. A detached HEAD is still a repository:
	// name the commit rather than claim there is no branch. A sentence is whole or absent (`no Gi…ranch`).
	const unnamed =
		state.workspace.detachedAt !== undefined ? `detached at ${state.workspace.detachedAt}` : "no Git branch";
	const branch = state.workspace.branchPending ? "" : clean(state.workspace.branch ?? unnamed);
	if (branch !== "") {
		// The dirty mark belongs to a named branch or commit, never to the sentence that says there is none.
		const dirty =
			state.workspace.dirty === true && (state.workspace.branch != null || state.workspace.detachedAt !== undefined);
		left.push({
			text: `${branch}${dirty ? "*" : ""}`,
			paint: (text) =>
				dirty ? `${theme.fg("branch", text.slice(0, -1))}${theme.fg("warning", "*")}` : theme.fg("branch", text),
			drop: STATUS_RANK.branch,
		});
	}

	const right: SideUnit[] = [...aux];
	const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
	if (counts.workers > 0)
		right.push({
			text: count(counts.workers, "worker", "workers"),
			paint: (text) => theme.fg("activity", text),
			drop: STATUS_RANK.workers,
		});
	if (counts.plans > 0)
		right.push({
			text: count(counts.plans, "plan", "plans"),
			paint: (text) => theme.fg("activity", text),
			drop: STATUS_RANK.workers,
		});
	if (routeFacts && counts.queued > 0)
		right.push({
			text: `${counts.queued} queued`,
			paint: (text) => theme.fg("annotation", text),
			drop: STATUS_RANK.queued,
		});
	const spend = state.telemetry;
	// The owner's display string, and only for an amount the session contributed: an unpriced route shows no unit.
	if (routeFacts && spend.kind === "ready" && spend.cost !== null && spend.cost !== COST_NOT_MEASURED)
		right.push({ text: clean(spend.cost), paint: (text) => theme.fg("counter", text), drop: STATUS_RANK.cost });
	const model = state.session.modelId ? clean(state.session.modelId) : null;
	if (routeFacts && model !== null && state.session.targetId)
		right.push({
			text: clean(state.session.targetId),
			paint: (text) => theme.fg("footerIdentity", text),
			drop: STATUS_RANK.target,
		});
	const identity = model ?? clean(state.session.target ?? "not configured");
	const leaf = identity.slice(identity.lastIndexOf("/") + 1);
	// The id's form is chosen against what never drops (the mark and a non-default autonomy): it loses its `provider/`
	// prefix, then its middle, only when those and the whole id do not fit, so a short row does not give up its
	// workspace first and then shorten the id anyway.
	const room = Math.max(MODEL_ID_MIN_CELLS, width - visibleWidth(GLYPH.brand) - autonomyFloor - 2);
	const prefixFree = visibleWidth(identity) > room && model !== null && leaf.length > 0 ? leaf : identity;
	const shown =
		visibleWidth(prefixFree) <= room
			? prefixFree
			: fitSides(theme, [], [{ text: prefixFree, elide: { rank: 0, min: MODEL_ID_MIN_CELLS } }], room).trim();
	right.push({
		text: shown,
		paint: (text) => theme.fg("activeModelIdentity", text),
		elide: { rank: STATUS_RANK.modelElide, min: MODEL_ID_MIN_CELLS },
	});
	return fitSides(theme, left, right, width);
}

/**
 * The detailed tier's second status row, chips that drop whole from the right: the session's tokens, its cost or
 * `cost not measured`, the last rate, the first-token time and the cache share.
 */
function footerSessionRow(
	state: FooterDashboardRenderState,
	theme: ClioTheme,
	width: number,
	rate: { speed: string | null; ttft: string | null },
): string {
	const spend = state.telemetry;
	const value = (text: string): string => theme.fg("counter", text);
	const label = (name: string, text: string): string => `${theme.fg("annotation", name)} ${value(text)}`;
	// The row's one focal value is the session's measured tokens; every other figure is body text.
	const tokens =
		spend.kind === "unavailable"
			? // Before the first turn the read model has no session view yet, which is no fault.
				value(state.agent.lastTurn === null ? "no calls yet" : "spend not available")
			: spend.kind === "reading"
				? value("reading the call journal")
				: spend.tokens === null
					? value("no calls yet")
					: spend.measuredTokens === null
						? theme.fg("unknownValue", "usage not measured")
						: metricText(theme, spend.measuredTokens, "tokens");
	const cost =
		spend.kind !== "ready" || spend.tokens === null
			? null
			: spend.cost === null || spend.cost === COST_NOT_MEASURED
				? theme.fg("unknownValue", "cost not measured")
				: value(clean(spend.cost));
	return wholeChips(
		theme,
		[
			`${theme.fg("annotation", "session")} ${tokens}`,
			cost,
			rate.speed === null ? null : value(rate.speed),
			rate.ttft === null ? null : label("first token", rate.ttft),
			spend.kind === "ready" ? (cacheShare(spend.promptCache) ?? null) : null,
			spend.kind === "ready" && spend.neverSent ? theme.fg("warning", spend.neverSent) : null,
		],
		width,
	);
}

type FooterAlertKind = "urgent" | "feedback" | "error" | "window" | "weekly" | "silence" | "warning" | "info";

interface FooterAlert {
	kind: FooterAlertKind;
	text: string;
	tone: ClioToken;
	glyph: string | null;
	/** The notice behind the alert, which the dismiss key clears; the other alerts end with their cause. */
	notice: boolean;
	/** The text continues past its first line, so the row names where the rest is. */
	more: boolean;
}

function noticeAlert(notice: Notification, kind: FooterAlertKind): FooterAlert {
	const [first = "", ...rest] = clean(notice.text).split("\n");
	return {
		kind,
		text: first,
		tone: notificationToken(notice.level),
		glyph: notificationGlyph(notice.level),
		notice: true,
		more: rest.length > 0,
	};
}

/** Newest first, the order a one-slot row reads a group in. */
function newestFirst(notices: ReadonlyArray<Notification>): Notification[] {
	return [...notices].sort((a, b) => b.addedAt - a.addedAt);
}

/**
 * The notice row: the highest live alert at normal intensity with its glyph, then `+N <dashboard key>` for the rest
 * and the dismiss key at the right while a notice is among them.
 */
function renderAlertRow(
	theme: ClioTheme,
	alert: FooterAlert,
	others: number,
	dismissable: boolean,
	width: number,
	dashboardKey: string,
	dismissKeyLabel: string | undefined,
): string {
	const body = alert.glyph === null ? alert.text : `${alert.glyph} ${alert.text}`;
	const cut = alert.more || visibleWidth(body) > width;
	const dismiss =
		dismissable && dismissKeyLabel && !dismissKeyLabel.startsWith("unbound")
			? (dismissKeyLabel.split(` ${GLYPH.dot} `).at(-1) ?? "")
			: "";
	const more = others > 0 ? `+${others} ${dashboardKey}` : cut ? dashboardKey : "";
	const keys = [more, dismiss].filter(Boolean).join(` ${GLYPH.sep} `);
	const keyText = keys ? theme.fg("keyboardHint", keys) : "";
	const painted = (cells: number): string => theme.fg(alert.tone, fitNoticeWords(body, cells));
	// A narrow row keeps the alert itself; the keys ride along only while it keeps enough room to read.
	if (!keyText || width - visibleWidth(keyText) - 2 < NOTICE_MIN_CELLS) return painted(width);
	const room = width - visibleWidth(keyText) - 2;
	const shown = painted(room);
	return `${shown}${" ".repeat(Math.max(2, width - visibleWidth(shown) - visibleWidth(keyText)))}${keyText}`;
}

/**
 * The footer (4.2): the status line; at detailed the session row; the notice row while an alert is live; at standard
 * and up the hint row. Its height is fixed per tier so the composer does not move: 1, 2 or 3 rows, and a notice adds
 * one. A W1 width, an H1 terminal and a surface that owns the keys reduce every tier to the status line, plus the
 * notice row only for an armed quit or an error.
 */
export function renderCompactDashboard(
	state: FooterDashboardRenderState,
	width: number,
	terminalRows = Number.POSITIVE_INFINITY,
): string[] {
	const theme = clioTheme();
	const w = Math.max(1, width);
	const policy = tierPolicy(state.outputStyle ?? presentationTier());
	// The tiers that keep a hint row are the ones that name the route, the session cost and the full path (3.2).
	const routeFacts = policy.hintRow;
	const keyContext = state.keyContext ?? "send";
	const surfaceOwnsKeys = keyContext === "surface";
	// The keys that answer this moment, which a tip must not cover.
	const immediateKeys = keyContext !== "surface" && keyContext !== "idle" && keyContext !== "send";
	const reduced = w < FOOTER_W1_CELLS || terminalRows < FOOTER_H1_ROWS || surfaceOwnsKeys;
	const narrow = w <= FOOTER_NARROW_CELLS;
	const now = state.now;

	const liveWorkers = workerRowsOf(state.dispatchRows).filter((row) => ACTIVE_DISPATCH_STATUSES.has(row.status));
	const queued = liveWorkers.filter((row) => row.status === "enqueued").length;
	const counts: FooterCounts = {
		workers: liveWorkers.length - queued,
		queued,
		plans: state.dispatchRows.filter((row) => row.plan !== undefined && row.status === "running").length,
	};
	const weekly = state.quotaRoute ? routeWeeklyQuota(state.quotaRoute, state.quota ?? []) : null;
	// Idle and off say nothing: memory is named only while it works or cannot. The rail names a memory call from its
	// first moment, and memory yields the model to the turn on purpose, so its wait is no fault (N9).
	const guardian = state.session.memoryIntervention?.guardian;
	const memoryOnRail = (state.background ?? []).some((call) => call.purpose === "memory review");
	const window = state.session.autonomy === "yolo" ? (state.session.autonomyWindow ?? null) : null;
	const windowReadout =
		window === null ? null : autonomyWindowReadout(window, { narrow, dot: GLYPH.dot, resumeHint: "Enter continues" });
	const windowLeftMs =
		window !== null && window.caps.minutes > 0 ? window.caps.minutes * 60_000 - window.usage.activeMs : null;
	const windowEnding =
		windowReadout !== null &&
		(windowReadout.tone === "warning" || (windowLeftMs !== null && windowLeftMs < WINDOW_ENDING_MS));
	const nearest =
		window === null ? null : autonomyWindowReadout(window, { narrow: true, dot: GLYPH.dot, resumeHint: "" });
	const skills = state.session.activeSkills ?? [];
	const styled = (text: string): SideUnit => ({ text, drop: STATUS_RANK.aux });
	// Facts the row carries beside its own while they fit: an alert of the same kind has the notice row instead.
	const aux: SideUnit[] = [
		...(routeFacts && state.session.name
			? [
					{
						text: clean(state.session.name),
						paint: (text: string) => theme.fg("footerIdentity", text),
						drop: STATUS_RANK.aux,
					},
				]
			: []),
		...(guardian === "reviewing" && !memoryOnRail ? [styled(theme.fg("activity", "memory reviewing"))] : []),
		...(guardian === "unavailable" ? [styled(theme.fg("unknownValue", "memory review paused"))] : []),
		...(skills.length
			? [
					styled(
						`${theme.fg("skillAction", "skill ")}${theme.fg("counter", fitNames("", skills.map(clean), Math.max(8, Math.floor(w / 3))))}`,
					),
				]
			: []),
		...(routeFacts && windowReadout !== null && !windowEnding
			? [
					{
						text: windowReadout.text,
						paint: (text: string) => theme.fg("counter", text),
						...(nearest !== null && nearest.text !== windowReadout.text
							? { shorter: [{ text: nearest.text, rank: STATUS_RANK.auxShort }] }
							: {}),
						drop: STATUS_RANK.windowDrop,
					},
				]
			: []),
		...(weekly && weekly.severity !== "critical" && (routeFacts || weekly.severity !== "normal")
			? [styled(theme.fg(weekly.severity === "normal" ? "counter" : "warning", weekly.label))]
			: []),
		...(state.extensionFacts ?? []).map(styled),
	];
	const rows = [footerStatusLine(state, theme, w, routeFacts, counts, aux)];

	const rate = footerRate(state);
	if (policy.statusRows >= 2 && !reduced) rows.push(footerSessionRow(state, theme, w, rate));

	const feedback = topNotification(
		state.notices.filter((notice) => notice.presentation === "setting"),
		now,
	);
	const hintRow = policy.hintRow && !reduced;
	const live = state.notices.filter(
		(entry) =>
			entry.presentation !== "setting" &&
			(entry.expiresAt === null || entry.expiresAt > now) &&
			// A tip teaches the idle composer; under a card, or while a run holds the keys, the row keeps what applies.
			!((surfaceOwnsKeys || immediateKeys) && entry.text.startsWith("tip: ")),
	);
	const leaderKey = formatKeyLabel(getKeybindings().getKeys("clio-coder.leader")[0], "");
	const urgent = state.session.shutdownArmed
		? typeof state.session.shutdownArmed === "string"
			? state.session.shutdownArmed
			: "Ctrl+C again to quit"
		: // The leader also opens the action menu, whose own rail lists the keys: a second legend under it said
			// `choose key` for a choice already on screen.
			state.session.leaderArmed && !surfaceOwnsKeys
			? leaderKey
				? `${leaderKey} ${GLYPH.next} choose key`
				: "Choose key"
			: null;
	const silence = state.silenceNotes ?? null;
	const silenceNote = silence?.find((form) => visibleWidth(form) + 2 <= w) ?? silence?.at(-1) ?? null;
	const plain = (kind: FooterAlertKind, text: string, tone: ClioToken, glyph: string | null): FooterAlert => ({
		kind,
		text,
		tone,
		glyph,
		notice: false,
		more: false,
	});
	// Precedence, highest first (4.2): what the operator just asked for, an error, the alerts that state a standing
	// limit, then warnings, then information above the tier's floor.
	const alerts: FooterAlert[] = [
		...(urgent === null ? [] : [plain("urgent", urgent, "warning", null)]),
		// Setting feedback acknowledges a key the operator just pressed; with no hint row to carry it, it leads here.
		...(feedback && !hintRow ? [plain("feedback", clean(feedback.text), "changedValue", null)] : []),
		...newestFirst(live.filter((entry) => entry.level === "error")).map((entry) => noticeAlert(entry, "error")),
		...(windowEnding && windowReadout ? [plain("window", windowReadout.text, "warning", GLYPH.warn)] : []),
		...(weekly && weekly.severity === "critical" ? [plain("weekly", weekly.label, "error", GLYPH.warn)] : []),
		...(silenceNote === null ? [] : [plain("silence", silenceNote, "warning", GLYPH.warn)]),
		...newestFirst(live.filter((entry) => entry.level === "warning")).map((entry) => noticeAlert(entry, "warning")),
		...(policy.noticeFloor === "info"
			? newestFirst(live.filter((entry) => entry.level === "info" || entry.level === "success")).map((entry) =>
					noticeAlert(entry, "info"),
				)
			: []),
	];
	const top = alerts[0];
	const shownAlert = top === undefined ? null : !reduced || top.kind === "urgent" || top.kind === "error" ? top : null;
	if (shownAlert !== null)
		rows.push(
			renderAlertRow(
				theme,
				shownAlert,
				alerts.length - 1,
				alerts.some((alert) => alert.notice),
				w,
				actionKeyLabel("clio-coder.status.toggle") ?? "Dashboard",
				state.dismissKeyLabel,
			),
		);
	if (!hintRow) return rows;

	const learning = policy.tips && state.demo !== false;
	const controls = feedback
		? theme.fg("changedValue", fitNoticeWords(clean(feedback.text), w))
		: learning && state.demoHint && !immediateKeys && shownAlert === null
			? `${theme.fg("guidance", "Tip")} ${theme.fg("counter", fitNoticeWords(clean(state.demoHint), Math.max(1, w - 4)))}`
			: state.welcomeVisible
				? ""
				: theme.fg("keyboardHint", footerKeyHint(now, narrow, w, keyContext, { ...state.keyHintFacts, learning }) ?? "");
	rows.push(controls);
	return rows;
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
	const title = `${brandMark(theme)} ${theme.fg("border", GLYPH.rail)} ${theme.style("selectedOption", "Dashboard", { bold: true })}`;
	// The build this process runs, as its process title names it, yields to the route when the row is narrow.
	const withBuild = `${title}  ${theme.fg("annotation", clioBuildLabel())}`;
	const tabText = innerWidth - visibleWidth(withBuild) - 4 >= 20 ? withBuild : title;
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
