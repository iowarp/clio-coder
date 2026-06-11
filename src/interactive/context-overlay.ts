import { BusChannels } from "../core/bus-events.js";
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

	if (ledger.promptCache) {
		const cache = ledger.promptCache;
		const shell = cache.shellReused ? "shell reused" : "shell recompiled";
		const backend =
			cache.backendVerdict === "hot" || cache.backendVerdict === "partial"
				? "backend reused"
				: cache.backendVerdict === "cold"
					? "backend cold"
					: cache.backendVerdict === "small"
						? "backend small"
						: "backend n/a";
		const read = cache.cacheReadTokens !== null ? `cache read ${formatTokens(cache.cacheReadTokens)}` : "cache read n/a";
		const uncached =
			cache.uncachedInputTokens !== null ? `uncached input ${formatTokens(cache.uncachedInputTokens)}` : null;
		const line = ["prompt cache:", shell, "·", backend, "·", read, ...(uncached ? ["·", uncached] : [])].join(" ");
		// A reused shell with a cold backend means Clio kept the bytes stable
		// but the provider re-prefilled anyway; surface that disagreement
		// instead of hiding it.
		const misleading = cache.shellReused && cache.backendVerdict === "cold";
		lines.push(theme.fg(misleading ? "warning" : "dim", line));
	}

	if (ledger.lastCompaction) {
		const pruneInfo = `last compaction: reclaimed ${formatTokens(ledger.lastCompaction.tokensBefore)} -> ${formatTokens(ledger.lastCompaction.tokensAfter)} tokens (${ledger.lastCompaction.stage})`;
		lines.push(theme.fg("dim", pruneInfo));
	}

	return lines;
}

/** How often the streaming fallback tick repaints the overlay. */
const STREAMING_FALLBACK_TICK_MS = 1000;

export interface OpenContextOverlayOptions {
	bus?: SafeEventBus;
	/**
	 * Chat event source. When wired, the overlay refreshes as turns settle
	 * (message_end/agent_end) and runs a slow fallback tick only while a
	 * response is streaming, so the in-flight output counter stays live.
	 */
	chat?: {
		onEvent(handler: (event: { type: string }) => void): () => void;
		isStreaming(): boolean;
	};
}

/**
 * Mount the read-only `/context-view` overlay. Event-driven: bus compaction
 * events and chat turn boundaries trigger repaints; a slow (1s) tick covers
 * the streaming window where token counts move between events. Esc closes;
 * no other keys are consumed.
 */
export function openContextOverlay(
	tui: TUI,
	getLedger: () => ContextLedger,
	options?: OpenContextOverlayOptions,
): OverlayHandle {
	const text = new Text(renderContextLedgerLines(getLedger(), DEFAULT_CONTENT_WIDTH).join("\n"), 0, 0);
	const handle = showClioOverlayFrame(tui, text, {
		anchor: "center",
		width: CONTEXT_OVERLAY_WIDTH,
		title: "Context window",
		footerHint: HINT,
	});

	const refresh = (): void => {
		text.setText(renderContextLedgerLines(getLedger(), DEFAULT_CONTENT_WIDTH).join("\n"));
		text.invalidate();
		tui.requestRender();
	};

	let fallbackTicker: ReturnType<typeof setInterval> | null = null;
	const stopFallbackTicker = (): void => {
		if (fallbackTicker === null) return;
		clearInterval(fallbackTicker);
		fallbackTicker = null;
	};
	const startFallbackTicker = (): void => {
		if (fallbackTicker !== null) return;
		fallbackTicker = setInterval(refresh, STREAMING_FALLBACK_TICK_MS);
		fallbackTicker.unref?.();
	};

	const unsubscribes: Array<() => void> = [];
	if (options?.bus) {
		unsubscribes.push(options.bus.on(BusChannels.ContextPruned, refresh));
		unsubscribes.push(options.bus.on(BusChannels.ContextWarning, refresh));
	}
	if (options?.chat) {
		unsubscribes.push(
			options.chat.onEvent((event) => {
				if (event.type === "agent_start") {
					startFallbackTicker();
					refresh();
				} else if (event.type === "agent_end") {
					stopFallbackTicker();
					refresh();
				} else if (event.type === "message_end") {
					refresh();
				}
			}),
		);
		if (options.chat.isStreaming()) startFallbackTicker();
	} else {
		// No streaming signal available; keep a slow tick so the overlay does
		// not freeze for callers that only pass a ledger getter.
		startFallbackTicker();
	}

	return {
		...handle,
		hide(): void {
			stopFallbackTicker();
			for (const off of unsubscribes) off();
			handle.hide();
		},
	};
}
