/**
 * The rails budget (D-TUI 4.8): whatever opens above the composer, the transcript keeps at least a third of the
 * terminal, and a short terminal at least six rows. Under RAILS_FOLD_ROWS a foldable rail (the context rail) gives up
 * its rows: the composer's top rail names compaction, and names other context operations while folded. The fleet
 * dock sizes itself by the terminal's rows instead and offers whole variants, so a cut never splits a run from its
 * telemetry row.
 */
import type { Component } from "../engine/tui.js";
import { truncateToWidth } from "../engine/tui.js";
import { clioTheme, GLYPH } from "./theme/index.js";

/** Under this many terminal rows the foldable rails fold into the composer's top rail. */
const RAILS_FOLD_ROWS = 30;

export function railsFolded(terminalRows: number): boolean {
	return terminalRows < RAILS_FOLD_ROWS;
}

/** Rows the transcript keeps whatever the rails hold: a third of the terminal, and on a short one at most six. */
function transcriptFloor(terminalRows: number): number {
	const rows = Math.max(0, Math.floor(terminalRows));
	return railsFolded(rows) ? Math.min(6, Math.ceil(rows / 4)) : Math.ceil(rows / 3);
}

/** A rail that offers whole variants of itself, largest first; the budget grants the first that fits. */
export interface VariantRail extends Component {
	renderVariants(width: number): string[][];
}

export interface RailRows {
	lines: readonly string[];
	/** Whole variants, largest first. A rail that offers them is granted one whole or none, never a cut. */
	variants?: ReadonlyArray<readonly string[]>;
	/** Lower keeps its rows first when the budget is short. */
	priority: number;
	/** Gives up every row while the terminal is folded. */
	foldable?: boolean;
}

/**
 * Each rail's rows within `room`, in the order given. Rails are served by priority. A rail with variants gets the
 * first one that fits whole. A rail of plain lines that does not fit whole keeps its head and ends on a row saying how
 * many it holds back, so a cut never reads as the whole list.
 */
export function fitRails(rails: ReadonlyArray<RailRows>, room: number, folded: boolean, width: number): string[][] {
	const granted: string[][] = rails.map(() => []);
	let left = Math.max(0, Math.floor(room));
	const order = rails.map((rail, index) => ({ rail, index })).sort((a, b) => a.rail.priority - b.rail.priority);
	for (const { rail, index } of order) {
		if (folded && rail.foldable === true) continue;
		if (rail.variants !== undefined) {
			const fits = rail.variants.find((variant) => variant.length <= left);
			if (fits !== undefined) {
				granted[index] = [...fits];
				left -= fits.length;
			}
			continue;
		}
		const lines = rail.lines;
		if (lines.length <= left) {
			granted[index] = [...lines];
			left -= lines.length;
			continue;
		}
		if (left === 0) continue;
		const kept = lines.slice(0, left - 1);
		const held = lines.length - kept.length;
		const marker = clioTheme().fg("annotation", `  ${GLYPH.ellipsis} ${held} more ${held === 1 ? "row" : "rows"}`);
		granted[index] = [...kept, truncateToWidth(marker, Math.max(1, width), GLYPH.ellipsis, false)];
		left = 0;
	}
	return granted;
}

/** Rows the rails may take beside a composer and footer of these heights. */
export function railsRoom(terminalRows: number, editorRows: number, footerRows: number): number {
	return Math.max(0, Math.floor(terminalRows) - transcriptFloor(terminalRows) - editorRows - footerRows);
}
