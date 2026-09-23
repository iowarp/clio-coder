import { truncateToWidth } from "../../engine/tui.js";
import { clioTheme } from "../theme/index.js";

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
): string[] {
	if (rows.length <= limit) return [...rows];
	if (limit <= 0) return [];
	const count = Math.max(0, limit - 1);
	const hint = `${prefix}${clioTheme().fg(
		"dim",
		truncateToWidth(`… ${rows.length - count} rows · /view`, Math.max(1, width - prefixWidth)),
	)}`;
	return tail ? [hint, ...rows.slice(rows.length - count)] : [...rows.slice(0, count), hint];
}

/** Leave room for the composer and action identity in a short terminal. */
export function previewBudget(limit: number, terminalRows = 40): number {
	return Math.min(limit, Math.max(2, Math.floor((terminalRows - 8) / 2)));
}
