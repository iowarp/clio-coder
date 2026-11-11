import { matchesKey } from "../../engine/tui.js";
import type { HintEntry } from "../overlay-frame.js";

const LABEL_MAX = 32;

/**
 * The rail a destructive key shows after its first press: the same key again does it, any other key keeps
 * the row. One shape for every list, so a removal never happens on a single stray letter.
 */
/**
 * The one line a moved letter answers with in its old overlay for one release (E-21 step 6); it does nothing else.
 * Remove the callers in the release after 0.8.0.
 */
export function movedKeyNotice(oldKey: string, newKey: string): string {
	return `${oldKey} is now ${newKey} here`;
}

export function confirmOnceRail(key: string, verb: string, label: string): HintEntry[] {
	const flat = label.replace(/\s+/gu, " ").trim();
	const short = flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1)}…` : flat;
	return [
		{ key: `${key} again`, verb: `to ${verb} "${short}"`, short: verb, critical: true },
		{ key: "any other key", verb: "keeps it", short: "keep" },
	];
}

/** Rows one PgUp or PgDn moves in a list overlay that does not know its own height. */
const LIST_PAGE_ROWS = 10;

/** E-13 paging: PgUp, PgDn, Home and End move a list selection and stop at its ends; null for any other key. */
export function listJump(data: string, index: number, count: number): number | null {
	if (count <= 0) return null;
	const last = count - 1;
	if (matchesKey(data, "home")) return 0;
	if (matchesKey(data, "end")) return last;
	if (matchesKey(data, "pageUp")) return Math.max(0, index - LIST_PAGE_ROWS);
	if (matchesKey(data, "pageDown")) return Math.min(last, index + LIST_PAGE_ROWS);
	return null;
}
