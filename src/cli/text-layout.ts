/**
 * Width-aware layout for the plain-stdout CLI surfaces.
 *
 * The TUI measures the terminal on every frame; the command-line surfaces did
 * not measure it at all. `clio-coder configure --list` and the first-run runtime
 * menu wrote fixed-width rows assuming roughly 88 columns, so at 80, the
 * oldest default there is, the model column ran past the edge and the terminal
 * wrapped it into a second line that no longer lined up with anything. The
 * first thing a new user sees was the surface that handled width worst.
 *
 * Everything here operates on ASCII runtime ids, labels, and summaries, so
 * `length` is the display width. The TUI keeps its own grapheme-aware
 * measurement for content that can carry anything.
 */

/** Columns to lay out for, with a floor that keeps arithmetic non-negative. */
export function terminalColumns(stream: { columns?: number | undefined } = process.stdout): number {
	const columns = stream.columns;
	// A pipe reports no width. 80 is the conventional answer and is also the
	// width the fixed-width rows were implicitly written for.
	if (typeof columns !== "number" || !Number.isFinite(columns)) return 80;
	return Math.max(20, Math.floor(columns));
}

/** Shorten to `width`, marking the cut so a truncated value never reads as complete. */
export function truncate(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	if (width === 1) return "…";
	return `${text.slice(0, width - 1)}…`;
}

/** Pad to exactly `width`, truncating anything longer so the next column still starts where it should. */
export function column(text: string, width: number): string {
	return truncate(text, width).padEnd(width);
}

/**
 * Wrap on whitespace to `width`, indenting every line after the first by
 * `hangingIndent`. A single word longer than the available room is emitted
 * whole rather than split, because runtime ids and URLs are worse broken.
 */
export function wrapPlain(text: string, width: number, hangingIndent = 0): string[] {
	const words = text.split(/\s+/).filter((word) => word.length > 0);
	if (words.length === 0) return [""];
	const indent = " ".repeat(hangingIndent);
	const lines: string[] = [];
	// `width` is the room for text on every line. The indent is added only when
	// a line is emitted, so it never eats into the budget the next word is
	// measured against.
	let current = "";
	const emit = (line: string): void => {
		lines.push(lines.length === 0 ? line : `${indent}${line}`);
	};
	for (const word of words) {
		if (current.length === 0) {
			current = word;
			continue;
		}
		if (current.length + 1 + word.length <= width) {
			current = `${current} ${word}`;
			continue;
		}
		emit(current);
		current = word;
	}
	emit(current);
	return lines;
}

export interface TwoColumnOptions {
	/** Leading spaces before the left column. */
	indent: number;
	/** Width reserved for the left column, including its trailing gap. */
	leftWidth: number;
	width: number;
	/** Below this much room for the right column, stack instead of aligning. */
	minRight?: number;
}

/**
 * A label beside its description, degrading to the label on its own line with
 * the description indented beneath when the terminal cannot hold both.
 */
export function twoColumnRow(left: string, right: string, options: TwoColumnOptions): string[] {
	const { indent, leftWidth, width } = options;
	const minRight = options.minRight ?? 24;
	const pad = " ".repeat(indent);
	const rightRoom = width - indent - leftWidth;
	if (rightRoom >= minRight) {
		const wrapped = wrapPlain(right, rightRoom, indent + leftWidth);
		const [first = "", ...rest] = wrapped;
		return [`${pad}${column(left, leftWidth)}${first}`, ...rest];
	}
	const stackIndent = indent + 2;
	return [
		`${pad}${left}`,
		...wrapPlain(right, Math.max(8, width - stackIndent), stackIndent).map((line, index) =>
			index === 0 ? `${" ".repeat(stackIndent)}${line}` : line,
		),
	];
}
