/**
 * Live views of a tool call while it is still moving: a write's content and an
 * edit's replacement text as the model streams them, and a command's output as
 * it runs. Every frame of these used to process the whole payload to show a
 * handful of rows. Redaction, sanitizing and wrapping a 2,000-line write cost
 * 12-22 ms per frame and a 2,000-line command 14-31 ms, against a 16 ms frame,
 * so a long call ran frames back to back and the keyboard waited behind them.
 *
 * Here a frame costs the rows it shows. A streamed text is indexed once as it
 * grows (line starts and the code-ink carry before each line), and a frame
 * reads only the window it paints. Secrets are redacted on that window plus a
 * few lines above it, which is enough for every pattern in `redaction.ts`: none
 * of them crosses a newline except a `--flag value` pair split over lines.
 *
 * The views keep a fixed height once they fill, a `… N lines above` row over
 * the newest lines, so the transcript does not jump while text streams. Rows
 * are cut to the width rather than wrapped for the same reason.
 */
import { sanitizeMultilineDisplayText } from "../../domains/safety/call-target.js";
import { redactSecretString } from "../../domains/safety/redaction.js";
import { truncateToWidth } from "../../engine/tui.js";
import { clioTheme, GLYPH } from "../theme/index.js";
import { skinEpoch } from "../theme/tokens.js";
import { type CodeInkCarry, type CodeInkLexer, codeInkLangForPath, codeInkLexer } from "./code-ink.js";

/** Lines above the window that redaction reads, so a flag on one line still hides its value on the next. */
const REDACTION_MARGIN_LINES = 3;

export type LiveSign = "+" | "-";

export interface LiveRowsOptions {
	/** Styled prefix every row carries, and its visible width. */
	rail: string;
	railWidth: number;
	sign?: LiveSign;
}

/**
 * A text that only grows while it streams, indexed incrementally. A text that
 * stops being an extension of the last one (a partial-JSON repair that changed
 * its last escape) is indexed again from the start; that is rare and bounded.
 */
export class LiveTextTail {
	private text = "";
	private lineStarts: number[] = [0];
	private carries: CodeInkCarry[] = [];
	private memo: { key: string; rows: string[] } | null = null;
	/** Painted rows of completed lines, by line index, for one width and sign. */
	private readonly painted = new Map<number, string>();
	private paintedStyle = "";
	private readonly lexer: CodeInkLexer | null;

	constructor(lang?: string) {
		this.lexer = codeInkLexer(lang);
		if (this.lexer !== null) this.carries.push(this.lexer.start);
	}

	update(next: string): void {
		if (next === this.text) return;
		if (next.length < this.text.length || !next.startsWith(this.text)) {
			this.text = "";
			this.lineStarts = [0];
			this.carries = this.lexer === null ? [] : [this.lexer.start];
			this.painted.clear();
		}
		let from = this.text.length;
		this.text = next;
		for (let newline = next.indexOf("\n", from); newline >= 0; newline = next.indexOf("\n", from)) {
			const lineStart = this.lineStarts[this.lineStarts.length - 1] ?? 0;
			if (this.lexer !== null) {
				const carry = this.carries[this.carries.length - 1] ?? this.lexer.start;
				this.carries.push(this.lexer.advance(next.slice(lineStart, newline), carry));
			}
			this.lineStarts.push(newline + 1);
			from = newline + 1;
		}
	}

	/** Lines so far. A trailing newline opens no line until text follows it. */
	get lineCount(): number {
		const last = this.lineStarts[this.lineStarts.length - 1] ?? 0;
		return last < this.text.length ? this.lineStarts.length : this.lineStarts.length - 1;
	}

	private line(index: number): string {
		const start = this.lineStarts[index] ?? this.text.length;
		const next = this.lineStarts[index + 1];
		return this.text.slice(start, next === undefined ? this.text.length : next - 1);
	}

	/**
	 * The newest rows of the text in at most `rows` rows, the first saying how
	 * many lines are above them. A newline-terminated line never changes again,
	 * and neither does its redaction, which reads only that line and the ones
	 * before it, so its row is painted once and reused. A frame paints the
	 * open last line and whatever scrolled into view.
	 */
	rows(rows: number, width: number, options: LiveRowsOptions): string[] {
		if (rows <= 0) return [];
		const key = `${skinEpoch()}:${this.text.length}:${rows}:${width}:${options.sign ?? ""}:${options.railWidth}`;
		if (this.memo?.key === key) return this.memo.rows;
		const style = `${skinEpoch()}:${width}:${options.sign ?? ""}:${options.railWidth}`;
		if (this.paintedStyle !== style) {
			this.painted.clear();
			this.paintedStyle = style;
		}
		const total = this.lineCount;
		const shown = total <= rows ? total : rows - 1;
		const start = total - shown;
		let first = start;
		while (first < total && this.painted.has(first)) first += 1;
		const fresh: string[] = [];
		if (first < total) {
			const marginStart = Math.max(0, first - REDACTION_MARGIN_LINES);
			const raw: string[] = [];
			for (let index = marginStart; index < total; index += 1) raw.push(this.line(index));
			const window = safeWindow(raw, first - marginStart);
			const inked = this.lexer === null ? window : this.lexer.ink(window, this.carries[first] ?? this.lexer.start);
			const completed = this.lineStarts.length - 1;
			inked.forEach((line, offset) => {
				const row = liveRow(line, width, options);
				if (first + offset < completed) this.painted.set(first + offset, row);
				fresh.push(row);
			});
		}
		for (const index of this.painted.keys()) if (index < start) this.painted.delete(index);
		const out: string[] = [];
		if (shown < total) out.push(aboveRow(total - shown, width, options));
		for (let index = start; index < first; index += 1) out.push(this.painted.get(index) ?? "");
		out.push(...fresh);
		this.memo = { key, rows: out };
		return out;
	}
}

/** Redact with the margin in view, sanitize, then drop the margin. */
function safeWindow(raw: readonly string[], margin: number): string[] {
	const safe = sanitizeMultilineDisplayText(redactSecretString(raw.join("\n"))).text.split("\n");
	return safe.slice(margin);
}

function aboveRow(hidden: number, width: number, options: LiveRowsOptions & LiveOutputOptions): string {
	const text =
		options.truncatedTotal !== undefined
			? `${GLYPH.ellipsis} earlier output above · ${options.truncatedTotal} so far`
			: `${GLYPH.ellipsis} ${hidden} ${hidden === 1 ? "line" : "lines"} above`;
	return `${options.rail}${clioTheme().fg("toolMetadata", truncateToWidth(text, Math.max(1, width - options.railWidth)))}`;
}

function liveRow(line: string, width: number, options: LiveRowsOptions): string {
	const theme = clioTheme();
	const sign =
		options.sign === undefined ? "" : theme.fg(options.sign === "+" ? "success" : "error", `${options.sign} `);
	const budget = Math.max(1, width - options.railWidth);
	return `${options.rail}${truncateToWidth(`${sign}${line}`, budget, GLYPH.ellipsis)}`;
}

export interface LiveOutputOptions {
	/**
	 * The tool kept only the tail of what the command printed; this is the size
	 * of everything it printed, already formatted. The row above the window
	 * states it, since a line count of the kept tail would understate it.
	 */
	truncatedTotal?: string;
}

/**
 * The newest rows of a command's cumulative output. The tool already keeps
 * only a bounded tail; this reads the last lines of it by scanning back from
 * the end, so a frame never splits or sanitizes the rest.
 */
function liveOutputRows(
	text: string,
	rows: number,
	width: number,
	options: LiveRowsOptions & LiveOutputOptions,
): string[] {
	if (rows <= 0) return [];
	const body = text.replace(/\s+$/u, "");
	if (body.length === 0) return [];
	let total = 1;
	for (let at = body.indexOf("\n"); at >= 0; at = body.indexOf("\n", at + 1)) total += 1;
	const hiddenAbove = options.truncatedTotal !== undefined;
	const shown = Math.min(total, total <= rows && !hiddenAbove ? total : rows - 1);
	const wanted = shown + REDACTION_MARGIN_LINES;
	let cut = body.length;
	for (let seen = 0; seen < wanted && cut > 0; seen += 1) cut = body.lastIndexOf("\n", cut - 1);
	const raw = (cut < 0 ? body : body.slice(cut + 1)).split("\n");
	const window = safeWindow(raw, Math.max(0, raw.length - shown));
	const out: string[] = [];
	if (shown < total || hiddenAbove) out.push(aboveRow(total - shown, width, options));
	for (const line of window) out.push(liveRow(line, width, options));
	return out;
}

/**
 * Per-call live state the transcript keeps on a segment while it is in
 * flight: one indexed text per streamed field and the latest output window.
 * Rendering without one gives identical rows; it only costs more per frame.
 */
export class LiveToolView {
	private readonly tails = new Map<string, LiveTextTail>();
	private output: { text: string; key: string; rows: string[] } | null = null;

	tail(field: string, path?: string): LiveTextTail {
		let tail = this.tails.get(field);
		if (tail === undefined) {
			tail = new LiveTextTail(path === undefined ? undefined : codeInkLangForPath(path));
			this.tails.set(field, tail);
		}
		return tail;
	}

	outputRows(text: string, rows: number, width: number, options: LiveRowsOptions & LiveOutputOptions): string[] {
		const key = `${skinEpoch()}:${rows}:${width}:${options.railWidth}:${options.truncatedTotal ?? ""}`;
		if (this.output?.text === text && this.output.key === key) return this.output.rows;
		const out = liveOutputRows(text, rows, width, options);
		this.output = { text, key, rows: out };
		return out;
	}
}
