/**
 * The rails budget (D-TUI 4.8): whatever opens above the composer, the transcript keeps at least a third of the
 * terminal, and a short terminal at least six rows. Under RAILS_FOLD_ROWS the fleet dock and the context rail give up
 * their rows: the composer's top rail already names running workers and compaction, and names other context
 * operations while folded, so the rows only repeated it.
 */
import { truncateToWidth } from "../engine/tui.js";
import { clioTheme, GLYPH } from "./theme/index.js";

/** Under this many terminal rows the fleet dock and the context rail fold into the composer's top rail. */
const RAILS_FOLD_ROWS = 30;

export function railsFolded(terminalRows: number): boolean {
	return terminalRows < RAILS_FOLD_ROWS;
}

/** Rows the transcript keeps whatever the rails hold: a third of the terminal, and on a short one at most six. */
function transcriptFloor(terminalRows: number): number {
	const rows = Math.max(0, Math.floor(terminalRows));
	return railsFolded(rows) ? Math.min(6, Math.ceil(rows / 4)) : Math.ceil(rows / 3);
}

export interface RailRows {
	lines: readonly string[];
	/** Lower keeps its rows first when the budget is short. */
	priority: number;
	/** Gives up every row while the terminal is folded. */
	foldable?: boolean;
}

/**
 * Each rail's rows within `room`, in the order given. Rails are served by priority; one that does not fit whole keeps
 * its head and ends on a row saying how many it holds back, so a cut never reads as the whole list.
 */
export function fitRails(rails: ReadonlyArray<RailRows>, room: number, folded: boolean, width: number): string[][] {
	const granted: string[][] = rails.map(() => []);
	let left = Math.max(0, Math.floor(room));
	const order = rails.map((rail, index) => ({ rail, index })).sort((a, b) => a.rail.priority - b.rail.priority);
	for (const { rail, index } of order) {
		if (folded && rail.foldable === true) continue;
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
