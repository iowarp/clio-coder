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
	const gridHeight = width >= 76 ? 10 : 4;
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
			theme.fg(
				"muted",
				"Filled = context · empty = available · shaded = reserve. Small buckets get at least one cell; counts are authoritative.",
			),
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

/** Fixed-height instrument strip: aligned work/context lanes, then workspace footing. */
export function renderCompactDashboard(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();
	const w = Math.max(1, width);
	const fit = (value: string) => truncateToWidth(value, w, "…", true);
	const workers = state.dispatchRows.filter((row) => ACTIVE_AGENT_STATUSES.has(row.status));
	const ledger = state.context.ledger;
	const used = ledger?.usedTokens ?? state.context.used;
	const window = ledger?.contextWindow ?? state.context.contextWindow;
	const usage = `${used == null ? "?" : formatFooterTokens(used)} / ${window ? formatFooterTokens(window) : "?"}`;
	const key = getKeybindings().getKeys("clio-coder.status.toggle").join("/") || "Dashboard";
	const calls = Object.values(state.toolCounts.tools).reduce((sum, count) => sum + count, 0);
	const work = theme.style("accent", state.agent.statusText ?? "Ready", { bold: true });
	const activity = [
		workers.length
			? theme.fg("agent", `${workers.length} ${workers.length === 1 ? "agent" : "agents"} active`)
			: theme.fg("muted", "No active agents"),
		`${calls} tools`,
		state.toolCounts.errors ? theme.fg("error", `${state.toolCounts.errors} failed`) : null,
	]
		.filter(Boolean)
		.join("  ·  ");
	const meter = ledger ? renderContextMeterBar(ledger, w >= 100 ? 20 : 12, theme) : "";
	const context = `${meter}  ${usage}`;
	const metrics = [
		state.session.throughput,
		ledger?.percent == null ? null : `${ledger.percent.toFixed(1)}% occupied`,
		state.session.cost,
	]
		.filter(Boolean)
		.join("  ·  ");
	const branch = state.workspace.branch
		? `${clean(state.workspace.branch)}${state.workspace.dirty === true ? " *" : state.workspace.dirty === false ? " ✓" : ""}`
		: "no Git branch";
	const urgent = state.session.shutdownArmed
		? "Ctrl+C again to quit"
		: state.session.leaderArmed
			? "Ctrl+G → choose key"
			: null;
	const location = urgent
		? theme.fg("warning", urgent)
		: theme.fg("muted", `${clean(state.workspace.cwd)}  ·  ${branch}`);
	const hint = theme.fg("agent", `${key} dashboard`);
	const lane = Math.floor((w - 5) / 2);
	const pair = (left: string, right: string) =>
		`${truncateToWidth(left, lane, "…", false)}${" ".repeat(Math.max(0, lane - Math.min(lane, visibleWidth(left))))}  ${theme.fg("frame", "│")}  ${truncateToWidth(right, w - lane - 5, "…", true)}`;
	if (w >= 76)
		return [
			fit(pair(theme.style("accent", "ACTIVITY", { bold: true }), theme.style("accent", "CONTEXT", { bold: true }))),
			fit(pair(work, context)),
			fit(pair(activity, metrics || theme.fg("muted", "Measurements pending"))),
			rule(theme, w),
			fit(
				`${truncateToWidth(location, Math.max(1, w - visibleWidth(hint) - 3), "…", false)}${" ".repeat(Math.max(2, w - Math.min(visibleWidth(location), Math.max(1, w - visibleWidth(hint) - 3)) - visibleWidth(hint)))}${hint}`,
			),
		];
	return [fit(work), fit(activity), fit(context), fit(location), fit(hint)];
}

function statusPage(state: FooterDashboardRenderState, width: number): string[] {
	const theme = clioTheme();
	const session = state.session;
	const workspace = state.workspace;
	const memory = session.memoryIntervention;
	const ledger = state.context.ledger;
	type Section = { title: string; entries: ReadonlyArray<readonly [string, string]> };
	const sections: Section[] = [
		{
			title: "SESSION & INFERENCE",
			entries: [
				["Session", session.name ? `${session.name} · ${session.id ?? "unsaved"}` : (session.id ?? "not assigned")],

				["Model route", session.target ?? "not selected"],
				["Thinking", session.thinking ?? "unknown"],
				["Capabilities", session.capabilities?.join(" · ") || "not yet known"],

				["Processed usage", session.tokens ?? "not yet reported"],
				["Tracked cost", session.cost ?? "not yet priced"],
				["Mode", `${session.safety ?? "unknown"} · ${session.outputStyle ?? "standard"}`],
			],
		},
		{
			title: "PROJECT & RESOURCES",
			entries: [
				["Directory", workspace.cwd],
				[
					"Git",
					`${workspace.branch ?? "no branch"} · ${workspace.dirty === null ? "state unknown" : workspace.dirty ? "uncommitted changes" : "clean"}`,
				],
				["Project type", workspace.projectType ?? "not detected"],

				[
					"Instructions",
					ledger?.projectHandbookFiles?.length
						? ledger.projectHandbookFiles.join(" · ")
						: (state.context.clioMd ?? "not yet resolved"),
				],

				["Tool surface", ledger ? `${ledger.toolCount} definitions in prompt` : "not yet compiled"],
				[
					"Extensions",
					state.context.extensions
						? `${state.context.extensions.active} active / ${state.context.extensions.installed} installed`
						: "not reported",
				],
				[
					"Memory",
					memory
						? `${memory.enabled ? "on" : "off"} · ${memory.tier} · ${memory.size} entries${memory.stepInFlight ? " · updating" : ""}`
						: (state.context.memory ?? "not reported"),
				],
			],
		},
		...(state.harness ?? [
			{ title: "HARNESS SETTINGS", entries: [["Settings", "not available in this snapshot"]] as const },
		]),
	];
	const priority: Record<string, string[]> = {
		"PERMISSIONS & LIMITS": [
			"Autonomy",
			"Worker approvals",
			"Safety review",
			"Configured cost ceiling",
			"Worker tool-call limit",
		],
		"EXECUTION & CONTEXT POLICY": ["Fleet concurrency", "Worker default", "Retries", "Working set", "Compaction"],
	};
	const render = (section: Section, columns: number) => {
		const entries = priority[section.title]
			? section.entries.filter(([label]) => priority[section.title]?.includes(label))
			: section.entries;
		const labelWidth = Math.min(23, Math.floor(columns * 0.4));
		return [
			theme.style("accent", section.title, { bold: true }),
			"",
			...entries.flatMap(([label, value]) => {
				const prefix = theme.fg("muted", truncateToWidth(label, labelWidth, "…", true).padEnd(labelWidth));
				const values = wrapTextWithAnsi(clean(value), Math.max(1, columns - labelWidth - 2));
				return values.map((line, index) => `${index ? " ".repeat(labelWidth) : prefix}  ${line}`);
			}),
			"",
		];
	};
	if (width < 76) return sections.flatMap((section) => render(section, width));
	const col = Math.floor((width - 5) / 2);
	const left = [...(sections[0] ? render(sections[0], col) : []), ...(sections[2] ? render(sections[2], col) : [])];
	const right = [
		...(sections[1] ? render(sections[1], width - col - 5) : []),
		...(sections[3] ? render(sections[3], width - col - 5) : []),
	];
	return zipColumns(left, right, col, width - col - 5, `  ${theme.fg("frame", "│")}  `);
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
	const budget = Math.max(8, Math.floor(terminalRows / 3));
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
			`${cycleKey || "Dashboard"} → ${next}   ·   ${page === "Status" ? "/settings · /context for details" : "composer stays active"}`,
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
					: "/settings · /context";
		content = [
			...content.slice(0, available - 1),
			truncateToWidth(theme.fg("dim", `More detail: ${detail}`), safeWidth, "…", true),
		];
	}
	while (content.length < available) content.push("");
	return [...heading, rule(theme, safeWidth), ...content, rule(theme, safeWidth), hint];
}
