import { costAggregateForAmount, formatCostAggregate } from "../../domains/observability/index.js";
import type { UsageSnapshot } from "../../domains/quota/types.js";
/** Expanded footer pages: dense inspection, separate from transcript output style. */
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { redactSecretString } from "../../domains/safety/redaction.js";
import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { contextCategorySwatch, renderContextMeterGrid } from "../context-meter.js";
import { type DispatchBoardRow, dispatchStatusPresentation, renderDispatchActivity } from "../dispatch-board.js";
import { formatFooterTokens } from "../footer-panel.js";
import { renderQuotaAccounts, routeWeeklyQuota } from "../quota-view.js";
import { previewRows } from "../renderers/preview.js";
import { clioTheme, formatCompactMs, formatContextPercent, GLYPH, rule } from "../theme/index.js";
import { fitIdentityLabel, formatTargetLabel } from "../theme/labels.js";
import type { FooterDashboardRenderState } from "./dashboard.js";
import { footerKeyHint } from "./key-hints.js";
import { notificationGlyph, notificationToken, topNotification } from "./notifications.js";
import {
	activityQuadrant,
	contextOccupancyBar,
	contextQuadrant,
	contextUsagePercent,
	contextUsageText,
	zipColumns,
} from "./widgets.js";

export const DASHBOARD_PAGES = ["Activity", "Context", "Status"] as const;
export type DashboardPage = (typeof DASHBOARD_PAGES)[number];
const FOOTER_SPLIT_COLUMNS = 84;
const ACTIVE_AGENT_STATUSES = new Set(["running", "enqueued", "cancelling", "retrying", "stale"]);
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
	const heading = theme.style("agent", `↳ ${name}`, { bold: true });
	const lines = wrapTextWithAnsi(
		`${heading}  ${theme.fg(presentation.token, `${presentation.glyph} ${presentation.label}`)}  ${theme.fg("dim", `${formatCompactMs(row.elapsedMs)} · ${audience}`)}`,
		width,
	);
	const field = (label: string, value: string) =>
		wrapTextWithAnsi(`${theme.fg("dim", `${label}  `)}${clean(value)}`, width);
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
		usage.push(`↑ ${formatFooterTokens(row.inputTokens)} input`, `↓ ${formatFooterTokens(row.outputTokens)} output`);
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
	const summary = activityQuadrant(
		{ ...state.agent, dispatchRows: [] },
		{
			width: summaryWidth,
			status: state.status,
			toolCounts: state.toolCounts,
			throughput: state.throughput,
			sessionTokens: state.sessionTokens,
			sessionCost: state.sessionCost,
			contextUsed: state.context.used,
			tick: state.tick,
			now: state.now,
			maxWorkers: 0,
		},
	).slice(1);
	const active = state.dispatchRows.filter((row) => ACTIVE_AGENT_STATUSES.has(row.status));
	const history = state.dispatchRows.filter((row) => !ACTIVE_AGENT_STATUSES.has(row.status));
	if (!state.dispatchRows.length)
		return [...summary, "", theme.fg("dim", "No agent invocations yet. Worker cards appear here as agents start.")];
	const midpoint = Math.ceil(summary.length / 2);
	const summaryRows = sideBySide
		? zipColumns(summary.slice(0, midpoint), summary.slice(midpoint), summaryWidth, width - summaryWidth - 3, "   ")
		: summary;
	const cardBudget = budget - summaryRows.length - 1;
	const cards: string[] = [];
	const inspectAll = getKeybindings().getKeys("clio-coder.dispatchBoard.toggle").join("/") || "Workers shortcut";
	if (active.length) cards.push(rule(theme, width, { left: "AGENT ACTIVITY", leftToken: "agent" }));
	else cards.push(theme.fg("muted", "No agents running."));
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
					`  ${theme.fg("frame", "│")}  `,
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
		cards.push(theme.fg("dim", `${active.length - shown} more active agents · ${inspectAll} for all`));
	if (history.length) {
		cards.push(rule(theme, width, { left: `INVOCATION HISTORY · ${history.length} finished`, leftToken: "muted" }));
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
					? ` · ↑${formatFooterTokens(row.inputTokens)} ↓${formatFooterTokens(row.outputTokens)}`
					: "";
			const compact = [
				...wrapTextWithAnsi(
					`${theme.fg(presentation.token, `${presentation.glyph} ${name} · ${presentation.label}`)} · ${audience} · ${formatCompactMs(row.elapsedMs)}${usage}`,
					width,
				),
				...wrapTextWithAnsi(
					theme.fg("dim", `${row.outcomeDetail ? `${clean(row.outcomeDetail)} · ` : ""}/view dispatch:${row.runId}`),
					width,
				),
			];
			if (cards.length + compact.length + 1 > cardBudget) break;
			cards.push(...compact);
			historyShown++;
		}
		if (historyShown < history.length)
			cards.push(theme.fg("dim", `${history.length - historyShown} more finished runs · ${inspectAll} for full history`));
	}
	return [...summaryRows, "", ...cards];
}

function contextPage(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();
	const ledger = state.context.ledger;
	if (!ledger)
		return [
			...contextQuadrant(state.context, { width }).slice(1),
			"",
			theme.fg("dim", "Detailed context accounting appears after the prompt is compiled."),
		];
	const out = [
		...wrapTextWithAnsi(
			theme.style(
				"accent",
				state.context.budget
					? `${contextUsageText(state.context)} tokens`
					: `${formatFooterTokens(ledger.usedTokens)} / ${ledger.contextWindow > 0 ? formatFooterTokens(ledger.contextWindow) : "unknown window"} tokens${ledger.percent === null ? "" : ` · ${ledger.percent.toFixed(1)}% occupied`}`,
				{ bold: true },
			),
			width,
		),
		...wrapTextWithAnsi(
			`${state.context.budget ? "Capture diagnostics: " : ""}Free ${ledger.contextWindow > 0 ? formatFooterTokens(ledger.freeTokens) : "unknown"} · reserved ${formatFooterTokens(ledger.reserveTokens)} · ${ledger.toolCount} tool definitions · compaction ${ledger.compactionAuto ? `auto${ledger.compactionThreshold === null ? "" : ` @${Math.round(ledger.compactionThreshold * 100)}%`}` : "manual"}`,
			width,
		),
	];
	out.push(theme.fg("dim", "Context occupancy is per request; subscription limits are account-wide · /usage"));
	const gridWidth = Math.max(12, Math.min(64, width >= FOOTER_SPLIT_COLUMNS ? Math.floor(width * 0.38) : width));
	const gridHeight = width >= FOOTER_SPLIT_COLUMNS ? 8 : 3;
	const grid = renderContextMeterGrid(ledger, gridWidth, gridHeight, theme);
	const legendWidth = width >= FOOTER_SPLIT_COLUMNS ? width - gridWidth - 4 : width;
	const legend = ledger.meter
		.filter((group) => group.tokens > 0)
		.flatMap((group) =>
			wrapTextWithAnsi(
				`${contextCategorySwatch(group.category, theme)} ${group.label.padEnd(20)} ${formatFooterTokens(group.tokens).padStart(7)}  ${group.percent === null ? "unknown" : `${group.percent.toFixed(1)}%`}`,
				legendWidth,
			),
		);
	out.push(
		"",
		rule(theme, width, {
			left: state.context.budget ? "CAPTURE DIAGNOSTICS" : "CONTEXT COMPOSITION",
			leftToken: "accent",
		}),
	);
	out.push(
		...(width >= FOOTER_SPLIT_COLUMNS
			? zipColumns(grid, legend, gridWidth, legendWidth, "    ")
			: [...grid, "", ...legend]),
	);
	out.push(
		...wrapTextWithAnsi(
			theme.fg("muted", "Filled = context · empty = available · shaded = reserve; small buckets receive one cell."),
			width,
		),
	);

	out.push(
		"",
		...wrapTextWithAnsi(
			theme.fg(
				"dim",
				`${ledger.measured ? "Provider-anchored total; category splits estimated" : "Estimated usage"} · window source: ${ledger.contextWindowSource ?? "unknown"}`,
			),
			width,
		),
	);
	if (ledger.lastCompaction)
		out.push(
			...wrapTextWithAnsi(
				`Last compaction: ${formatFooterTokens(ledger.lastCompaction.tokensBefore)} → ${formatFooterTokens(ledger.lastCompaction.tokensAfter)} · ${clean(ledger.lastCompaction.trigger)}`,
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

/** The fewest cells a shortened target and model identity reads in (`blade…q4_k_m`). */
const IDENTITY_MIN_CELLS = 12;

/**
 * As many whole names as fit `room` after `prefix`, closing on `…` when some
 * did not; the first name is cut only when it alone does not fit.
 */
function fitNames(prefix: string, names: readonly string[], room: number): string {
	for (let kept = names.length; kept > 0; kept -= 1) {
		const candidate = `${prefix}${names.slice(0, kept).join(", ")}${kept < names.length ? "…" : ""}`;
		if (visibleWidth(candidate) <= room) return candidate;
	}
	return truncateToWidth(`${prefix}${names[0] ?? ""}`, Math.max(1, room), "…");
}

/** At 60 cells and below, workspace and tips yield; only attention needs a second row. */
export function renderCompactDashboard(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();
	const w = Math.max(1, width);
	const narrow = w <= 60;
	const fit = (s: string, n = w) => truncateToWidth(s, Math.max(1, n), "…", true);
	const ledger = state.context.ledger;
	const workers = state.dispatchRows.filter((row) => ACTIVE_AGENT_STATUSES.has(row.status)).length;
	const phase = state.agent.statusText ?? "Ready";
	const workerText = workers ? ` · ${workers} active` : "";
	const identity = clean(state.session.target ?? "No model selected");
	const usage = contextUsageText(state.context);
	const meter = ledger || state.context.budget ? contextOccupancyBar(state.context, w >= 100 ? 14 : 8, theme) : "";
	// A narrow row drops the absolute token counts before it would cut a number
	// in half, and keeps the percent. The segmented meter states its percent;
	// the ledger meter states only counts, so its percent joins it here.
	const rightBudget = Math.floor(w * 0.48);
	const percent = state.context.budget || !ledger ? "" : ` ${formatContextPercent(contextUsagePercent(state.context))}`;
	const withCounts = `${meter} ${usage}`;
	const fullContext =
		meter.length === 0 || visibleWidth(withCounts) <= rightBudget ? withCounts : `${meter}${percent}`.trimEnd();
	// A label and percentage leave a narrow footer enough room to name the
	// model, while preserving the provenance carried by the expanded counts.
	const occupancy = contextUsagePercent(state.context);
	const source =
		occupancy === null
			? ""
			: state.context.budget?.inputSource === "historical"
				? "saved "
				: state.context.budget
					? "~"
					: "";
	const context = narrow
		? `${theme.fg("dim", "ctx ")}${theme.fg("muted", `${source}${formatContextPercent(occupancy)}`)}`
		: fullContext;
	const rightWidth = Math.min(rightBudget, visibleWidth(context));

	const weekly = state.quotaRoute ? routeWeeklyQuota(state.quotaRoute, state.quota ?? []) : null;
	const leftRoom = Math.max(1, w - rightWidth - 3);
	// An armed skill narrows the tools every turn uses until `/skill off`, so it
	// rides next to the activity and outranks the identity and quota badge.
	// Where `skill <names>` does not fit, the knowledge mark
	// stands in for the word.
	const skills = state.session.activeSkills ?? [];
	const skillBudget = Math.max(5, Math.floor(leftRoom / 3));
	const skillWords = `skill ${clean(skills.join(", "))}`;
	const skill =
		skills.length === 0
			? ""
			: theme.fg(
					"muted",
					visibleWidth(skillWords) <= skillBudget
						? skillWords
						: fitNames(`${GLYPH.classKnowledge} `, skills.map(clean), skillBudget),
				);
	const skillRoom = skill ? visibleWidth(skill) + 3 : 0;
	// The phase and the worker count are the live facts: the activity takes the
	// room it needs beside the skill badge, before the identity and quota badge
	// get theirs. A row too narrow for both drops the
	// worker count before it cuts the phase.
	const activityRoom = Math.max(5, leftRoom - skillRoom);
	const activity =
		visibleWidth(`${phase}${workerText}`) <= activityRoom
			? `${theme.fg("accent", phase)}${theme.fg("agent", workerText)}`
			: theme.fg("accent", truncateToWidth(phase, activityRoom, "…"));
	const activityWidth = visibleWidth(activity);
	const badge =
		weekly && leftRoom - activityWidth - skillRoom - visibleWidth(weekly.label) >= 16
			? theme.fg(
					weekly.severity === "critical" ? "error" : weekly.severity === "normal" ? "muted" : "warning",
					weekly.label,
				)
			: "";
	const identitySeparator = narrow ? " · " : "  ·  ";
	const baseRoom =
		leftRoom - activityWidth - skillRoom - (badge ? visibleWidth(badge) + 3 : 0) - identitySeparator.length;
	// Too narrow for a readable identity: drop it rather than cut it to a stub
	// such as `bl…_m`, which names neither the target nor the model.
	const identityMin = Math.min(visibleWidth(identity), IDENTITY_MIN_CELLS);
	const readable = baseRoom >= identityMin;
	const identityRoom = Math.max(1, baseRoom);
	const fittedIdentity =
		state.session.targetId || state.session.modelId
			? formatTargetLabel(state.session.targetId, state.session.modelId, {
					width: identityRoom,
					abbreviate: false,
				})
			: fitIdentityLabel(identity, identityRoom);
	const shownIdentity = readable ? `${identitySeparator}${theme.fg("muted", fittedIdentity)}` : "";
	const left = `${activity}${skill ? ` · ${skill}` : ""}${shownIdentity}${badge ? ` · ${badge}` : ""}`;
	const pair = (l: string, r: string, rw: number) => `${fit(l, w - rw - 3)}   ${fit(r, rw)}`;
	const notice = topNotification(state.notices, state.now);
	const key = getKeybindings().getKeys("clio-coder.status.toggle").join("/") || "Dashboard";
	const urgent = state.session.shutdownArmed
		? "Ctrl+C again to quit"
		: state.session.leaderArmed
			? "Ctrl+G → choose key"
			: null;
	const foot = urgent
		? theme.fg("warning", urgent)
		: notice
			? theme.fg(notificationToken(notice.level), `${notificationGlyph(notice.level)} ${clean(notice.text)}`)
			: state.demoHint
				? `${theme.fg("accent", "Tip")} ${theme.fg("muted", clean(state.demoHint))}`
				: theme.fg("dim", (state.demo !== false ? footerKeyHint(state.now, w < 120) : null) ?? `${key} Dashboard`);
	if (narrow) {
		const rows = [fit(pair(left, context, rightWidth))];
		if (urgent || notice) rows.push(fit(foot));
		return rows;
	}
	// An armed escape instruction must keep its whole action at narrow widths;
	// the workspace label can yield room that an ordinary rotating hint cannot.
	const hintBudget = urgent ? Math.max(1, w - 3 - 8) : Math.floor(w * 0.48);
	const hintWidth = Math.min(hintBudget, visibleWidth(foot));
	const workspaceWidth = Math.max(1, w - hintWidth - 3);
	const git = `${clean(state.workspace.branch ?? "no Git branch")}${state.workspace.dirty ? " *" : ""}`;
	const gitWidth = Math.min(visibleWidth(git), Math.max(4, Math.floor(workspaceWidth * 0.45)));
	const cwdWidth = Math.max(1, workspaceWidth - gitWidth - 3);
	const workspace = theme.fg(
		"dim",
		`${fitIdentityLabel(clean(state.workspace.cwd), cwdWidth)} · ${fitIdentityLabel(git, gitWidth)}`,
	);
	return [fit(pair(left, context, rightWidth)), fit(pair(workspace, foot, hintWidth))];
}

function statusPage(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();

	const quotaRows = [
		theme.style(
			"accent",
			`SESSION · ${formatFooterTokens(state.sessionTokens?.totalTokens ?? 0)} recorded tokens · ${formatCostAggregate(state.sessionCost) ?? "cost not yet priced"}`,
			{ bold: true },
		),
		...renderQuotaAccounts(state.quota ?? [], width, { compact: true, now: state.now }),
	];

	const active = state.dispatchRows.filter((row) => ACTIVE_AGENT_STATUSES.has(row.status));
	const completed = state.dispatchRows.filter((row) => row.status === "completed").length;
	const failed = state.dispatchRows.filter((row) => ["failed", "dead", "aborted"].includes(row.status)).length;
	const toolCalls = Object.values(state.toolCounts.tools).reduce((a, b) => a + b, 0);
	const resource = state.resources;
	const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
	const capacity = state.agent.localCapacity;
	const memory = state.session.memoryIntervention;
	const section = (title: string, entries: ReadonlyArray<readonly [string, string]>, columns: number) => {
		const labelWidth = Math.min(17, Math.floor(columns * 0.4));
		return [
			theme.fg("accent", title),
			"",
			...entries.map(([label, value]) => {
				let rendered = truncateToWidth(clean(value), Math.max(1, columns - labelWidth - 2), "…", true);
				if (label === "CPU" || label === "RAM")
					rendered = rendered
						.replace(/━+/g, (part) => theme.fg("accent", part))
						.replace(/─+/g, (part) => theme.fg("frame", part));
				return `${theme.fg("dim", truncateToWidth(label, labelWidth, "…", true))}  ${rendered}`;
			}),
			"",
		];
	};
	const throughput = (value: number) =>
		value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB/s` : `${(value / 1024).toFixed(1)} KiB/s`;
	const meter = (percent: number | null) =>
		percent === null
			? "warming up"
			: `${theme.fg("accent", "━".repeat(Math.round(percent / 10)))}${theme.fg("frame", "─".repeat(10 - Math.round(percent / 10)))} ${percent.toFixed(0)}%`;
	const names = (items: string[] | undefined) =>
		items === undefined ? "unreported" : items.length ? `${items.length} · ${items.join(", ")}` : "none";
	const left: [string, string][] = [
		["Target", state.session.target ?? "not selected"],
		["Tracked cost", formatCostAggregate(state.sessionCost) ?? "not yet priced"],
		["Clio ceiling", state.costCeilingUsd === undefined ? "unknown" : `$${state.costCeilingUsd} · tracked pricing only`],
		["MCP connected", names(state.connections?.mcp)],
		["Plugins active", names(state.connections?.plugins)],
		[
			"Extensions",
			state.context.extensions
				? `${state.context.extensions.active} active / ${state.context.extensions.installed} installed`
				: "unreported",
		],
		["Workers", `${active.length} active · ${completed} done · ${failed} unsuccessful`],
		["Tools", `${toolCalls} calls · ${state.toolCounts.active ?? 0} active · ${state.toolCounts.errors} failed`],
		["Worker cap", capacity ? `${capacity.limit} · ${capacity.bound}` : "not sampled"],
	];
	const right: [string, string][] = [
		["Scope", resource?.scope ?? "local OS · sampling"],
		["CPU", resource ? meter(resource.cpuPercent) : "sampling"],
		[
			"RAM",
			resource
				? `${meter((1 - resource.hostFreeBytes / resource.hostTotalBytes) * 100)}  ${gib(resource.hostTotalBytes - resource.hostFreeBytes)} / ${gib(resource.hostTotalBytes)}`
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
				? `${resource.network.name} ↓${throughput(resource.network.receivedPerSecond)} ↑${throughput(resource.network.sentPerSecond)}`
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
				? `${memory.size} entries · ${memory.stepInFlight ? "updating" : (memory.lastDecision ?? "idle")}`
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
	if (width < FOOTER_SPLIT_COLUMNS)
		return [
			...quotaRows,
			...section("COST & CONNECTIONS", left, width),
			...section("LOCAL MACHINE", right, width),
			theme.fg("accent", "CONTEXT ENGINE"),
			...wrapTextWithAnsi(
				extras.map(([label, value]) => `${theme.fg("dim", label)} ${clean(value)}`).join("  ·  "),
				width,
			),
		];
	const col = Math.floor((width - 5) / 2);
	return [
		...quotaRows,
		...zipColumns(
			section("COST & CONNECTIONS", left, col),
			section("LOCAL MACHINE", right, width - col - 5),
			col,
			width - col - 5,
			`  ${theme.fg("frame", "│")}  `,
		),
		theme.fg("accent", "CONTEXT ENGINE"),
		...wrapTextWithAnsi(extras.map(([label, value]) => `${theme.fg("dim", label)} ${clean(value)}`).join("  ·  "), width),
	];
}

export function renderDashboardPage(
	state: FooterDashboardRenderState,
	page: DashboardPage,
	width: number,
	terminalRows: number,
	cycleKey: string,
): string[] {
	const theme = clioTheme();
	const safeWidth = Math.max(1, width);
	const budget = Math.max(8, Math.floor(terminalRows / 4));
	const tabs = DASHBOARD_PAGES.map((name, index) =>
		name === page
			? theme.style("agent", ` ${index + 1} ${name.toUpperCase()} `, { bold: true, underline: true })
			: theme.fg("dim", ` ${index + 1} ${name} `),
	);

	const tabText = `${theme.style("accent", ">C_", { bold: true })} ${tabs.join(" ")}`;
	const identityRoom = safeWidth - visibleWidth(tabText) - 4;
	const identity = clean(state.session.target ?? "No model selected");
	const heading = [
		truncateToWidth(
			identityRoom >= 20 ? `${tabText}    ${theme.fg("muted", fitIdentityLabel(identity, identityRoom))}` : tabText,
			safeWidth,
			"…",
			true,
		),
	];
	const next = page === "Status" ? "close" : DASHBOARD_PAGES[DASHBOARD_PAGES.indexOf(page) + 1];
	const hint = truncateToWidth(
		theme.fg(
			"muted",
			`${cycleKey || "Dashboard"} → ${next}   ·   ${page === "Status" ? "/usage · /mcp · /library" : "composer stays active"}`,
		),
		safeWidth,
		"…",
		true,
	);
	const available = budget - 4;
	let content: string[];
	if (page === "Activity") content = activityPage(state, safeWidth, available);
	else if (page === "Context") content = contextPage(state, safeWidth);
	else content = statusPage(state, safeWidth);
	content = content.flatMap((line) => (visibleWidth(line) > safeWidth ? wrapTextWithAnsi(line, safeWidth) : [line]));
	if (content.length > available) {
		const detail =
			page === "Activity"
				? `${getKeybindings().getKeys("clio-coder.dispatchBoard.toggle").join("/") || "Fleet Runs"} · /view`
				: page === "Context"
					? "/context"
					: "/usage · /context";
		content = [
			...content.slice(0, available - 1),
			truncateToWidth(theme.fg("dim", `More detail: ${detail}`), safeWidth, "…", true),
		];
	}
	while (content.length < available) content.push("");
	return [...heading, rule(theme, safeWidth), ...content, rule(theme, safeWidth), hint];
}
