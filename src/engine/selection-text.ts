/**
 * Copy marks for fullscreen selection (#453).
 *
 * The chat panel draws prose rows hard-wrapped under a 2-cell gutter that holds
 * the turn glyph. pi-tui's fullscreen selection copies painted rows, so a
 * dragged paragraph used to reach the clipboard as one line per screen row with
 * the glyph and the gutter kept, and fenced code with its indent and `↪` wrap
 * marks. The panel prefixes each prose, code, prompt and action row with one of
 * these APC marks (zero width, like pi-tui's `CURSOR_MARKER`), and
 * `InstrumentedTuiAltScreen` rebuilds the copied text from them. Marks are
 * stripped from every row before it reaches the terminal, because terminals and
 * tmux treat an APC string as a title or ignore it inconsistently.
 */

import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const MARK_PREFIX = "\x1b_clio:";
const MARK_END = "\x07";
/** A row that starts a new line of copied text. */
export const COPY_ROW_MARK = `${MARK_PREFIX}r${MARK_END}`;
/** A wrapped continuation: joins the row before it with one space. */
export const COPY_JOIN_MARK = `${MARK_PREFIX}s${MARK_END}`;
/** A word broken across rows (a long URL): joins the row before it with no space. */
export const COPY_TIGHT_MARK = `${MARK_PREFIX}w${MARK_END}`;

export type CopyMarkKind = "row" | "join" | "tight";

const KIND_CODE: Readonly<Record<CopyMarkKind, string>> = { row: "r", join: "s", tight: "w" };

/**
 * A mark of `kind` whose next `cells` columns are decoration, never copied: a gutter glyph, a code block's indent, a
 * wrapped code line's `↪`.
 */
export function copyMark(kind: CopyMarkKind, cells = 0): string {
	return `${MARK_PREFIX}${KIND_CODE[kind]}${cells > 0 ? cells : ""}${MARK_END}`;
}

export interface CopyMark {
	kind: CopyMarkKind;
	/** Decoration columns that follow the mark. */
	cells: number;
	/** The mark's length in code units. */
	length: number;
}

function parseMark(line: string, at: number): CopyMark | undefined {
	const end = line.indexOf(MARK_END, at + MARK_PREFIX.length);
	if (end < 0) return undefined;
	const code = line[at + MARK_PREFIX.length];
	const kind: CopyMarkKind = code === "s" ? "join" : code === "w" ? "tight" : "row";
	const cells = Number.parseInt(line.slice(at + MARK_PREFIX.length + 1, end), 10);
	return { kind, cells: Number.isFinite(cells) ? cells : 0, length: end + MARK_END.length - at };
}

export interface SelectedRow {
	line: string;
	start: number;
	end: number;
}

/** The mark a row opens with, if it opens with one. */
export function leadingCopyMark(line: string): CopyMark | undefined {
	return line.startsWith(MARK_PREFIX) ? parseMark(line, 0) : undefined;
}

export function hasCopyMark(line: string): boolean {
	return line.includes(MARK_PREFIX);
}

export function stripCopyMarks(line: string): string {
	let at = line.indexOf(MARK_PREFIX);
	if (at < 0) return line;
	let out = "";
	let from = 0;
	while (at >= 0) {
		const end = line.indexOf(MARK_END, at + MARK_PREFIX.length);
		if (end < 0) break;
		out += line.slice(from, at);
		from = end + MARK_END.length;
		at = line.indexOf(MARK_PREFIX, from);
	}
	return out + line.slice(from);
}

function findMark(line: string): { kind: CopyMarkKind; col: number; cells: number; line: string } | undefined {
	const at = line.indexOf(MARK_PREFIX);
	const mark = at < 0 ? undefined : parseMark(line, at);
	if (mark === undefined) return undefined;
	return { kind: mark.kind, col: visibleWidth(line.slice(0, at)), cells: mark.cells, line: stripCopyMarks(line) };
}

function cells(line: string, start: number, end: number): string {
	return end > start ? stripTerminalSequences(sliceByColumn(line, start, end - start, true)) : "";
}

/**
 * The clipboard text of a selection. Unmarked rows copy exactly as stock pi-tui
 * copies them (each row's selected cells, end-trimmed, one row per line). A
 * marked row drops the decoration cells its mark names, and a continuation row joins the text
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
		const gutterEnd = mark.col + mark.cells;
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
