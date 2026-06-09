import type { SafeEventBus } from "../core/event-bus.js";
import type { ContextLedger, ContextLedgerGroup } from "../domains/session/context-ledger.js";
import { type OverlayHandle, Text, type TUI, visibleWidth } from "../engine/tui.js";
import { contextCategorySwatch, renderContextMeterGrid } from "./context-meter.js";
import { showClioOverlayFrame } from "./overlay-frame.js";
import { abbreviateModelId, type ClioToken, clioTheme } from "./theme/index.js";

const DEFAULT_CONTENT_WIDTH = 68;
const HINT = "[Esc] close";

export const CONTEXT_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

function formatTokens(n: number): string {
	return Math.round(Math.max(0, n)).toLocaleString("en-US");
}

function formatPercent(percent: number | null): string {
	return percent === null ? "--%" : `${percent.toFixed(1)}%`;
}

function gridDimensions(ledger: ContextLedger, contentWidth: number): { cols: number; rows: number } {
	const cols = Math.max(12, Math.min(contentWidth, 40));
	const rows = ledger.contextWindow >= 200_000 ? 8 : 6;
	return { cols, rows };
}

function legendRow(group: ContextLedgerGroup, contentWidth: number): string {
	const theme = clioTheme();
	const swatch = contextCategorySwatch(group.category, theme);
	const tokens = formatTokens(group.tokens);
	const percent = formatPercent(group.percent);
	const right = `${tokens.padStart(9)}  ${percent.padStart(6)}`;
	const labelToken: ClioToken = group.category === "free" || group.category === "reserve" ? "dim" : "muted";
	const leftWidth = Math.max(0, contentWidth - visibleWidth(right) - 2);
	const labelText = group.label.length > leftWidth ? group.label.slice(0, leftWidth) : group.label.padEnd(leftWidth);
	return `${swatch} ${theme.fg(labelToken, labelText)} ${theme.fg("muted", right)}`;
}

export function renderContextLedgerLines(ledger: ContextLedger, contentWidth: number): string[] {
	const theme = clioTheme();
	const lines: string[] = [];

	const provider = ledger.provider ?? "no target";
	const model = ledger.model ? abbreviateModelId(ledger.model) : "no model";
	lines.push(
		`${theme.fg("muted", "target")} ${theme.fg("accent", provider)} ${theme.fg("dim", "·")} ${theme.fg("title", model)}`,
	);
	lines.push("");

	const { cols, rows } = gridDimensions(ledger, contentWidth);
	for (const gridLine of renderContextMeterGrid(ledger, cols, rows, theme)) lines.push(gridLine);
	lines.push("");

	if (ledger.contextWindow > 0) {
		const source = ledger.measured ? "measured" : "≈ estimated";
		const summary = `${formatTokens(ledger.usedTokens)} / ${formatTokens(ledger.contextWindow)} tokens (${formatPercent(ledger.percent)})`;
		lines.push(`${theme.fg("title", summary)} ${theme.fg("dim", "·")} ${theme.fg("muted", source)}`);
	} else {
		lines.push(
			theme.fg("warning", `context window unknown · ${formatTokens(ledger.usedTokens)} tokens estimated in context`),
		);
	}
	lines.push("");

	for (const group of ledger.meter) lines.push(legendRow(group, contentWidth));

	lines.push("");
	const compaction =
		ledger.compactionThreshold !== null
			? `autocompact at ${Math.round(ledger.compactionThreshold * 100)}% (${ledger.compactionAuto ? "auto" : "manual"})`
			: "autocompact off";
	const toolsLabel = ledger.toolCount > 0 ? `${ledger.toolCount} active tool${ledger.toolCount === 1 ? "" : "s"}` : null;
	const footer = toolsLabel ? `${compaction} · ${toolsLabel}` : compaction;
	lines.push(theme.fg("dim", footer));

	return lines;
}

export interface OpenContextOverlayOptions {
	bus?: SafeEventBus;
}

/**
 * Mount the read-only `/context-view` overlay. The ledger is snapshotted on
 * open so reopening after a turn refreshes the figures. Esc closes; no other
 * keys are consumed.
 */
export function openContextOverlay(
	tui: TUI,
	getLedger: () => ContextLedger,
	_options?: OpenContextOverlayOptions,
): OverlayHandle {
	const text = new Text(renderContextLedgerLines(getLedger(), DEFAULT_CONTENT_WIDTH).join("\n"), 0, 0);
	return showClioOverlayFrame(tui, text, {
		anchor: "center",
		width: CONTEXT_OVERLAY_WIDTH,
		title: "Context window",
		footerHint: HINT,
	});
}
