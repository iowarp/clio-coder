import { truncateToWidth } from "../../engine/tui.js";
import { clioTheme } from "../theme/index.js";

/** Count terminal rows after wrapping, including the inspection hint. */
export function previewRows(rows: readonly string[], limit: number, width: number, tail = false): string[] {
	if (rows.length <= limit) return [...rows];
	if (limit <= 0) return [];
	const count = Math.max(0, limit - 1);
	const hint = clioTheme().fg("dim", truncateToWidth(`… ${rows.length - count} rows · /view`, Math.max(1, width)));
	return tail ? [hint, ...rows.slice(rows.length - count)] : [...rows.slice(0, count), hint];
}

/** Leave room for the composer and action identity in a short terminal. */
export function previewBudget(limit: number, terminalRows = 40): number {
	return Math.min(limit, Math.max(2, Math.floor((terminalRows - 8) / 2)));
}
