/**
 * Context occupancy for the composer rail and the footer. The composer draws
 * the rail on the first frame, so this stays a leaf: it reaches the meter and
 * bar renderers and type-only accounting shapes, never the footer dashboard
 * and the task, dispatch and worker modules behind it (Stage 0 bundle).
 */

import type { LiveBudgetView } from "../../domains/context/budget/live-view.js";
import type { ContextUsageBreakdown } from "../../domains/session/context-accounting.js";
import type { ContextLedger } from "../../domains/session/context-ledger.js";
import { buildSegmentedContextBar, finiteNonNegative } from "../context-bar.js";
import { renderContextMeterBar } from "../context-meter.js";
import type { ClioTheme } from "../theme/index.js";

/** The published numbers an occupancy reading needs. */
export interface ContextOccupancyFacts {
	/** Identifies the published accounting used by the meter; ledger stays diagnostic. */
	budget?: Pick<LiveBudgetView, "revision" | "historical" | "inputSource">;
	used: number | null;
	contextWindow: number | null;
	toolSchemaTokens: number | null;
	breakdown?: ContextUsageBreakdown | null;
	ledger?: ContextLedger | null;
}

export function contextBreakdownForBar(context: ContextOccupancyFacts): ContextUsageBreakdown | undefined {
	const reportedUsed = finiteNonNegative(context.used);
	const toolTokens = finiteNonNegative(context.toolSchemaTokens);
	const source = context.breakdown;
	if (!source) {
		if (reportedUsed <= 0 && toolTokens <= 0) return undefined;
		return {
			systemPromptTokens: 0,
			toolSchemaTokens: Math.min(toolTokens, reportedUsed),
			messageTokens: Math.max(0, reportedUsed - toolTokens),
			pendingUserTokens: 0,
		};
	}
	const system = finiteNonNegative(source.systemPromptTokens);
	const tools = finiteNonNegative(source.toolSchemaTokens);
	const conversation = finiteNonNegative(source.messageTokens) + finiteNonNegative(source.pendingUserTokens);
	const total = system + tools + conversation;
	if (reportedUsed <= 0 || total <= 0) {
		return {
			systemPromptTokens: system,
			toolSchemaTokens: tools,
			messageTokens: conversation,
			pendingUserTokens: 0,
		};
	}
	if (reportedUsed >= total) {
		return {
			systemPromptTokens: system,
			toolSchemaTokens: tools,
			messageTokens: conversation + (reportedUsed - total),
			pendingUserTokens: 0,
		};
	}
	const scale = reportedUsed / total;
	return {
		systemPromptTokens: system * scale,
		toolSchemaTokens: tools * scale,
		messageTokens: conversation * scale,
		pendingUserTokens: 0,
	};
}

/** The share of the window `contextUsageText` states, in percent; null when either number is unknown. */
export function contextUsagePercent(context: ContextOccupancyFacts): number | null {
	const used = context.budget ? context.used : (context.ledger?.usedTokens ?? context.used);
	const window = context.budget ? context.contextWindow : (context.ledger?.contextWindow ?? context.contextWindow);
	return used === null || !window ? null : (used / window) * 100;
}

/** Reads published numbers only; never refreshes accounting from a renderer. */
export function contextOccupancyBar(
	context: ContextOccupancyFacts,
	cells: number,
	theme: ClioTheme,
	includePercent = true,
): string {
	if (!context.budget && context.ledger) return renderContextMeterBar(context.ledger, cells, theme);
	return buildSegmentedContextBar(
		theme,
		cells,
		context.contextWindow ?? 0,
		context.used === null ? undefined : contextBreakdownForBar(context),
		includePercent,
	);
}

/** Graphic-only composer occupancy, using the same category ink as the dashboard. */
export function contextRailHint(context: ContextOccupancyFacts, cells: number, room: number, theme: ClioTheme): string {
	if (contextUsagePercent(context) === null || (!context.ledger && !context.budget)) return "";
	const fittedCells = Math.max(0, Math.min(cells, Math.floor(room)));
	return fittedCells > 0 ? contextOccupancyBar(context, fittedCells, theme, false) : "";
}
