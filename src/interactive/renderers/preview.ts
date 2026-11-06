import { truncateToWidth } from "../../engine/tui.js";
import { clioTheme, GLYPH } from "../theme/index.js";

/**
 * Count terminal rows after wrapping, including the inspection hint. A block
 * that nests under a gutter glyph passes the rail its rows carry as `prefix`
 * so the hint sits inside the block instead of reading as a new one.
 */
export function previewRows(
	rows: readonly string[],
	limit: number,
	width: number,
	tail = false,
	prefix = "",
	prefixWidth = 0,
	hiddenWords: (hidden: readonly string[]) => string = (hidden) => `${hidden.length} rows`,
): string[] {
	if (rows.length <= limit) return [...rows];
	if (limit <= 0) return [];
	const count = Math.max(0, limit - 1);
	const hidden = tail ? rows.slice(0, rows.length - count) : rows.slice(count);
	const hint = `${prefix}${clioTheme().fg(
		"toolMetadata",
		truncateToWidth(`… ${hiddenWords(hidden)} · /view`, Math.max(1, width - prefixWidth)),
	)}`;
	return tail ? [hint, ...rows.slice(rows.length - count)] : [...rows.slice(0, count), hint];
}

/**
 * A preview of logical lines, each already wrapped to its rows. It keeps whole
 * lines only, so a wrapped line is never cut between its rows, and the hint
 * counts the lines it holds back rather than rows: `14 lines` over a hidden
 * count of 25 wrapped rows read as a contradiction. A single line taller than
 * the room still shows the rows that fit.
 */
export function previewLines(
	lines: ReadonlyArray<readonly string[]>,
	limit: number,
	width: number,
	tail = false,
	prefix = "",
	prefixWidth = 0,
): string[] {
	const total = lines.reduce((sum, line) => sum + line.length, 0);
	if (total <= limit) return lines.flat();
	if (limit <= 0) return [];
	const room = Math.max(0, limit - 1);
	const ordered = tail ? [...lines].reverse() : [...lines];
	const kept: Array<readonly string[]> = [];
	let used = 0;
	for (const line of ordered) {
		if (used + line.length > room) break;
		kept.push(line);
		used += line.length;
	}
	const first = ordered[0] ?? [];
	// A line taller than the room shows what fits, and an ellipsis says where its rows were cut.
	const cut = kept.length === 0 && room > 0 ? (tail ? first.slice(-room) : first.slice(0, room)) : [];
	const partial = cut.map((row, index) =>
		index === cut.length - 1 && !tail
			? `${truncateToWidth(row, Math.max(1, width - 1), "", false)}${GLYPH.ellipsis}`
			: row,
	);
	const hidden = lines.length - kept.length - (partial.length > 0 ? 1 : 0);
	const words = `${hidden} ${tail ? "earlier" : "more"} ${hidden === 1 ? "line" : "lines"}`;
	const hint = `${prefix}${clioTheme().fg(
		"toolMetadata",
		truncateToWidth(`… ${words} · /view`, Math.max(1, width - prefixWidth)),
	)}`;
	const shown = (tail ? kept.reverse() : kept).flat();
	return tail ? [hint, ...partial, ...shown] : [...shown, ...partial, hint];
}

/** Rows grouped into the logical lines they wrap: a continuation row joins the line above it. */
export function groupWrappedRows(rows: readonly string[], continues: (row: string) => boolean): string[][] {
	const lines: string[][] = [];
	for (const row of rows) {
		const last = lines.at(-1);
		if (last && continues(row)) last.push(row);
		else lines.push([row]);
	}
	return lines;
}

/** Leave room for the composer and action identity in a short terminal. */
export function previewBudget(limit: number, terminalRows = 40): number {
	return Math.min(limit, Math.max(2, Math.floor((terminalRows - 8) / 2)));
}
