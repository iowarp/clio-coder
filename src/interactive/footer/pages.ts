import { costAggregateForAmount, formatCostAggregate } from "../../domains/observability/index.js";
/** Expanded footer pages: dense inspection, separate from transcript output style. */
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { redactSecretString } from "../../domains/safety/redaction.js";
import { getKeybindings, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { CONTEXT_CATEGORY_TOKEN, renderContextMeterBar } from "../context-meter.js";
import { type DispatchBoardRow, dispatchStatusPresentation } from "../dispatch-board.js";
import { formatFooterTokens } from "../footer-panel.js";
import { previewRows } from "../renderers/preview.js";
import { clioTheme, formatCompactMs, rule } from "../theme/index.js";
import type { FooterDashboardRenderState } from "./dashboard.js";
import { activityQuadrant, contextQuadrant, sessionQuadrant, workspaceQuadrant, zipColumns } from "./widgets.js";

export const DASHBOARD_PAGES = ["Activity", "Context", "Status"] as const;
export type DashboardPage = (typeof DASHBOARD_PAGES)[number];
const clean = (value: string) => sanitizeCallTargetText(redactSecretString(value));

function agentCard(row: DispatchBoardRow, width: number): string[] {
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
	if (row.taskSummary) lines.push(...field("Task", row.taskSummary));
	const action = row.progress?.currentAction;
	if (action)
		lines.push(
			...field(
				"Now",
				action.descriptor ? `${action.descriptor.verb} ${action.descriptor.object ?? ""}` : action.tool,
			).slice(0, 2),
		);
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
	if (timing.length) lines.push(...field("Timing", timing.join(" · ")));
	if (row.budget)
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
	const live = new Set(["running", "enqueued", "cancelling"]);
	const rows = [...state.dispatchRows].sort((a, b) => Number(live.has(b.status)) - Number(live.has(a.status)));
	if (!rows.length)
		return [...summary, "", theme.fg("dim", "No agent invocations yet. Worker cards appear here as agents start.")];
	const midpoint = Math.ceil(summary.length / 2);
	const summaryRows = sideBySide
		? zipColumns(summary.slice(0, midpoint), summary.slice(midpoint), summaryWidth, width - summaryWidth - 3, "   ")
		: summary;
	const cardWidth = width;
	const cardBudget = budget - summaryRows.length - 1;
	const cards = [rule(theme, cardWidth, { left: "AGENT ACTIVITY", leftToken: "agent" })];
	let shown = 0;
	for (const row of rows) {
		const card = agentCard(row, cardWidth);
		if (cards.length + card.length + 2 > cardBudget && shown > 0) break;
		cards.push(...card, "");
		shown++;
	}
	if (shown < rows.length)
		cards.push(
			theme.fg(
				"dim",
				`${rows.length - shown} more agent runs · ${getKeybindings().getKeys("clio-coder.dispatchBoard.toggle").join("/") || "Workers shortcut"} for all`,
			),
		);
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
		renderContextMeterBar(ledger, Math.max(1, Math.min(100, width)), theme),
		...wrapTextWithAnsi(
			`Free ${ledger.contextWindow > 0 ? formatFooterTokens(ledger.freeTokens) : "unknown"} · reserved ${formatFooterTokens(ledger.reserveTokens)} · ${ledger.toolCount} tool definitions · compaction ${ledger.compactionAuto ? `auto${ledger.compactionThreshold === null ? "" : ` @${Math.round(ledger.compactionThreshold * 100)}%`}` : "manual"}`,
			width,
		),
	];
	out.push("", rule(theme, width, { left: "CONTEXT COMPOSITION", leftToken: "tool" }));
	const barWidth = Math.max(4, Math.min(40, width - 38));
	for (const group of ledger.meter) {
		if (group.tokens <= 0) continue;
		const cells = Math.round(
			(ledger.contextWindow > 0 ? Math.min(1, group.tokens / ledger.contextWindow) : 0) * barWidth,
		);
		const tone = CONTEXT_CATEGORY_TOKEN[group.category];
		const bar = theme.fg(tone, "━".repeat(cells)) + theme.fg("frame", "─".repeat(barWidth - cells));
		out.push(
			...wrapTextWithAnsi(
				`${group.label.padEnd(19)} ${bar} ${theme.fg("accent", formatFooterTokens(group.tokens).padStart(7))} ${theme.fg("dim", group.percent === null ? "" : `${group.percent.toFixed(1)}%`)}`,
				width,
			),
		);
	}
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

export function renderDashboardPage(
	state: FooterDashboardRenderState,
	page: DashboardPage,
	width: number,
	terminalRows: number,
	cycleKey: string,
): string[] {
	const theme = clioTheme();
	const safeWidth = Math.max(1, width);
	const budget = Math.max(6, terminalRows - 7);
	const tabs = DASHBOARD_PAGES.map((name, index) =>
		name === page
			? theme.paint(` ${index + 1} ${name.toUpperCase()} `, { bg: "agent", fg: "frame", bold: true })
			: theme.fg("dim", ` ${index + 1} ${name} `),
	);
	const heading = wrapTextWithAnsi(`${theme.style("accent", ">C_", { bold: true })} ${tabs.join(" ")}`, safeWidth);
	let content: string[];
	if (page === "Activity") content = activityPage(state, safeWidth, budget - heading.length - 3);
	else if (page === "Context") content = contextPage(state, safeWidth);
	else {
		const split = Math.floor((safeWidth - 3) / 2);
		content =
			safeWidth >= 100
				? zipColumns(
						sessionQuadrant(state.session, { width: split }),
						workspaceQuadrant(state.workspace, { width: safeWidth - split - 3 }),
						split,
						safeWidth - split - 3,
						theme.fg("frame", " │ "),
					)
				: [
						...sessionQuadrant(state.session, { width: safeWidth }),
						"",
						...workspaceQuadrant(state.workspace, { width: safeWidth }),
					];
	}
	const next = page === "Status" ? "close dashboard" : `${DASHBOARD_PAGES[DASHBOARD_PAGES.indexOf(page) + 1]} page`;
	const hint = wrapTextWithAnsi(
		theme.fg("dim", `${cycleKey || "Dashboard shortcut"} → ${next} · composer stays active`),
		safeWidth,
	);
	const available = Math.max(1, budget - heading.length - hint.length - 2);
	if (content.length > available)
		content = [
			...content.slice(0, Math.max(0, available - 1)),
			theme.fg(
				"dim",
				`… ${content.length - available + 1} more rows · ${page === "Activity" ? getKeybindings().getKeys("clio-coder.dispatchBoard.toggle").join("/") || "Workers shortcut" : page === "Context" ? "/context" : "enlarge the terminal"} for full details`,
			),
		];
	return [...heading, rule(theme, safeWidth), ...content, rule(theme, safeWidth), ...hint].flatMap((line) =>
		visibleWidth(line) > safeWidth ? wrapTextWithAnsi(line, safeWidth) : [line],
	);
}
