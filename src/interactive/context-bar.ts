/**
 * The segmented context bar, apart from the footer panel. The composer rail
 * draws it on the first frame, so it lives in a leaf that reaches only the
 * meter glyphs and theme; the footer panel's dispatch and worker-stream
 * imports would otherwise pull the runtime into the Stage 0 bundle.
 */

import { contextBarGlyphs, contextPercentRole, largestRemainderCells } from "./context-meter.js";
import type { ClioTheme } from "./theme/index.js";
import { formatContextPercent } from "./theme/index.js";

const CONTEXT_PERCENT_FIELD_WIDTH = 6;
export const CONTEXT_BAR_LABEL_WIDTH = 2 + CONTEXT_PERCENT_FIELD_WIDTH;

type SegmentBreakdownInput = {
	systemPromptTokens: number;
	toolSchemaTokens: number;
	messageTokens: number;
	pendingUserTokens: number;
};

export function finiteNonNegative(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function contextPercentLabel(theme: ClioTheme, percent: number | null): string {
	const role = contextPercentRole(percent);
	return `  ${theme.fg(role, formatContextPercent(percent).padEnd(CONTEXT_PERCENT_FIELD_WIDTH, " "))}`;
}

export function buildSegmentedContextBar(
	theme: ClioTheme,
	barWidth: number,
	contextWindow: number,
	breakdown: SegmentBreakdownInput | undefined,
	includePercent = true,
): string {
	const cells = Math.max(0, Math.floor(Number.isFinite(barWidth) ? barWidth : 0));
	const glyphs = contextBarGlyphs();

	if (contextWindow <= 0 || !Number.isFinite(contextWindow) || !breakdown) {
		return `${theme.fg("meterFree", glyphs.free.repeat(cells))}${includePercent ? contextPercentLabel(theme, null) : ""}`;
	}

	const system = finiteNonNegative(breakdown.systemPromptTokens);
	const tools = finiteNonNegative(breakdown.toolSchemaTokens);
	const conversation = finiteNonNegative(breakdown.messageTokens) + finiteNonNegative(breakdown.pendingUserTokens);
	const categoryTotal = system + tools + conversation;
	const used = Math.max(0, Math.min(categoryTotal, contextWindow));
	const percent = (used / contextWindow) * 100;
	let filled = Math.max(0, Math.min(cells, Math.round((used / contextWindow) * cells)));
	if (used > 0) filled = Math.max(1, filled);

	const scale = categoryTotal > 0 && used < categoryTotal ? used / categoryTotal : 1;
	const weights = [system * scale, tools * scale, conversation * scale];
	const [systemCells = 0, toolCells = 0, conversationCells = 0] = largestRemainderCells(
		weights,
		weights.reduce((sum, value) => sum + value, 0),
		filled,
	);
	const freeCells = Math.max(0, cells - filled);
	const systemPart = systemCells > 0 ? theme.fg("meterSystem", glyphs.filled.repeat(systemCells)) : "";
	const toolPart = toolCells > 0 ? theme.fg("meterTools", glyphs.filled.repeat(toolCells)) : "";
	const conversationPart =
		conversationCells > 0 ? theme.fg("meterConversation", glyphs.filled.repeat(conversationCells)) : "";
	const freePart = freeCells > 0 ? theme.fg("meterFree", glyphs.free.repeat(freeCells)) : "";
	return `${systemPart}${toolPart}${conversationPart}${freePart}${includePercent ? contextPercentLabel(theme, percent) : ""}`;
}
