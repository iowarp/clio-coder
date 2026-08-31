import { homedir } from "node:os";
import { relative } from "node:path";
import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { WorkingSetView } from "../domains/context/working-set/contract.js";
import { formatContextWindowSlots } from "../domains/providers/index.js";
import type { ContextLedger, ContextLedgerGroup } from "../domains/session/context-ledger.js";
import { type OverlayHandle, Text, type TUI, visibleWidth } from "../engine/tui.js";
import { contextCategorySwatch, renderContextMeterGrid, renderEvictedTokensLine } from "./context-meter.js";
import { buildHint, showClioOverlayFrame } from "./overlay-frame.js";
import { abbreviateModelId, type ClioToken, clioTheme, formatContextPercent } from "./theme/index.js";

const DEFAULT_CONTENT_WIDTH = 68;

export const CONTEXT_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

function formatTokens(n: number): string {
	return Math.round(Math.max(0, n)).toLocaleString("en-US");
}

/**
 * One word for where the window came from. `loaded` is the window the backend
 * has this model open at, `declared` is what a catalog or the model's own
 * metadata claims it could support, and the two differ often enough on
 * self-hosted targets that reading a percentage without knowing which one it is
 * measured against tells the operator nothing.
 */
function contextWindowProvenanceLabel(source: ContextLedger["contextWindowSource"]): string | null {
	switch (source) {
		case "loaded":
			return "loaded";
		case "probe":
			return "probed";
		case "target-override":
			return "configured";
		case "catalog":
		case "model-hint":
			return "declared";
		case "descriptor-default":
		case "unknown":
			return "assumed";
		default:
			return null;
	}
}

/** A handbook path the operator can read at a glance: workspace-relative when
 * the file sits under the current directory, `~`-shortened otherwise. */
function displayHandbookPath(filePath: string): string {
	const rel = relative(process.cwd(), filePath);
	if (rel.length > 0 && !rel.startsWith("..")) return rel;
	const home = homedir();
	return home.length > 0 && filePath.startsWith(`${home}/`) ? `~${filePath.slice(home.length)}` : filePath;
}

/**
 * Which CLIO-CODER*.md file(s) the compiled prompt actually selected. With
 * override semantics the operator cannot infer the winner from the preload
 * size alone, so the effective chain is named explicitly, nearest last.
 */
function handbookProvenanceLines(handbookFiles: ReadonlyArray<string> | null): string[] {
	if (!handbookFiles || handbookFiles.length === 0) return [];
	const first = handbookFiles[0];
	if (handbookFiles.length === 1 && first !== undefined) return [`handbook: ${displayHandbookPath(first)}`];
	return ["handbooks (ancestor → nearest):", ...handbookFiles.map((filePath) => `  ${displayHandbookPath(filePath)}`)];
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
	const percent = formatContextPercent(group.percent);
	const right = `${tokens.padStart(9)}  ${percent.padStart(6)}`;
	const labelToken: ClioToken = group.category === "reserve" ? "frame" : group.category === "free" ? "dim" : "muted";
	const leftWidth = Math.max(0, contentWidth - visibleWidth(right) - 2);
	const labelText = group.label.length > leftWidth ? group.label.slice(0, leftWidth) : group.label.padEnd(leftWidth);
	return `${swatch} ${theme.fg(labelToken, labelText)} ${theme.fg("muted", right)}`;
}

function evictedTokens(view: WorkingSetView): number {
	let total = 0;
	for (const state of view.evicted.values()) total += state.tokensFreed;
	return total;
}

function formatChurn(view: WorkingSetView): string {
	if (view.itemsEvicted === 0) return "n/a";
	return (view.recalls / view.itemsEvicted).toFixed(2);
}

/**
 * Prose for one cache-disturbance reason. The wire values are stamped by
 * `noteColdReason` in turn-context.ts and persisted on the assistant entry's
 * `promptCache.expectedColdReasons`; the overlay reads them back, so an unknown
 * reason renders as itself rather than disappearing.
 */
function coldReasonLabel(reason: string): string {
	switch (reason) {
		case "working_set_evict":
			return "working-set eviction";
		case "compaction":
			return "compaction";
		case "dispatch":
			return "dispatch traffic";
		case "residency":
			return "residency change";
		case "thinking_change":
			return "thinking-level change";
		case "tool_surface_change":
			return "tool-surface change";
		case "prompt_recompiled":
			return "prompt recompile";
		case "background_memory":
			return "background memory step";
		default:
			return reason;
	}
}

/** The operator's working-set configuration, as `/context` states it. */
export interface WorkingSetConfigView {
	enabled: boolean;
	policy: string;
}

/**
 * The working-set section: what the projection has taken out of the window
 * and how often the model has asked for it back. Churn is recalls over items
 * evicted; a high number means the policy evicts what is still needed.
 */
/**
 * The policy line names what is configured, not what last ran. `lastPolicyId`
 * is stamped by the first applied event, and eviction runs only when pressure
 * crosses `compaction.threshold`, so a whole session at the shipped default
 * read `policy none` (issue #190). With no configuration in hand (older
 * callers) the last applied policy is still the best available claim.
 */
function workingSetPolicyLabel(view: WorkingSetView, config: WorkingSetConfigView | null | undefined): string {
	if (config === null || config === undefined) return `policy ${view.lastPolicyId ?? "none"}`;
	if (!config.enabled) return "disabled";
	const state = view.evictionEvents === 0 ? " · no events yet" : "";
	const lastRan =
		view.lastPolicyId !== null && view.lastPolicyId !== config.policy ? ` (last event by ${view.lastPolicyId})` : "";
	return `policy ${config.policy}${lastRan}${state}`;
}

function renderWorkingSetLines(view: WorkingSetView, config: WorkingSetConfigView | null | undefined): string[] {
	const theme = clioTheme();
	const items = view.evicted.size;
	const summary = [
		`${items} evicted item${items === 1 ? "" : "s"}`,
		`${formatTokens(evictedTokens(view))} tokens`,
		`${view.evictionEvents} event${view.evictionEvents === 1 ? "" : "s"}`,
		`${view.recalls} recall${view.recalls === 1 ? "" : "s"}`,
		`churn ${formatChurn(view)}`,
	].join(" · ");
	return [
		`${theme.fg("muted", "working set")} ${theme.fg("dim", "·")} ${theme.fg("accent", workingSetPolicyLabel(view, config))}`,
		theme.fg("dim", summary),
	];
}

export function renderContextLedgerLines(
	ledger: ContextLedger,
	contentWidth: number,
	workingSet?: WorkingSetView | null,
	workingSetConfig?: WorkingSetConfigView | null,
): string[] {
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
		// `196,608 (786,432 / 4 slots)`: a llama.cpp window that is one slot's
		// share of the server's KV budget names the split, because the bare
		// number reads as the whole server and the meter is measured against
		// the share (issue #187).
		const window = ledger.contextWindowSlots
			? formatContextWindowSlots(ledger.contextWindow, ledger.contextWindowSlots)
			: formatTokens(ledger.contextWindow);
		const summary = `${formatTokens(ledger.usedTokens)} / ${window} tokens (${formatContextPercent(ledger.percent)})`;
		const provenance = contextWindowProvenanceLabel(ledger.contextWindowSource);
		const trailer = provenance ? `${provenance} window · ${source}` : source;
		lines.push(`${theme.fg("title", summary)} ${theme.fg("dim", "·")} ${theme.fg("muted", trailer)}`);
	} else {
		lines.push(
			theme.fg("warning", `context window unknown · ${formatTokens(ledger.usedTokens)} tokens estimated in context`),
		);
	}
	lines.push("");

	for (const group of ledger.meter) lines.push(legendRow(group, contentWidth));
	if (workingSet && workingSet.evicted.size > 0) lines.push(renderEvictedTokensLine(evictedTokens(workingSet), theme));

	lines.push("");
	if (workingSet) {
		for (const line of renderWorkingSetLines(workingSet, workingSetConfig)) lines.push(line);
		lines.push("");
	}
	if (ledger.projectPreload && ledger.groups.some((group) => group.category === "project")) {
		lines.push(theme.fg("dim", `project preload: ${ledger.projectPreload}`));
	}
	for (const handbookLine of handbookProvenanceLines(ledger.projectHandbookFiles)) {
		lines.push(theme.fg("dim", handbookLine));
	}
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
		const backendCacheReadsUnknown = cache.backend?.cachedTokens === null;
		const backend = backendCacheReadsUnknown
			? "server does not report cache reads"
			: cache.backendVerdict === "hot" || cache.backendVerdict === "partial"
				? "backend reused"
				: cache.backendVerdict === "cold"
					? "backend cold"
					: cache.backendVerdict === "small"
						? "backend small"
						: "backend n/a";
		const read = cache.cacheReadTokens !== null ? `cache read ${formatTokens(cache.cacheReadTokens)}` : "cache read n/a";
		const uncached =
			cache.uncachedInputTokens !== null ? `uncached input ${formatTokens(cache.uncachedInputTokens)}` : null;
		const line = backendCacheReadsUnknown
			? ["prompt cache:", shell, "·", backend].join(" ")
			: ["prompt cache:", shell, "·", backend, "·", read, ...(uncached ? ["·", uncached] : [])].join(" ");
		// Reasons Clio recorded before the run describe either prefix-byte changes
		// or local-server activity that displaced the cached prefix. A cold turn
		// after one of them is expected rather than a provider surprise.
		const coldReasons =
			cache.backendVerdict === "cold" && !backendCacheReadsUnknown ? (cache.expectedColdReasons ?? []) : [];
		// A reused shell with a cold backend means Clio kept the bytes stable
		// but the provider re-prefilled anyway; surface that disagreement
		// instead of hiding it. An expected reason explains the same numbers, so
		// it is reported on its own line and not as a warning.
		const misleading =
			cache.shellReused && cache.backendVerdict === "cold" && !backendCacheReadsUnknown && coldReasons.length === 0;
		lines.push(theme.fg(misleading ? "warning" : "dim", line));
		if (cache.backend) {
			const prefill =
				cache.backend.cachedTokens !== null && cache.uncachedPrefillTokens !== null
					? `prefill: ${formatTokens(cache.uncachedPrefillTokens)} uncached · ${formatTokens(cache.backend.cachedTokens)} cached · ${formatTokens(cache.backend.promptMs)} ms`
					: `prefill: ${formatTokens(cache.backend.promptTokens)} prompt · ${formatTokens(cache.backend.promptMs)} ms`;
			lines.push(theme.fg("dim", prefill));
		}
		if (coldReasons.length > 0) {
			const reasons = coldReasons.map(coldReasonLabel).join(", ");
			lines.push(theme.fg("dim", `last cold turn: ${reasons} (expected)`));
		}
	}

	if (ledger.prewarm) {
		// What the backend has already prefilled for the turn the operator has not
		// typed yet. It survives until the next settled run answers the question.
		const tokens = ledger.prewarm.tokens !== null ? `${formatTokens(ledger.prewarm.tokens)} tokens` : "prefix";
		const aborted = ledger.prewarm.aborted ? " (aborted on submit; prefix stays in the slot)" : "";
		lines.push(theme.fg("dim", `prewarmed: ${tokens} in ${formatTokens(ledger.prewarm.ms)} ms${aborted}`));
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
	/** Working-set fold at the live leaf; null or absent hides the section. */
	getWorkingSet?: () => WorkingSetView | null;
	/** The configured `context.workingSet` block, so the policy line states what is set. */
	getWorkingSetConfig?: () => WorkingSetConfigView | null;
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
	const render = (): string =>
		renderContextLedgerLines(
			getLedger(),
			DEFAULT_CONTENT_WIDTH,
			options?.getWorkingSet?.() ?? null,
			options?.getWorkingSetConfig?.() ?? null,
		).join("\n");
	const text = new Text(render(), 0, 0);
	const handle = showClioOverlayFrame(tui, text, {
		anchor: "center",
		width: CONTEXT_OVERLAY_WIDTH,
		markerId: "context-view",
		title: "Context Window",
		footerHint: buildHint([]),
	});

	const refresh = (): void => {
		text.setText(render());
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
