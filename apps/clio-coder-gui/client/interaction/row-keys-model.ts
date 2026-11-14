// Up and Down (and j and k) between the rows of a list whose rows are links and buttons. Pure, so
// node:test covers it; `row-keys.ts` reads the DOM and calls it.

/**
 * Where focus sits among `length` rows: on row `at`, or, when `on` is false, somewhere after the
 * first `at` rows (a heading or a per-group button between them).
 */
export interface RowPosition {
	readonly at: number;
	readonly on: boolean;
}

const NEXT = new Set(["ArrowDown", "j"]);
const PREVIOUS = new Set(["ArrowUp", "k"]);

/**
 * The row a key moves to, or -1 when the key is not a row key or there is no row. The list does not
 * wrap: Down on the last row stays there, as a scrolling list does.
 */
export function rowAfterKey(key: string, position: RowPosition, length: number): number {
	if (length < 1) return -1;
	const clamp = (index: number) => Math.min(length - 1, Math.max(0, index));
	if (NEXT.has(key)) return clamp(position.on ? position.at + 1 : position.at);
	if (PREVIOUS.has(key)) return clamp(position.at - 1);
	if (key === "Home") return 0;
	if (key === "End") return length - 1;
	return -1;
}
