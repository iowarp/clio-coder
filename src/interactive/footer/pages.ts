import { costAggregateForAmount, formatCostAggregate } from "../../domains/observability/index.js";
/** Expanded footer pages: dense inspection, separate from transcript output style. */
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { redactSecretString } from "../../domains/safety/redaction.js";
import { getKeybindings, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { contextCategorySwatch, renderContextMeterBar, renderContextMeterGrid } from "../context-meter.js";
import { type DispatchBoardRow, dispatchStatusPresentation, renderDispatchActivity } from "../dispatch-board.js";
import { formatFooterTokens } from "../footer-panel.js";
import { previewRows } from "../renderers/preview.js";
import { clioTheme, formatCompactMs, rule } from "../theme/index.js";
import type { FooterDashboardRenderState } from "./dashboard.js";
import { activityQuadrant, contextQuadrant, zipColumns } from "./widgets.js";

export const DASHBOARD_PAGES = ["Activity", "Context", "Status"] as const;
export type DashboardPage = (typeof DASHBOARD_PAGES)[number];
const ACTIVE_AGENT_STATUSES = new Set(["running", "enqueued", "cancelling", "retrying", "stale"]);
const clean = (value: string) => sanitizeCallTargetText(redactSecretString(value));

function agentCard(row: DispatchBoardRow, width: number, compact = false): string[] {
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
					agentCard(first, col, true),
					agentCard(second, width - col - 5, true),
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
			const card = agentCard(row, width, active.length > 1 || cardBudget < 18);
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
				`${formatFooterTokens(ledger.usedTokens)} / ${ledger.contextWindow > 0 ? formatFooterTokens(ledger.contextWindow) : "unknown window"} tokens${ledger.percent === null ? "" : ` · ${ledger.percent.toFixed(1)}% occupied`}`,
				{ bold: true },
			),
			width,
		),
		...wrapTextWithAnsi(
			`Free ${ledger.contextWindow > 0 ? formatFooterTokens(ledger.freeTokens) : "unknown"} · reserved ${formatFooterTokens(ledger.reserveTokens)} · ${ledger.toolCount} tool definitions · compaction ${ledger.compactionAuto ? `auto${ledger.compactionThreshold === null ? "" : ` @${Math.round(ledger.compactionThreshold * 100)}%`}` : "manual"}`,
			width,
		),
	];
	const gridWidth = Math.max(12, Math.min(64, width >= 76 ? Math.floor(width * 0.38) : width));
	const gridHeight = width >= 76 ? 8 : 3;
	const grid = renderContextMeterGrid(ledger, gridWidth, gridHeight, theme);
	const legendWidth = width >= 76 ? width - gridWidth - 4 : width;
	const legend = ledger.meter
		.filter((group) => group.tokens > 0)
		.flatMap((group) =>
			wrapTextWithAnsi(
				`${contextCategorySwatch(group.category, theme)} ${group.label.padEnd(20)} ${formatFooterTokens(group.tokens).padStart(7)}  ${group.percent === null ? "unknown" : `${group.percent.toFixed(1)}%`}`,
				legendWidth,
			),
		);
	out.push("", rule(theme, width, { left: "CONTEXT COMPOSITION", leftToken: "accent" }));
	out.push(...(width >= 76 ? zipColumns(grid, legend, gridWidth, legendWidth, "    ") : [...grid, "", ...legend]));
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
				`${ledger.measured ? "Usage anchored to provider measurements" : "Estimated usage"} · window source: ${ledger.contextWindowSource ?? "unknown"}`,
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

/** Two-line ambient strip. Notices borrow workspace space until dismissed/expired. */
export function renderCompactDashboard(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();
	const w = Math.max(1, width);
	const fit = (s: string, n = w) => truncateToWidth(s, Math.max(1, n), "…", true);
	const ledger = state.context.ledger;
	const workers = state.dispatchRows.filter((row) => ACTIVE_AGENT_STATUSES.has(row.status)).length;
	const phase = state.agent.statusText ?? "Ready";
	const left = `${theme.fg("accent", phase)}${workers ? theme.fg("agent", `  ·  ${workers} active`) : ""}`;
	const usage = `${formatFooterTokens(ledger?.usedTokens ?? state.context.used ?? 0)} / ${(ledger?.contextWindow ?? state.context.contextWindow) ? formatFooterTokens(ledger?.contextWindow ?? state.context.contextWindow ?? 0) : "?"}`;
	const context = `${ledger ? renderContextMeterBar(ledger, w >= 100 ? 14 : 8, theme) : ""} ${usage}`;
	const rightWidth = Math.min(Math.floor(w * 0.48), visibleWidth(context));
	const pair = (l: string, r: string, rw: number) => `${fit(l, w - rw - 3)}   ${fit(r, rw)}`;
	const notice = [...state.notices]
		.filter((n) => n.expiresAt === null || n.expiresAt > state.now)
		.sort((a, b) => b.addedAt - a.addedAt)[0];
	const key = getKeybindings().getKeys("clio-coder.status.toggle").join("/") || "Dashboard";
	const urgent = state.session.shutdownArmed
		? "Ctrl+C again to quit"
		: state.session.leaderArmed
			? "Ctrl+G → choose key"
			: null;
	const foot = urgent
		? theme.fg("warning", urgent)
		: notice
			? theme.fg(
					notice.level === "error" ? "error" : notice.level === "warning" ? "warning" : "muted",
					`• ${clean(notice.text)}`,
				)
			: theme.fg(
					"dim",
					`${clean(state.workspace.cwd)}  ·  ${clean(state.workspace.branch ?? "no Git branch")}${state.workspace.dirty ? " *" : ""}`,
				);
	const hint = theme.fg("muted", `${state.session.throughput ? `${state.session.throughput}  ·  ` : ""}${key}`);
	return [
		fit(pair(left, context, rightWidth)),
		fit(pair(foot, hint, Math.min(Math.floor(w * 0.4), visibleWidth(hint)))),
	];
}

function statusPage(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();

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
		["Provider quota", "not reported by provider"],
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
			resource ? `${Math.max(0, Math.round((Date.now() - resource.sampledAt) / 1000))}s ago · 2s cadence` : "pending",
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
	if (width < 76)
		return [
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
	const heading = [
		truncateToWidth(`${theme.style("accent", ">C_", { bold: true })} ${tabs.join(" ")}`, safeWidth, "…", true),
	];
	const next = page === "Status" ? "close" : DASHBOARD_PAGES[DASHBOARD_PAGES.indexOf(page) + 1];
	const hint = truncateToWidth(
		theme.fg(
			"muted",
			`${cycleKey || "Dashboard"} → ${next}   ·   ${page === "Status" ? "/cost · /mcp · /library" : "composer stays active"}`,
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
					: "/cost · /context";
		content = [
			...content.slice(0, available - 1),
			truncateToWidth(theme.fg("dim", `More detail: ${detail}`), safeWidth, "…", true),
		];
	}
	while (content.length < available) content.push("");
	return [...heading, rule(theme, safeWidth), ...content, rule(theme, safeWidth), hint];
}
