/**
 * Copy marks for fullscreen selection (#453).
 *
 * The chat panel draws prose rows hard-wrapped under a 2-cell gutter that holds
 * the turn glyph. pi-tui's fullscreen selection copies painted rows, so a
 * dragged paragraph used to reach the clipboard as one line per screen row with
 * the glyph and the gutter kept. The panel prefixes each hung row with one of
 * these APC marks (zero width, like pi-tui's `CURSOR_MARKER`), and
 * `InstrumentedTuiAltScreen` rebuilds the copied text from them. Marks are
 * stripped from every row before it reaches the terminal, because terminals and
 * tmux treat an APC string as a title or ignore it inconsistently.
 */

import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const MARK_PREFIX = "\x1b_clio:";
/** A row hung under the gutter that starts a new line of copied text. */
export const COPY_ROW_MARK = `${MARK_PREFIX}r\x07`;
/** A wrapped continuation: joins the row before it with one space. */
export const COPY_JOIN_MARK = `${MARK_PREFIX}s\x07`;
/** A word broken across rows (a long URL): joins the row before it with no space. */
export const COPY_TIGHT_MARK = `${MARK_PREFIX}w\x07`;

const GUTTER_WIDTH = 2;

type MarkKind = "row" | "join" | "tight";

export interface SelectedRow {
	line: string;
	start: number;
	end: number;
}

export function hasCopyMark(line: string): boolean {
	return line.includes(MARK_PREFIX);
}

export function stripCopyMarks(line: string): string {
	if (!line.includes(MARK_PREFIX)) return line;
	return line.replaceAll(COPY_ROW_MARK, "").replaceAll(COPY_JOIN_MARK, "").replaceAll(COPY_TIGHT_MARK, "");
}

function findMark(line: string): { kind: MarkKind; col: number; line: string } | undefined {
	const at = line.indexOf(MARK_PREFIX);
	if (at < 0) return undefined;
	const code = line[at + MARK_PREFIX.length];
	const kind: MarkKind = code === "s" ? "join" : code === "w" ? "tight" : "row";
	return { kind, col: visibleWidth(line.slice(0, at)), line: stripCopyMarks(line) };
}

function cells(line: string, start: number, end: number): string {
	return end > start ? stripTerminalSequences(sliceByColumn(line, start, end - start, true)) : "";
}

/**
 * The clipboard text of a selection. Unmarked rows copy exactly as stock pi-tui
 * copies them (each row's selected cells, end-trimmed, one row per line). A
 * marked row drops its gutter cells, and a continuation row joins the text
 * before it instead of starting a line, so a wrapped paragraph or list item
 * copies as the one line it was written as.
 */
export function selectedRowsText(rows: readonly SelectedRow[]): string {
	let text = "";
	rows.forEach((row, index) => {
		const mark = findMark(row.line);
		if (!mark) {
			text += `${index > 0 ? "\n" : ""}${cells(row.line, row.start, row.end).trimEnd()}`;
			return;
		}
		const gutterEnd = mark.col + GUTTER_WIDTH;
		const kept =
			cells(mark.line, row.start, Math.min(row.end, mark.col)) + cells(mark.line, Math.max(row.start, gutterEnd), row.end);
		if (mark.kind === "row") {
			text += `${index > 0 ? "\n" : ""}${kept.trimEnd()}`;
			return;
		}
		// A continuation's leading cells are wrap indent (a list item's bullet width), never text.
		if (index === 0) {
			text = kept.trim();
			return;
		}
		const words = kept.trim();
		if (words.length === 0) return;
		const space = mark.kind === "join" && text.length > 0 && !/\s$/.test(text) ? " " : "";
		text += space + words;
	});
	return text;
}
