import type { ContextLedger, ContextLedgerCategory, ContextLedgerGroup } from "../domains/session/context-ledger.js";
import { type ClioTheme, type ClioToken, clioTheme, GLYPH } from "./theme/index.js";

/**
 * Shared visual language for the context window. Both the `/context-view`
 * overlay and the footer dashboard render the same ledger through these
 * helpers so the meter, colors, and glyphs stay identical everywhere the
 * harness portrays how full the window is.
 */

/** Color assigned to each category across every context rendering. */
export const CONTEXT_CATEGORY_TOKEN: Readonly<Record<ContextLedgerCategory, ClioToken>> = {
	system: "info",
	tools: "warning",
	agents: "reason",
	skills: "success",
	memory: "error",
	project: "muted",
	messages: "accent",
	pending: "accentDeep",
	reserve: "frame",
	free: "frame",
	streaming: "accent",
};

export function contextCategoryGlyph(category: ContextLedgerCategory): string {
	const filled = visibleSingle(GLYPH.contextFull) ? GLYPH.contextFull : GLYPH.barFull;
	const free = visibleSingle(GLYPH.contextFree) ? GLYPH.contextFree : GLYPH.barEmpty;
	// The autocompact reserve is held-back headroom, not consumed context; it
	// must stay glyph-distinct from both filled and free so a large reserve
	// never makes 85% and 97% bars look identical when color is unavailable.
	if (category === "reserve") return GLYPH.contextReserve;
	return category === "free" ? free : filled;
}

function visibleSingle(glyph: string): boolean {
	// The braille context glyphs are single-width; the fallback bar glyphs are
	// too. A defensive check keeps the meter aligned on terminals that render
	// the preferred glyphs as wide.
	return [...glyph].length === 1;
}

export interface AllocateMeterCellsOptions {
	/**
	 * When true, every non-empty content category claims at least one cell by
	 * borrowing from free space so small but real costs never vanish. Suited to
	 * the large overlay grid; leave false for the coarse footer bar.
	 */
	ensureVisible?: boolean;
}

/**
 * Allocate `totalCells` across the meter groups proportionally to the context
 * window via largest-remainder. With `ensureVisible`, guarantee one cell per
 * non-empty content category by borrowing from free space.
 */
function allocateMeterCells(
	meter: ReadonlyArray<ContextLedgerGroup>,
	contextWindow: number,
	totalCells: number,
	options: AllocateMeterCellsOptions = {},
): Array<{ category: ContextLedgerCategory; cells: number }> {
	const cells = Math.max(0, Math.floor(totalCells));
	if (cells === 0 || contextWindow <= 0 || meter.length === 0) return [];

	const raw = meter.map((group) => (group.tokens / contextWindow) * cells);
	const allocation = raw.map((value) => Math.floor(value));
	let remaining = cells - allocation.reduce((sum, value) => sum + value, 0);
	const order = raw
		.map((value, index) => ({ index, frac: value - Math.floor(value) }))
		.sort((a, b) => b.frac - a.frac || a.index - b.index);
	for (const { index } of order) {
		if (remaining <= 0) break;
		allocation[index] = (allocation[index] ?? 0) + 1;
		remaining -= 1;
	}

	if (options.ensureVisible) {
		const freeIndex = meter.findIndex((group) => group.category === "free");
		for (let i = 0; i < meter.length; i += 1) {
			const group = meter[i];
			if (!group || group.category === "free" || group.category === "reserve") continue;
			if (group.tokens > 0 && (allocation[i] ?? 0) === 0 && freeIndex >= 0 && (allocation[freeIndex] ?? 0) > 0) {
				allocation[i] = 1;
				allocation[freeIndex] = (allocation[freeIndex] ?? 0) - 1;
			}
		}
	}

	return meter.map((group, index) => ({ category: group.category, cells: allocation[index] ?? 0 }));
}

/** Color a contiguous run of identical cells, collapsing same-color spans. */
function paintCells(theme: ClioTheme, cells: ReadonlyArray<ContextLedgerCategory>): string {
	let out = "";
	let runToken: ClioToken | null = null;
	let runText = "";
	const flush = (): void => {
		if (runText.length > 0 && runToken) out += theme.fg(runToken, runText);
		runText = "";
	};
	for (const category of cells) {
		const token = CONTEXT_CATEGORY_TOKEN[category];
		if (token !== runToken) {
			flush();
			runToken = token;
		}
		runText += contextCategoryGlyph(category);
	}
	flush();
	return out;
}

function flattenAllocation(
	allocation: ReadonlyArray<{ category: ContextLedgerCategory; cells: number }>,
	totalCells: number,
): ContextLedgerCategory[] {
	const flat: ContextLedgerCategory[] = [];
	for (const { category, cells } of allocation) {
		for (let i = 0; i < cells; i += 1) flat.push(category);
	}
	while (flat.length < totalCells) flat.push("free");
	return flat.slice(0, totalCells);
}

/** A single-line proportional meter bar. Returns the empty-window placeholder when unknown. */
export function renderContextMeterBar(ledger: ContextLedger, cells: number, theme: ClioTheme = clioTheme()): string {
	const width = Math.max(0, Math.floor(cells));
	if (width === 0) return "";
	if (ledger.contextWindow <= 0) {
		return theme.fg("dim", contextCategoryGlyph("free").repeat(width));
	}
	const allocation = allocateMeterCells(ledger.meter, ledger.contextWindow, width);
	return paintCells(theme, flattenAllocation(allocation, width));
}

/** A multi-row meter grid for the overlay. Returns `rows` colored lines. */
export function renderContextMeterGrid(
	ledger: ContextLedger,
	cols: number,
	rows: number,
	theme: ClioTheme = clioTheme(),
): string[] {
	const columns = Math.max(1, Math.floor(cols));
	const rowCount = Math.max(1, Math.floor(rows));
	if (ledger.contextWindow <= 0) {
		return [theme.fg("dim", contextCategoryGlyph("free").repeat(columns))];
	}
	const totalCells = columns * rowCount;
	const allocation = allocateMeterCells(ledger.meter, ledger.contextWindow, totalCells, { ensureVisible: true });
	const flat = flattenAllocation(allocation, totalCells);
	const lines: string[] = [];
	for (let row = 0; row < rowCount; row += 1) {
		lines.push(paintCells(theme, flat.slice(row * columns, row * columns + columns)));
	}
	return lines;
}

/**
 * Evicted tokens live outside the window: the working-set projection removed
 * them from what the model sees, so they are not a meter category and must
 * not claim cells or a legend row. One line after the legend names them.
 */
export function renderEvictedTokensLine(evictedTokens: number, theme: ClioTheme = clioTheme()): string {
	const tokens = Math.round(Math.max(0, evictedTokens)).toLocaleString("en-US");
	return `${theme.fg("dim", GLYPH.contextReserve)} ${theme.fg("muted", "evicted (outside window)")} ${theme.fg("dim", `${tokens} tokens`)}`;
}

/** A small colored swatch for a category, for inline legends. */
export function contextCategorySwatch(category: ContextLedgerCategory, theme: ClioTheme = clioTheme()): string {
	return theme.fg(CONTEXT_CATEGORY_TOKEN[category], contextCategoryGlyph(category));
}

// ---------------------------------------------------------------------------
// Per-worker context meter (fleet visibility)
//
// Workers report usage on their message_end events; the last assistant
// message's input + cacheRead + output approximates the worker's current
// context occupancy. Fleet surfaces (dispatch board cards, /fleet rows)
// render it as a percentage of the model's context window with the shared
// thresholds below, so "how full is that worker" reads identically to how
// the footer portrays the main agent's window.
// ---------------------------------------------------------------------------

export type WorkerContextSeverity = "healthy" | "warn" | "critical";

export const WORKER_CONTEXT_WARN_PCT = 80;
export const WORKER_CONTEXT_CRITICAL_PCT = 95;

export function workerContextSeverity(pct: number): WorkerContextSeverity {
	if (pct >= WORKER_CONTEXT_CRITICAL_PCT) return "critical";
	if (pct >= WORKER_CONTEXT_WARN_PCT) return "warn";
	return "healthy";
}

function workerContextToken(severity: WorkerContextSeverity): ClioToken {
	if (severity === "critical") return "error";
	if (severity === "warn") return "warning";
	return "muted";
}

export interface WorkerContextView {
	pct: number;
	severity: WorkerContextSeverity;
	usedTokens: number;
	contextWindow: number;
}

/**
 * Derive the worker context view, or null when the window is unknown or no
 * usage has been observed yet. The percentage is capped at 100: a provider
 * report past the window is a full window, not a >100% claim.
 */
export function workerContextView(
	usedTokens: number,
	contextWindow: number | undefined | null,
): WorkerContextView | null {
	if (contextWindow === undefined || contextWindow === null || contextWindow <= 0) return null;
	if (!Number.isFinite(usedTokens) || usedTokens <= 0) return null;
	const pct = Math.min(100, Math.round((usedTokens / contextWindow) * 100));
	return { pct, severity: workerContextSeverity(pct), usedTokens, contextWindow };
}

/** Compact colored `ctx NN%` unit for board cards and /fleet rows; null when unknown. */
export function formatWorkerContextMeter(
	usedTokens: number,
	contextWindow: number | undefined | null,
	theme: ClioTheme = clioTheme(),
): string | null {
	const view = workerContextView(usedTokens, contextWindow);
	if (view === null) return null;
	return theme.fg(workerContextToken(view.severity), `ctx ${view.pct}%`);
}
