import { homedir } from "node:os";
import { relative } from "node:path";
import { uncachedPrefillTokens } from "../core/cache-telemetry.js";
import { relativePathEscapes } from "../core/path-containment.js";
import { onPresentationTierChange, tierPolicy } from "../core/presentation-tier.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import { renderUpperBound } from "../core/telemetry/render.js";
import type { BudgetInspection } from "../domains/context/budget/inspection.js";
import type { WorkingSetView } from "../domains/context/working-set/contract.js";
import { formatContextWindowSlots } from "../domains/providers/index.js";
import type { ContextLedger, ContextLedgerCategory, ContextLedgerGroup } from "../domains/session/context-ledger.js";
import type { RecallTelemetry } from "../domains/session/recall-telemetry.js";
import type { TelemetryReadModel, TelemetryView } from "../domains/telemetry/contract.js";
import { type OverlayHandle, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { coldReasonList } from "../session-control/cold-reasons.js";
import {
	contextCategorySwatch,
	contextPercentRole,
	renderContextMeterGrid,
	renderEvictedTokensLine,
} from "./context-meter.js";
import { buildResponsiveHint, ScrollingBody, showClioOverlayFrame } from "./overlay-frame.js";
import {
	abbreviateModelId,
	type ClioToken,
	chipRows,
	clioTheme,
	dotSep,
	fitSides,
	formatContextPercent,
	formatCount,
	GLYPH,
	padAnsi,
	type SideUnit,
	sectionRule,
} from "./theme/index.js";

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
			return "catalog estimate";
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
	if (rel.length > 0 && !relativePathEscapes(rel)) return rel;
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
	return [
		`handbooks (ancestor ${GLYPH.next} nearest):`,
		...handbookFiles.map((filePath) => `  ${displayHandbookPath(filePath)}`),
	];
}

/**
 * The meter is two rows across the whole body: at 68 columns that is 136
 * cells, more resolution than the old eight rows of forty gave at a third of
 * the height, which matters in a dock that holds sixteen rows and cannot
 * scroll this surface.
 */
const GRID_ROWS = 2;
/** At this width the legend lays its categories out in two columns. */
const LEGEND_SPLIT_COLUMNS = 84;
/** A legend column wider than this puts the numbers too far from their labels. */
const LEGEND_COLUMN_MAX = 56;

/** How a count prints: lower-case SI on the shared rows of compact and standard, full digits at detailed (2.9). */
type CountFormat = (n: number) => string;

function legendRow(group: ContextLedgerGroup, contentWidth: number, count: CountFormat): string {
	const theme = clioTheme();
	const swatch = contextCategorySwatch(group.category, theme);
	const tokens = count(group.tokens);
	const percent = formatContextPercent(group.percent);
	const right = `${tokens.padStart(9)}  ${percent.padStart(6)}`;
	const labelToken: ClioToken = "legend";
	const leftWidth = Math.max(0, contentWidth - visibleWidth(right) - visibleWidth(swatch) - 2);
	const labelText = truncateToWidth(group.label, leftWidth, "", true);
	// The figures are values: a reading role, so `NO_COLOR` dims the label and not the number.
	return `${swatch} ${theme.fg(labelToken, labelText)} ${theme.fg("counter", right)}`;
}

/** The legend as one column, or two side by side when the body is wide enough for both to read. */
function legendRows(groups: ReadonlyArray<ContextLedgerGroup>, contentWidth: number, count: CountFormat): string[] {
	if (contentWidth < LEGEND_SPLIT_COLUMNS)
		return groups.map((group) => legendRow(group, Math.min(contentWidth, LEGEND_COLUMN_MAX), count));
	const column = Math.min(LEGEND_COLUMN_MAX, Math.floor((contentWidth - 4) / 2));
	const half = Math.ceil(groups.length / 2);
	const left = groups.slice(0, half).map((group) => legendRow(group, column, count));
	const right = groups.slice(half).map((group) => legendRow(group, column, count));
	return left.map((line, index) => `${padAnsi(line, column)}    ${right[index] ?? ""}`.trimEnd());
}

/** The one-word category names of the compact row, where the legend's labels do not fit beside each other. */
const CATEGORY_SHORT_LABEL: Readonly<Record<ContextLedgerCategory, string>> = {
	system: "system",
	tools: "tools",
	toolResults: "results",
	agents: "fleet",
	skills: "skills",
	memory: "memory",
	project: "project",
	messages: "messages",
	pending: "pending",
	reserve: "reserve",
	free: "free",
	streaming: "output",
};

/**
 * Compact's one category row: what holds the window, largest first, as many as fit, and `+N` for the rest. Free space
 * and the autocompact reserve are what the total and its threshold already say, so they are not categories here.
 */
function categoryRow(groups: ReadonlyArray<ContextLedgerGroup>, width: number): string | null {
	const theme = clioTheme();
	const content = groups
		.filter((group) => group.category !== "free" && group.category !== "reserve" && group.tokens > 0)
		.sort((a, b) => b.tokens - a.tokens);
	if (content.length === 0) return null;
	const units = content.map(
		(group) =>
			`${theme.fg("legend", CATEGORY_SHORT_LABEL[group.category])} ${theme.fg("counter", formatCount(group.tokens))}`,
	);
	const separator = dotSep(theme);
	for (let kept = units.length; kept >= 1; kept--) {
		const rest = units.length - kept;
		const row = [...units.slice(0, kept), ...(rest > 0 ? [theme.fg("annotation", `+${rest}`)] : [])].join(separator);
		if (visibleWidth(row) <= width) return row;
	}
	return theme.fg("annotation", `${content.length} categories`);
}

/** The autocompact unit of the total line at compact: the threshold is the value, the words around it the label. */
function autocompactUnit(ledger: ContextLedger): SideUnit {
	const theme = clioTheme();
	const manual = ledger.compactionAuto ? "" : " (manual)";
	if (ledger.contextWindow <= 0 && ledger.compactionCeilingTokens)
		return { text: `autocompact at ceiling${manual}`, paint: (text) => theme.fg("annotation", text) };
	if (ledger.compactionThreshold === null)
		return { text: "autocompact off", paint: (text) => theme.fg("annotation", text) };
	const threshold = `${Math.round(ledger.compactionThreshold * 100)}%`;
	return {
		text: `autocompact at ${threshold}${manual}`,
		paint: () =>
			`${theme.fg("annotation", "autocompact at")} ${theme.fg("counter", threshold)}${manual ? theme.fg("annotation", manual) : ""}`,
	};
}

/**
 * The total: what the window holds against its size and the fill percent, then, by tier, the autocompact threshold
 * (compact) or the window's provenance and the route (detailed). Units are kept whole or dropped whole, last first, so
 * the line never ends in a cut unit or `· …`.
 */
function totalLine(ledger: ContextLedger, width: number, count: CountFormat): string {
	const theme = clioTheme();
	const sections = tierPolicy().usageSections;
	const estimate = ledger.measured ? "" : GLYPH.estimate;
	const units: SideUnit[] = [];
	if (ledger.contextWindow > 0) {
		// `196,608 (786,432 / 4 slots)`: a llama.cpp window that is one slot's share of the server's KV budget names the
		// split, because the bare number reads as the whole server and the meter is measured against the share (#187).
		const slots = ledger.contextWindowSlots;
		const window =
			slots === undefined || slots === null
				? count(ledger.contextWindow)
				: count === formatTokens
					? formatContextWindowSlots(ledger.contextWindow, slots)
					: `${count(ledger.contextWindow)} (${count(slots.totalContextSize)} / ${slots.slots} slots)`;
		units.push({
			text: `${estimate}${count(ledger.usedTokens)} / ${window} tokens`,
			paint: (text) => theme.fg("counter", text),
		});
		units.push({
			text: formatContextPercent(ledger.percent),
			paint: (text) => theme.fg(contextPercentRole(ledger.percent), text),
		});
	} else {
		units.push({ text: "context window unknown", paint: (text) => theme.fg("unknownValue", text) });
		units.push({
			text: `${GLYPH.estimate}${count(ledger.usedTokens)} tokens in context`,
			paint: (text) => theme.fg("counter", text),
		});
	}
	if (sections === "totals") units.push({ ...autocompactUnit(ledger), drop: 2 });
	if (sections === "provenance") {
		if (ledger.contextWindow > 0) {
			const source = ledger.measured
				? `provider-anchored total ${GLYPH.dot} estimated splits`
				: "estimated total and splits";
			const provenance = contextWindowProvenanceLabel(ledger.contextWindowSource);
			units.push({
				text: provenance ? `${provenance} window ${GLYPH.dot} ${source}` : source,
				paint: (text) => theme.fg("menuDescription", text),
				drop: 1,
				...(provenance ? { shorter: [{ text: `${provenance} window`, rank: 0 }] } : {}),
			});
		}
		const provider = ledger.provider ?? "no target";
		const model = ledger.model ? abbreviateModelId(ledger.model) : "no model";
		units.push({
			text: `${provider} ${GLYPH.dot} ${model}`,
			paint: () =>
				`${theme.fg("modelIdentity", provider)} ${theme.fg("annotation", GLYPH.dot)} ${theme.fg("modelIdentity", model)}`,
			drop: 2,
		});
	}
	return fitSides(theme, units, [], width).trimEnd();
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

/** The operator's working-set configuration, as `/context` states it. */
export interface WorkingSetConfigView {
	enabled: boolean;
	policy: string;
	profile?: string;
	rearmFraction?: number;
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
	const profile = config.profile && config.profile !== "default" ? ` · profile ${config.profile}` : "";
	const band = config.rearmFraction === undefined ? "" : ` · rearm ${Number((config.rearmFraction * 100).toFixed(2))}%`;
	return `policy ${config.policy}${lastRan}${profile}${band}${state}`;
}

function renderWorkingSetLines(
	view: WorkingSetView,
	config: WorkingSetConfigView | null | undefined,
	recall: RecallTelemetry | null | undefined,
): string[] {
	const theme = clioTheme();
	const items = view.evicted.size;
	// #422: `recalls` counts every trigger; the readmitted figure is what the
	// billed ones (tool and reread) put back in front of the model.
	const readmitted =
		recall && recall.readmittedTokens > 0 ? [`${formatTokens(recall.readmittedTokens)} tokens readmitted`] : [];
	const summary = [
		`${items} evicted item${items === 1 ? "" : "s"}`,
		`${formatTokens(evictedTokens(view))} tokens`,
		`${view.evictionEvents} event${view.evictionEvents === 1 ? "" : "s"}`,
		`${view.recalls} recall${view.recalls === 1 ? "" : "s"}`,
		...readmitted,
		`churn ${formatChurn(view)}`,
	].join(" · ");
	return [
		`${theme.fg("fieldName", "working set")} ${theme.fg("annotation", GLYPH.dot)} ${theme.fg("fieldValue", workingSetPolicyLabel(view, config))}`,
		// Counts, so a value role: `NO_COLOR` must not dim them.
		theme.fg("fieldValue", summary),
	];
}

/**
 * The live budget's next-request facts, when the chat loop can inspect them. A pending handoff is a next action, so it
 * shows at every tier; the budget figures are evidence and start at standard.
 */
function nextRequestLines(inspection: BudgetInspection | undefined, width: number): string[] {
	if (inspection?.status !== "available") return [];
	const theme = clioTheme();
	const view = inspection.view;
	const sections = tierPolicy().usageSections;
	if (sections === "totals") {
		if (!view.pendingHandoff) return [];
		return [
			`${theme.fg("fieldName", "handoff")} ${theme.fg("warning", view.lastOutcome?.outcome ?? "pending")} ${theme.fg("annotation", view.pendingHandoff.id)}`,
			theme.fg("annotation", `/context recover ${view.pendingHandoff.id} reduce|deliver`),
		];
	}
	const figure = sections === "provenance" ? formatTokens : formatCount;
	const count = (value: number | null) => (value === null ? "unknown" : figure(value));
	const lines = [
		sectionRule(theme, width, "Next request", { meta: view.phase }),
		// Whole facts, wrapped between them when the body is narrow: every figure stays and no row ends in `· …` (2.9).
		...chipRows(
			theme,
			[
				`${theme.fg("fieldName", "input")} ${theme.fg("fieldValue", count(view.inputTokens))}`,
				`${theme.fg("fieldName", "output reserve")} ${theme.fg("fieldValue", count(view.outputReserveTokens))}`,
				`${theme.fg("fieldName", "headroom")} ${theme.fg("fieldValue", count(view.headroomTokens))}`,
			],
			width,
		),
	];
	if (view.pendingHandoff) {
		lines.push(
			`${theme.fg("fieldName", "handoff")} ${theme.fg("warning", view.lastOutcome?.outcome ?? "pending")} ${theme.fg("annotation", view.pendingHandoff.id)}`,
			theme.fg("annotation", `/context recover ${view.pendingHandoff.id} reduce|deliver`),
		);
	} else if (view.lastOutcome) {
		lines.push(`${theme.fg("fieldName", "last handoff")} ${theme.fg("fieldValue", view.lastOutcome.outcome)}`);
	}
	return lines;
}

function renderContextLedgerLines(
	ledger: ContextLedger,
	contentWidth: number,
	workingSet?: WorkingSetView | null,
	workingSetConfig?: WorkingSetConfigView | null,
	recall?: RecallTelemetry | null,
	telemetry?: TelemetryView | null,
	hasTelemetry = telemetry !== undefined,
): string[] {
	const theme = clioTheme();
	const lines: string[] = [];
	// The tier bounds the evidence (3.2): compact is the bar, the total with its threshold and one category row;
	// standard adds the category table and the autocompact line; detailed adds working set, cache, preload, prior session.
	const sections = tierPolicy().usageSections;
	const count: CountFormat = sections === "provenance" ? formatTokens : formatCount;

	// The answer first: the meter across the body, then the figure it draws.
	const gridRows = sections === "totals" ? 1 : GRID_ROWS;
	for (const gridLine of renderContextMeterGrid(ledger, contentWidth, gridRows, theme)) lines.push(gridLine);
	lines.push(totalLine(ledger, contentWidth, count));
	if (sections === "totals") {
		const row = categoryRow(ledger.meter, contentWidth);
		if (row !== null) lines.push(row);
		return lines;
	}

	lines.push(...legendRows(ledger.meter, contentWidth, count));
	// Each fact is a label and a value: the words take the supporting role and the figure the counter, so `NO_COLOR`
	// dims `autocompact at` and not `80%`, as the compact total line paints it.
	const label = (text: string): string => theme.fg("annotation", text);
	const value = (text: string): string => theme.fg("counter", text);
	const mode = ledger.compactionAuto ? "auto" : "manual";
	const compaction =
		ledger.contextWindow <= 0 && ledger.compactionCeilingTokens
			? label(`autocompact at ceiling (${mode}; serving window unknown)`)
			: ledger.compactionThreshold !== null
				? `${label("autocompact at")} ${value(`${Math.round(ledger.compactionThreshold * 100)}%`)} ${label(`(${mode})`)}`
				: label("autocompact off");
	const toolsLabel =
		ledger.toolCount > 0
			? `${value(String(ledger.toolCount))} ${label(`active tool${ledger.toolCount === 1 ? "" : "s"}`)}`
			: null;
	// The cleanup ceiling (context.compaction.maxTokens or a price tier) only fires cleanup sooner than the window does;
	// at or above a known window it bounds nothing, and `ceiling 400,000 tokens` beside a 200K window read as a limit.
	const ceilingTokens = ledger.compactionCeilingTokens ?? 0;
	const ceiling =
		ceilingTokens > 0 && (ledger.contextWindow <= 0 || ceilingTokens < ledger.contextWindow)
			? `${label("cleanup ceiling")} ${value(count(ceilingTokens))} ${label("tokens")}`
			: null;
	// Wrapped between its facts, never inside one, so a narrow body never leaves a row ending in a bare `·`.
	for (const row of chipRows(theme, [compaction, ceiling, toolsLabel], contentWidth)) lines.push(row);
	if (sections !== "provenance") return lines;

	if (workingSet && workingSet.evicted.size > 0) lines.push(renderEvictedTokensLine(evictedTokens(workingSet), theme));
	if (workingSet) {
		for (const line of renderWorkingSetLines(workingSet, workingSetConfig, recall)) lines.push(line);
	}

	// Cache facts are the newest main call's journal record (#434 §11.3), so an unreported cache read reads unknown,
	// never 0. The session shell hash and the serving backend's timings are Clio's own and stay on the ledger. A server
	// that omits cache reads from its usage but reports cache_n in its timings shows that read, labelled the server's.
	const cache = ledger.promptCache;
	const call = telemetry?.calls({ roles: ["main"], limit: 1 }).calls[0] ?? null;
	if (cache || call) {
		const shell = cache ? (cache.shellReused ? "shell reused" : "shell recompiled") : "shell n/a";
		if (!hasTelemetry)
			lines.push(theme.fg("annotation", `prompt cache: ${shell} ${GLYPH.dot} cache facts not available`));
		else if (!call?.usage) lines.push(theme.fg("annotation", `prompt cache: ${shell} ${GLYPH.dot} no settled call yet`));
		else {
			const verdict = call.cache.verdict;
			const readFact = call.usage.cacheRead.fact;
			const serverRead =
				"kind" in readFact && readFact.kind === "unknown" ? (cache?.backend?.cachedTokens ?? null) : undefined;
			const backendCacheReadsUnknown = verdict === "unknown" || serverRead === null;
			const backend = backendCacheReadsUnknown
				? "server does not report cache reads"
				: verdict === "hot"
					? "backend reused"
					: verdict === "partial"
						? "backend partly reused"
						: verdict === "cold"
							? "backend cold"
							: "backend small";
			// A partial or cold call charged again some of the prefix the previous request had; the journal counts it.
			const rePrefilled =
				verdict === "partial" || verdict === "cold"
					? [GLYPH.dot, `re-prefilled ${renderUpperBound(call.cache.rePrefilled.fact, call.cache.rePrefilled.display)}`]
					: [];
			const line = backendCacheReadsUnknown
				? ["prompt cache:", shell, GLYPH.dot, backend].join(" ")
				: [
						"prompt cache:",
						shell,
						GLYPH.dot,
						backend,
						...rePrefilled,
						GLYPH.dot,
						serverRead === undefined
							? `cache read ${call.usage.cacheRead.display}`
							: `server cache read ${formatTokens(serverRead)}`,
						GLYPH.dot,
						`uncached prefill ${call.cache.uncachedPrefill.display}`,
					].join(" ");
			// Reasons Clio recorded before the call describe either prefix-byte changes
			// or local-server activity that displaced the cached prefix. A cold turn
			// after one of them is expected rather than a provider surprise.
			const coldReasons = verdict === "cold" && !backendCacheReadsUnknown ? call.cache.expectedColdReasons : [];
			// A reused shell with a cold backend means Clio kept the bytes stable
			// but the provider re-prefilled anyway; surface that disagreement
			// instead of hiding it. An expected reason explains the same numbers, so
			// it is reported on its own line and not as a warning.
			const misleading =
				cache?.shellReused === true && verdict === "cold" && !backendCacheReadsUnknown && coldReasons.length === 0;
			lines.push(theme.fg(misleading ? "warning" : "annotation", line));
			if (cache?.backend) {
				// The serving backend's own timing for the run's last call, worded as its counts, not the journal's.
				const evaluated = uncachedPrefillTokens(cache.backend);
				const prefill =
					evaluated !== null
						? `server prefill: ${formatTokens(evaluated)} evaluated ${GLYPH.dot} ${formatTokens(cache.backend.promptTokens - evaluated)} cached ${GLYPH.dot} ${formatTokens(cache.backend.promptMs)} ms`
						: `server prefill: ${formatTokens(cache.backend.promptTokens)} prompt ${GLYPH.dot} ${formatTokens(cache.backend.promptMs)} ms`;
				lines.push(theme.fg("annotation", prefill));
			}
			if (coldReasons.length > 0) {
				lines.push(
					theme.fg("annotation", `prompt read again after ${coldReasonList(coldReasons)} (reuse measured separately)`),
				);
			}
		}
	}

	if (ledger.prewarm) {
		// What the backend has already prefilled for the turn the operator has not
		// typed yet. It survives until the next settled run answers the question.
		const tokens = ledger.prewarm.tokens !== null ? `${formatTokens(ledger.prewarm.tokens)} tokens` : "prefix";
		const aborted = ledger.prewarm.aborted ? " (aborted on submit; prefix stays in the slot)" : "";
		lines.push(theme.fg("annotation", `prewarmed: ${tokens} in ${formatTokens(ledger.prewarm.ms)} ms${aborted}`));
	}

	if (ledger.lastCompaction) {
		const pruneInfo = `last compaction: reclaimed ${formatTokens(ledger.lastCompaction.tokensBefore)} -> ${formatTokens(ledger.lastCompaction.tokensAfter)} tokens (${ledger.lastCompaction.stage})`;
		lines.push(theme.fg("annotation", pruneInfo));
	}

	if (ledger.projectPreload && ledger.groups.some((group) => group.category === "project")) {
		lines.push(theme.fg("annotation", `project preload: ${ledger.projectPreload}`));
	}
	for (const handbookLine of handbookProvenanceLines(ledger.projectHandbookFiles)) {
		lines.push(theme.fg("annotation", handbookLine));
	}
	if (ledger.priorSessionFact) {
		for (const row of wrapTextWithAnsi(`prior session: ${ledger.priorSessionFact}`, Math.max(20, contentWidth))) {
			lines.push(theme.fg("annotation", row));
		}
	}

	return lines;
}

/** How often the streaming fallback tick repaints the overlay. */
const STREAMING_FALLBACK_TICK_MS = 1000;

export interface OpenContextOverlayOptions {
	bus?: TelemetryHub;
	/**
	 * Chat event source. When wired, the overlay refreshes as turns settle
	 * (message_end/agent_end) and runs a slow fallback tick only while a
	 * response is streaming, so the in-flight output counter stays live.
	 */
	chat?: {
		onEvent(handler: (event: { type: string }) => void): () => void;
		isStreaming(): boolean;
		inspectLiveBudget?(): BudgetInspection;
	};
	/** Working-set fold at the live leaf; null or absent hides the section. */
	getWorkingSet?: () => WorkingSetView | null;
	/** The configured `context.workingSet` block, so the policy line states what is set. */
	getWorkingSetConfig?: () => WorkingSetConfigView | null;
	/** Recall fold over the same active path as `getWorkingSet`; absent hides the readmitted figure (#422). */
	getRecallTelemetry?: () => RecallTelemetry | null;
	/** The telemetry read model; absent renders the cache facts as not available. */
	telemetry?: Pick<TelemetryReadModel, "live" | "subscribe">;
}

/**
 * Mount the read-only `/context-view` overlay. Event-driven: bus compaction
 * events and chat turn boundaries trigger repaints; a slow (1s) tick covers
 * the streaming window where token counts move between events. Esc closes and
 * the arrows and page keys scroll, because a narrow terminal wraps the page
 * past the rows it has; the router keeps every other key from the composer.
 */
export function openContextOverlay(
	tui: TUI,
	getLedger: () => ContextLedger,
	options?: OpenContextOverlayOptions,
): OverlayHandle {
	// The rows are a function of the ledger, the telemetry view and the width;
	// the cache keeps the open overlay free until one of them changes.
	const body = new ScrollingBody(
		(width) => [
			...renderContextLedgerLines(
				getLedger(),
				width,
				options?.getWorkingSet?.() ?? null,
				options?.getWorkingSetConfig?.() ?? null,
				options?.getRecallTelemetry?.() ?? null,
				options?.telemetry ? options.telemetry.live() : undefined,
			),
			...nextRequestLines(options?.chat?.inspectLiveBudget?.(), width),
		],
		() => tui.requestRender(),
	);
	const handle = showClioOverlayFrame(tui, body, {
		anchor: "center",
		width: CONTEXT_OVERLAY_WIDTH,
		markerId: "context-view",
		title: "Context Window",
		// The scroll keys are named only while they move something.
		footerHint: (innerWidth) =>
			buildResponsiveHint(
				body.overflows()
					? [
							{ key: `${GLYPH.up}${GLYPH.down}`, verb: "scroll", critical: true },
							{ key: "PgUp/PgDn", verb: "page" },
						]
					: [],
			)(innerWidth),
	});

	const refresh = (): void => {
		body.touch();
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
	// The rows are cut by the tier, so a tier change rebuilds them and the open overlay redraws on the next frame.
	unsubscribes.push(onPresentationTierChange(refresh));
	if (options?.bus) {
		unsubscribes.push(options.bus.subscribe("context.pruned", refresh));
	}
	// A settled call's journal batch lands just after its chat event; repaint when it does, at most 10 Hz.
	if (options?.telemetry) {
		unsubscribes.push(options.telemetry.subscribe("calls", refresh));
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
