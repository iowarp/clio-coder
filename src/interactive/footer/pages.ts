import { costAggregateForAmount, formatCostAggregate } from "../../domains/observability/index.js";
import type { UsageSnapshot } from "../../domains/quota/types.js";
/** Expanded footer pages: dense inspection, separate from transcript output style. */
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { redactSecretString } from "../../domains/safety/redaction.js";
import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { contextCategorySwatch, renderContextMeterGrid } from "../context-meter.js";
import type { DispatchBoardRow } from "../dispatch-board.js";
import { dispatchStatusPresentation, renderDispatchActivity } from "../dispatch-board.js";
import { ACTIVE_DISPATCH_STATUSES, FAILED_DISPATCH_STATUSES, formatFooterTokens } from "../footer-panel.js";
import { formatKeyLabel } from "../keybinding-manager.js";
import { renderQuotaAccounts, routeWeeklyQuota } from "../quota-view.js";
import { previewRows } from "../renderers/preview.js";
import { brandMark, clioTheme, formatCompactMs, GLYPH, metricText, padAnsi, rule } from "../theme/index.js";
import { fitIdentityLabel } from "../theme/labels.js";
import type { FooterDashboardRenderState } from "./dashboard.js";
import { footerKeyHint } from "./key-hints.js";
import { notificationGlyph, notificationToken, topNotification } from "./notifications.js";
import { activityQuadrant, compactContextUsage, contextQuadrant, contextUsageText, zipColumns } from "./widgets.js";

export const DASHBOARD_PAGES = ["Activity", "Context", "Status"] as const;
export type DashboardPage = (typeof DASHBOARD_PAGES)[number];
const FOOTER_SPLIT_COLUMNS = 84;
const clean = (value: string) => sanitizeCallTargetText(redactSecretString(value));

function agentCard(
	row: DispatchBoardRow,
	width: number,
	compact = false,
	quota: ReadonlyArray<UsageSnapshot> = [],
): string[] {
	const theme = clioTheme();
	const presentation = dispatchStatusPresentation(row.status, { compact: false });
	const name = clean(row.agentId).replace(
		/(^|[-_ ])([a-z])/g,
		(_, gap: string, letter: string) => `${gap ? " " : ""}${letter.toUpperCase()}`,
	);
	const audience = row.agentAudience === "shadow" || row.agentAudience === "internal" ? "internal agent" : "fleet agent";
	const heading = `${theme.fg(row.agentAudience === "shadow" || row.agentAudience === "internal" ? "shadowDispatchAction" : "dispatchAction", GLYPH.subProcess)} ${theme.fg("footerIdentity", name)}`;
	const lines = wrapTextWithAnsi(
		`${heading}  ${theme.fg(presentation.token, `${presentation.glyph} ${presentation.label}`)}  ${theme.fg("annotation", `${formatCompactMs(row.elapsedMs)} · ${audience}`)}`,
		width,
	);
	const field = (label: string, value: string) =>
		wrapTextWithAnsi(`${theme.fg("annotation", `${label}  `)}${clean(value)}`, width);
	lines.push(...previewRows(field("Route", `${row.targetId}/${row.wireModelId}`), 2, width));
	const weekly = routeWeeklyQuota(row, quota);
	if (weekly)
		lines.push(...previewRows(field("Account", `Shared ${weekly.account} · ${weekly.label}`), compact ? 1 : 2, width));
	if (row.taskSummary)
		lines.push(...(compact ? previewRows(field("Task", row.taskSummary), 2, width) : field("Task", row.taskSummary)));
	const activity = renderDispatchActivity(row, width);
	lines.push(...(compact ? activity.slice(0, 2) : activity));
	const usage: string[] = [];
	if (row.progress?.inputTokens !== undefined || row.inputTokens > 0 || row.outputTokens > 0)
		usage.push(
			`${GLYPH.up} ${formatFooterTokens(row.inputTokens)} input`,
			`${GLYPH.down} ${formatFooterTokens(row.outputTokens)} output`,
		);
	const context = row.progress?.contextTokens ?? row.lastContextTokens;
	lines.push(...field("Tokens", usage.length ? usage.join(" · ") : "awaiting reported measurements"));
	const workload: string[] = [];
	if (context !== undefined && context > 0)
		workload.push(
			`context ${formatFooterTokens(context)}${row.contextWindow ? ` / ${formatFooterTokens(row.contextWindow)}` : ""}`,
		);
	if (row.progress?.toolCalls !== undefined)
		workload.push(`${row.progress.toolCalls} tool ${row.progress.toolCalls === 1 ? "call" : "calls"}`);
	if (workload.length) lines.push(...field("Work", workload.join(" · ")));
	const timing: string[] = [];
	if (row.ttftMs !== null) timing.push(`first token ${formatCompactMs(row.ttftMs)}`);
	const cost = formatCostAggregate(costAggregateForAmount(row.costUsd, row.costProvenance));
	if (cost) timing.push(cost);
	if (!compact && timing.length) lines.push(...field("Timing", timing.join(" · ")));
	if (!compact && row.budget)
		lines.push(
			...field(
				"Budget",
				`${row.budget.effective.toolCalls} calls (${row.budget.effective.mode}) · hard cap ${row.budget.effective.hardCap}`,
			),
		);
	lines.push(...field("Inspect", `/view dispatch:${row.runId}`));
	return lines;
}

function activityPage(state: FooterDashboardRenderState, width: number, budget: number): string[] {
	const theme = clioTheme();
	const sideBySide = width >= 110;
	const summaryWidth = sideBySide ? Math.floor((width - 3) / 2) : width;
	const summary = activityQuadrant(state.agent, {
		width: summaryWidth,
		status: state.status,
		toolCounts: state.toolCounts,
		throughput: state.throughput,
		sessionTokens: state.sessionTokens,
		sessionCost: state.sessionCost,
		contextUsed: state.context.used,
		tick: state.tick,
		now: state.now,
	}).slice(1);
	const active = state.dispatchRows.filter((row) => ACTIVE_DISPATCH_STATUSES.has(row.status));
	const history = state.dispatchRows.filter((row) => !ACTIVE_DISPATCH_STATUSES.has(row.status));
	if (!state.dispatchRows.length)
		return [
			...summary,
			"",
			theme.fg("annotation", "No agent invocations yet. Worker cards appear here as agents start."),
		];
	const midpoint = Math.ceil(summary.length / 2);
	const summaryRows = sideBySide
		? zipColumns(summary.slice(0, midpoint), summary.slice(midpoint), summaryWidth, width - summaryWidth - 3, "   ")
		: summary;
	const cardBudget = budget - summaryRows.length - 1;
	const cards: string[] = [];
	const inspectAll =
		getKeybindings()
			.getKeys("clio-coder.dispatchBoard.toggle")
			.map((key) => formatKeyLabel(key))
			.join("/") || "Workers shortcut";
	if (active.length) cards.push(rule(theme, width, { left: "AGENT ACTIVITY", leftToken: "sectionHeading" }));
	else cards.push(theme.fg("counter", "No agents running."));
	let shown = 0;
	if (width >= 120 && active.length >= 2) {
		const col = Math.floor((width - 5) / 2);
		const first = active[0];
		const second = active[1];
		if (first && second) {
			cards.push(
				...zipColumns(
					agentCard(first, col, true, state.quota),
					agentCard(second, width - col - 5, true, state.quota),
					col,
					width - col - 5,
					`  ${theme.fg("border", GLYPH.rail)}  `,
				),
				"",
			);
			shown = 2;
		}
	} else
		for (const row of active) {
			const card = agentCard(row, width, active.length > 1 || cardBudget < 18, state.quota);
			if (cards.length + card.length + 2 > cardBudget && shown > 0) break;
			cards.push(...card, "");
			shown++;
		}
	if (shown < active.length)
		cards.push(theme.fg("annotation", `${active.length - shown} more active agents · ${inspectAll} for all`));
	if (history.length) {
		cards.push(
			rule(theme, width, { left: `INVOCATION HISTORY · ${history.length} finished`, leftToken: "groupHeading" }),
		);
		let historyShown = 0;
		for (const row of history.slice(0, 4)) {
			const presentation = dispatchStatusPresentation(row.status, { compact: false });
			const name = clean(row.agentId).replace(
				/(^|[-_ ])([a-z])/g,
				(_, gap: string, letter: string) => `${gap ? " " : ""}${letter.toUpperCase()}`,
			);
			const audience = row.agentAudience === "shadow" || row.agentAudience === "internal" ? "internal" : "fleet";
			const usage =
				row.inputTokens > 0 || row.outputTokens > 0
					? ` · ${GLYPH.up} ${formatFooterTokens(row.inputTokens)} ${GLYPH.down} ${formatFooterTokens(row.outputTokens)}`
					: "";
			const compact = [
				...wrapTextWithAnsi(
					`${theme.fg(presentation.token, presentation.glyph)} ${theme.fg("footerIdentity", name)} · ${theme.fg(presentation.token, presentation.label)} · ${theme.fg("annotation", audience)} · ${theme.fg("counter", `${formatCompactMs(row.elapsedMs)}${usage}`)}`,
					width,
				),
				...wrapTextWithAnsi(
					theme.fg("annotation", `${row.outcomeDetail ? `${clean(row.outcomeDetail)} · ` : ""}/view dispatch:${row.runId}`),
					width,
				),
			];
			if (cards.length + compact.length + 1 > cardBudget) break;
			cards.push(...compact);
			historyShown++;
		}
		if (historyShown < history.length)
			cards.push(
				theme.fg("annotation", `${history.length - historyShown} more finished runs · ${inspectAll} for full history`),
			);
	}
	return [...summaryRows, "", ...cards];
}

function contextPage(state: FooterDashboardRenderState, width: number, budget: number): string[] {
	const theme = clioTheme();
	const ledger = state.context.ledger;
	if (!ledger)
		return [
			...contextQuadrant(state.context, { width }).slice(1),
			"",
			theme.fg("annotation", "Detailed context accounting appears after the prompt is compiled."),
		];
	const compactionDescription =
		ledger.contextWindow <= 0
			? "on server overflow"
			: ledger.compactionAuto
				? `auto${ledger.compactionThreshold === null ? "" : ` @${Math.round(ledger.compactionThreshold * 100)}%`}`
				: "manual";
	const out = [
		...wrapTextWithAnsi(
			`${metricText(
				theme,
				state.context.budget
					? contextUsageText(state.context)
					: `${formatFooterTokens(ledger.usedTokens)} / ${ledger.contextWindow > 0 ? formatFooterTokens(ledger.contextWindow) : "unknown window"}`,
				"tokens",
			)}${ledger.percent === null ? "" : ` · ${theme.fg("counter", `${ledger.percent.toFixed(1)}%`)} ${theme.fg("metricUnit", "occupied")}`}`,
			width,
		),
		...wrapTextWithAnsi(
			`${state.context.budget ? "Capture diagnostics: " : ""}Free ${ledger.contextWindow > 0 ? formatFooterTokens(ledger.freeTokens) : "unknown"} · reserved ${formatFooterTokens(ledger.reserveTokens)} · ${ledger.toolCount} tool definitions · compaction ${compactionDescription}`,
			width,
		),
	];
	const gridWidth = Math.max(12, Math.min(64, width >= FOOTER_SPLIT_COLUMNS ? Math.floor(width * 0.38) : width));
	const gridHeight = Math.max(1, Math.min(4, budget - 5));
	const grid = renderContextMeterGrid(ledger, gridWidth, gridHeight, theme);
	const legendWidth = width >= FOOTER_SPLIT_COLUMNS ? width - gridWidth - 4 : width;
	const legend = ledger.meter
		.filter((group) => group.tokens > 0)
		.flatMap((group) =>
			wrapTextWithAnsi(
				`${contextCategorySwatch(group.category, theme)} ${theme.fg("legend", group.label.padEnd(20))} ${theme.fg("counter", formatFooterTokens(group.tokens).padStart(7))}  ${theme.fg(group.percent === null ? "unknownValue" : "counter", group.percent === null ? "unknown" : `${group.percent.toFixed(1)}%`)}`,
				legendWidth,
			),
		);
	out.push(
		rule(theme, width, {
			left: state.context.budget ? "CAPTURE DIAGNOSTICS" : "CONTEXT COMPOSITION",
			leftToken: "groupHeading",
		}),
	);
	out.push(
		...(width >= FOOTER_SPLIT_COLUMNS
			? zipColumns(grid, previewRows(legend, gridHeight, legendWidth), gridWidth, legendWidth, "    ")
			: [...grid, "", ...legend]),
	);
	out.push(theme.fg("annotation", "Context is per request · subscription limits are account-wide · /usage"));
	out.push(
		...wrapTextWithAnsi(
			theme.fg("counter", "Filled = context · empty = available · shaded = reserve; small buckets receive one cell."),
			width,
		),
	);

	out.push(
		"",
		...wrapTextWithAnsi(
			theme.fg(
				"annotation",
				`${ledger.measured ? "Provider-anchored total; category splits estimated" : "Estimated usage"} · window source: ${ledger.contextWindowSource ?? "unknown"}`,
			),
			width,
		),
	);
	if (ledger.lastCompaction)
		out.push(
			...wrapTextWithAnsi(
				`Last compaction: ${formatFooterTokens(ledger.lastCompaction.tokensBefore)} ${GLYPH.next} ${formatFooterTokens(ledger.lastCompaction.tokensAfter)} · ${clean(ledger.lastCompaction.trigger)}`,
				width,
			),
		);
	if (ledger.promptCache) {
		const cache = ledger.promptCache;
		const count = (value: number | null) => (value === null ? "unreported" : formatFooterTokens(value));
		out.push(
			...wrapTextWithAnsi(
				`Prompt cache · read ${count(cache.cacheReadTokens)} · write ${count(cache.cacheWriteTokens)} · uncached ${count(cache.uncachedInputTokens)}`,
				width,
			),
		);
		out.push(
			...wrapTextWithAnsi(
				`Session shell ${cache.shellReused ? "reused" : "rebuilt"} · backend ${cache.backendVerdict ?? "unreported"}`,
				width,
			),
		);
	}
	if (ledger.prewarm)
		out.push(
			...wrapTextWithAnsi(
				`Prewarm · ${ledger.prewarm.tokens === null ? "tokens unreported" : `${formatFooterTokens(ledger.prewarm.tokens)} tokens`} · ${formatCompactMs(ledger.prewarm.ms)}${ledger.prewarm.aborted ? " · interrupted" : ""}`,
				width,
			),
		);

	return out;
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

/** The widest stats a row carries, `272K/272K (100.0%) | 999 tps`. */
const STATS_RESERVE_WIDTH = 28;

/** Workspace and counts above; notices and active harness facts below. */
export function renderCompactDashboard(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();
	const w = Math.max(1, width);
	const narrow = w <= 60;
	const fit = (text: string, room = w) =>
		theme.base("counter", truncateToWidth(text, Math.max(1, room), GLYPH.ellipsis, true));
	const separator = theme.fg("border", " · ");
	const counter = compactContextUsage(state.context, theme, Math.floor(w * 0.4));
	const rate = state.throughput?.tokensPerSecond;
	const speed =
		typeof rate === "number" && Number.isFinite(rate) && rate > 0
			? metricText(theme, String(rate >= 10 ? Math.round(rate) : Math.round(rate * 10) / 10), "tps")
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
	const notice = topNotification(
		state.notices.filter((entry) => entry.presentation !== "setting"),
		state.now,
	);
	const key =
		getKeybindings()
			.getKeys("clio-coder.status.toggle")
			.map((key) => formatKeyLabel(key))
			.join("/") || "Dashboard";
	const leaderKey = formatKeyLabel(getKeybindings().getKeys("clio-coder.leader")[0], "");
	const urgent = state.session.shutdownArmed
		? "Ctrl+C again to quit"
		: state.session.leaderArmed
			? leaderKey
				? `${leaderKey} ${GLYPH.next} choose key`
				: "Choose key"
			: null;
	const workers = state.dispatchRows.filter((row) => ACTIVE_DISPATCH_STATUSES.has(row.status)).length;
	const skills = state.session.activeSkills ?? [];
	const weekly = state.quotaRoute ? routeWeeklyQuota(state.quotaRoute, state.quota ?? []) : null;
	// Idle and off say nothing: the line names memory only while it works or cannot.
	const guardian = state.session.memoryIntervention?.guardian;
	const memoryFact =
		guardian === "reviewing"
			? theme.fg("activity", "mem reviewing")
			: guardian === "waiting-capacity"
				? theme.fg("warning", "mem waiting")
				: guardian === "unavailable"
					? theme.fg("unknownValue", "mem unavailable")
					: "";
	const facts = [
		state.session.duckBadge ? theme.fg("counter", "🦆") : "",
		workers ? theme.fg("activity", `${workers} ${workers === 1 ? "worker" : "workers"}`) : "",
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
				: state.demoHint && !state.welcomeVisible
					? `${theme.fg("guidance", "Tip")} ${theme.fg("counter", clean(state.demoHint))}`
					: theme.fg(
							"keyboardHint",
							state.welcomeVisible
								? ""
								: ((state.demo !== false ? footerKeyHint(state.now, narrow, room) : null) ?? `${key} Dashboard`),
						);
	// One line flattens a multi-line notice and cuts the end, which is where a
	// remediation command sits. Name the key that opens the dashboard, whose
	// notice panel wraps the full text.
	const more = theme.fg("keyboardHint", ` ${key} more`);
	// A narrow row keeps the notice itself; the hint only rides along when
	// the notice keeps enough room to stay readable.
	const clipped =
		room - visibleWidth(more) >= 24 &&
		!urgent &&
		notice !== undefined &&
		(notice.text.includes("\n") || visibleWidth(`${notificationGlyph(notice.level)} ${clean(notice.text)}`) > room);
	const line = clipped ? `${fit(message, Math.max(1, room - visibleWidth(more)))}${more}` : message;
	if (alone) return [firstRow, fit(line)];
	return [firstRow, fit(`${fit(line, room)}   ${fit(tail, tailWidth)}`)];
}

function statusPage(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();
	type MeterCell = { kind: "meter"; percent: number | null; suffix: string };
	type SectionEntry = readonly [label: string, value: string | MeterCell];

	const quotaRows = [
		theme.style(
			"metricValue",
			`SESSION · ${formatFooterTokens(state.sessionTokens?.totalTokens ?? 0)} recorded tokens · ${formatCostAggregate(state.sessionCost) ?? "cost not yet priced"}`,
			{ bold: true },
		),
		...renderQuotaAccounts(state.quota ?? [], width, { compact: true, now: state.now }),
	];

	const active = state.dispatchRows.filter((row) => ACTIVE_DISPATCH_STATUSES.has(row.status));
	const completed = state.dispatchRows.filter((row) => row.status === "completed").length;
	const failed = state.dispatchRows.filter((row) => FAILED_DISPATCH_STATUSES.has(row.status)).length;
	const toolCalls = Object.values(state.toolCounts.tools).reduce((a, b) => a + b, 0);
	const resource = state.resources;
	const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
	const capacity = state.agent.localCapacity;
	const memory = state.session.memoryIntervention;
	const section = (title: string, entries: ReadonlyArray<SectionEntry>, columns: number) => {
		const labelWidth = Math.min(17, Math.max(10, Math.floor(columns * 0.4)));
		return [
			rule(theme, columns, { left: title, leftToken: "sectionHeading" }),
			...entries.flatMap(([label, value]) => {
				let rendered: string;
				if (typeof value === "string")
					rendered = theme.fg(
						/^(unknown|unreported|unavailable|not sampled|sampling|warming up|pending)/u.test(value)
							? "unknownValue"
							: "fieldValue",
						clean(value),
					);
				else if (value.percent === null) rendered = theme.fg("unknownValue", "warming up");
				else {
					const percent = Number.isFinite(value.percent) ? Math.max(0, Math.min(100, value.percent)) : 0;
					const filled = Math.round(percent / 10);
					rendered = `${theme.fg("meterFill", GLYPH.meterFull.repeat(filled))}${theme.fg("meterFree", GLYPH.meterEmpty.repeat(10 - filled))} ${theme.fg("metricValue", percent.toFixed(0))}${theme.fg("metricUnit", "%")}${value.suffix ? `  ${theme.fg("fieldValue", clean(value.suffix))}` : ""}`;
				}
				return wrapTextWithAnsi(`${theme.fg("fieldName", label.padEnd(labelWidth))}  ${rendered}`, columns);
			}),
			"",
		];
	};
	const throughput = (value: number) =>
		value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB/s` : `${(value / 1024).toFixed(1)} KiB/s`;
	const meter = (percent: number | null, suffix = ""): MeterCell => ({ kind: "meter", percent, suffix });
	const names = (items: string[] | undefined) =>
		items === undefined ? "unreported" : items.length ? `${items.length} · ${items.join(", ")}` : "none";
	const left: [string, string][] = [
		["Target", state.session.target ?? "No model selected"],
		["Tracked cost", formatCostAggregate(state.sessionCost) ?? "not yet priced"],
		[
			"Clio ceiling",
			state.costCeilingUsd === undefined
				? "unknown"
				: state.costCeilingUsd === 0
					? "none"
					: `$${state.costCeilingUsd} · tracked pricing only`,
		],
		["MCP connected", names(state.connections?.mcp)],
		["Plugins active", names(state.connections?.plugins)],
		[
			"Extensions",
			state.context.extensions
				? `${state.context.extensions.active} active / ${state.context.extensions.installed} installed`
				: "unreported",
		],
		["Workers", `${active.length} active · ${completed} done · ${failed} failed`],
		["Tools", `${toolCalls} calls · ${state.toolCounts.active ?? 0} active · ${state.toolCounts.errors} failed`],
		["Worker cap", capacity ? `${capacity.limit} · ${capacity.bound}` : "not sampled"],
	];
	const right: [string, string | MeterCell][] = [
		["Scope", resource?.scope ?? "local OS · sampling"],
		["CPU", resource ? meter(resource.cpuPercent) : "sampling"],
		[
			"RAM",
			resource
				? meter(
						(1 - resource.hostFreeBytes / resource.hostTotalBytes) * 100,
						`${gib(resource.hostTotalBytes - resource.hostFreeBytes)} / ${gib(resource.hostTotalBytes)}`,
					)
				: "sampling",
		],
		["Clio RSS", resource ? gib(resource.processRssBytes) : "sampling"],
		[
			"GPU",
			resource?.gpu
				? `${resource.gpu.name} · ${resource.gpu.busyPercent === null ? "load unavailable" : `${resource.gpu.busyPercent}%`}`
				: "unavailable on this OS/driver",
		],
		[
			"GPU VRAM",
			resource?.gpu?.usedBytes != null && resource.gpu.totalBytes != null
				? `${gib(resource.gpu.usedBytes)} / ${gib(resource.gpu.totalBytes)}`
				: "unreported",
		],
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
		[
			"Sampling",
			resource ? `${Math.max(0, Math.round((state.now - resource.sampledAt) / 1000))}s ago · 2s cadence` : "pending",
		],
		["Scope note", "busiest interface/disk · local only"],
	];
	const extras: [string, string][] = [
		[
			"Memory bank",
			memory
				? `${memory.size} entries · ${guardianLabel(memory.guardian) ?? (memory.stepInFlight ? "updating" : (memory.lastDecision ?? "idle"))}`
				: "not reported",
		],
		["Context work", state.agent.contextActivity?.message ?? "idle"],
		[
			"Context headroom",
			state.context.ledger?.contextWindow
				? `${formatFooterTokens(state.context.ledger.freeTokens)} tokens free`
				: "unknown",
		],
	];
	const health = right.filter(([label]) => label === "CPU" || label === "RAM");
	const workers = left.filter(([label]) => label === "Worker cap" || label === "Workers");
	const sampling = right.filter(([label]) => label === "Sampling");
	const col = Math.floor((width - 5) / 2);
	// Health and capacity share the first screen; less urgent fields remain scrollable.
	const essentials =
		width < FOOTER_SPLIT_COLUMNS
			? section("LIVE STATUS", [...health, ...workers, ...sampling], width).slice(1, -1)
			: zipColumns(
					section("LIVE STATUS", health, col).slice(1, -1),
					section("LIVE STATUS", [...workers, ...sampling], width - col - 5).slice(1, -1),
					col,
					width - col - 5,
					`  ${theme.fg("border", GLYPH.rail)}  `,
				);
	const intro = [quotaRows[0] ?? "", ...essentials];
	const connections = left.filter(([label]) => label !== "Worker cap" && label !== "Workers");
	const machine = right.filter(([label]) => !["CPU", "RAM", "Sampling"].includes(label));
	if (width < FOOTER_SPLIT_COLUMNS)
		return [
			...intro,
			...quotaRows.slice(1),
			...section("COST & CONNECTIONS", connections, width),
			...section("LOCAL MACHINE", machine, width),
			theme.style("sectionHeading", "CONTEXT ENGINE", { bold: true }),
			...wrapTextWithAnsi(
				extras
					.map(([label, value]) => `${theme.fg("fieldName", label)} ${theme.fg("fieldValue", clean(value))}`)
					.join("  ·  "),
				width,
			),
		];
	return [
		...intro,
		...quotaRows.slice(1),
		...zipColumns(
			section("COST & CONNECTIONS", connections, col),
			section("LOCAL MACHINE", machine, width - col - 5),
			col,
			width - col - 5,
			`  ${theme.fg("border", GLYPH.rail)}  `,
		),
		theme.style("sectionHeading", "CONTEXT ENGINE", { bold: true }),
		...wrapTextWithAnsi(
			extras
				.map(([label, value]) => `${theme.fg("fieldName", label)} ${theme.fg("fieldValue", clean(value))}`)
				.join("  ·  "),
			width,
		),
	];
}

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

	const tabText =
		innerWidth >= 52
			? `${brandMark(theme)} ${tabs.join(" ")}`
			: `${brandMark(theme)} ${theme.style("selectedOption", `${GLYPH.cursor} ${page}`, { bold: true })} ${theme.fg("positionCount", `${DASHBOARD_PAGES.indexOf(page) + 1}/${DASHBOARD_PAGES.length}`)}`;

	const identityRoom = innerWidth - visibleWidth(tabText) - 4;
	const identity = `${state.session.duckBadge ? "🦆 " : ""}${clean(state.session.target ?? "No model selected")}`;
	const heading = [
		truncateToWidth(
			identityRoom >= 20
				? `${tabText}    ${theme.fg("footerIdentity", fitIdentityLabel(identity, identityRoom))}`
				: tabText,
			innerWidth,
			GLYPH.ellipsis,
			true,
		),
	];
	const next = page === "Status" ? "close" : DASHBOARD_PAGES[DASHBOARD_PAGES.indexOf(page) + 1];
	let hint = truncateToWidth(
		theme.fg(
			"counter",
			`${cycleKey || "Dashboard"} ${GLYPH.next} ${next}   ·   ${page === "Status" ? "/usage · /mcp · /library" : "composer stays active"}`,
		),
		innerWidth,
		GLYPH.ellipsis,
		true,
	);
	const available = budget - 4;
	let content: string[];
	if (page === "Activity") content = activityPage(state, innerWidth, Number.MAX_SAFE_INTEGER);
	else if (page === "Context") content = contextPage(state, innerWidth, available);
	else content = statusPage(state, innerWidth);
	content = content.flatMap((line) => (visibleWidth(line) > innerWidth ? wrapTextWithAnsi(line, innerWidth) : [line]));
	const maxOffset = Math.max(0, content.length - available);
	const offset = Math.max(0, Math.min(maxOffset, Math.floor(scrollOffset)));
	if (maxOffset > 0) {
		hint = truncateToWidth(
			theme.fg(
				"keyboardHint",
				`Alt+PgUp/PgDn ${offset + 1}–${Math.min(content.length, offset + available)}/${content.length} · ${cycleKey || "Dashboard"} ${GLYPH.next} ${next}`,
			),
			innerWidth,
			GLYPH.ellipsis,
			true,
		);
	}
	content = content.slice(offset, offset + available);
	while (content.length < available) content.push("");
	return {
		rows: [...heading.map(inset), rule(theme, safeWidth), ...content.map(inset), rule(theme, safeWidth), inset(hint)],
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
