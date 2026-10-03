/**
 * Terminal output as a command printed it, read for a page instead of a terminal.
 *
 * A tool's output arrives with its escape sequences intact. Colour and weight (SGR) are kept as
 * spans, because a test runner's red and green are information; every other sequence (cursor moves,
 * titles, hyperlinks) means nothing off a terminal and is dropped. A carriage return rewrites its
 * line, as a progress bar expects, so only the last state of that line is kept.
 *
 * Pure, so it runs under plain node:test.
 */

export type AnsiColor = "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white";

export interface AnsiSpan {
	readonly text: string;
	readonly color: AnsiColor | null;
	readonly bold: boolean;
	readonly dim: boolean;
	readonly italic: boolean;
	readonly underline: boolean;
}

const COLORS: readonly AnsiColor[] = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
// CSI with its parameters and final byte, OSC up to its terminator, then the two-byte escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what this matches.
const SEQUENCE = /\x1b\[([0-9;:?<=>]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\^_`a-z=>]?/gu;

export function hasTerminalSequences(text: string): boolean {
	return text.includes("\x1b") || text.includes("\r");
}

/** The last state of every line a carriage return rewrote. */
function settleCarriageReturns(text: string): string {
	if (!text.includes("\r")) return text;
	return text
		.replaceAll("\r\n", "\n")
		.split("\n")
		.map((line) => {
			const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
			return trimmed.slice(trimmed.lastIndexOf("\r") + 1);
		})
		.join("\n");
}

/** The text alone: what a search, a digest or the clipboard should see. */
export function stripAnsi(text: string): string {
	if (!hasTerminalSequences(text)) return text;
	return settleCarriageReturns(text).replace(SEQUENCE, "");
}

/** True when the text carries colour or weight worth drawing, not just sequences to drop. */
export function hasStyle(text: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what this matches.
	return /\x1b\[[0-9;:]*m/u.test(text);
}

interface Style {
	color: AnsiColor | null;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
}

function applySgr(style: Style, parameters: string): void {
	const codes = parameters === "" ? [0] : parameters.split(/[;:]/u).map((code) => Number.parseInt(code || "0", 10));
	for (let index = 0; index < codes.length; index += 1) {
		const code = codes[index] ?? 0;
		if (code === 0) Object.assign(style, { color: null, bold: false, dim: false, italic: false, underline: false });
		else if (code === 1) style.bold = true;
		else if (code === 2) style.dim = true;
		else if (code === 3) style.italic = true;
		else if (code === 4) style.underline = true;
		else if (code === 22) style.bold = style.dim = false;
		else if (code === 23) style.italic = false;
		else if (code === 24) style.underline = false;
		else if (code >= 30 && code <= 37) style.color = COLORS[code - 30] ?? null;
		else if (code >= 90 && code <= 97) style.color = COLORS[code - 90] ?? null;
		else if (code === 39) style.color = null;
		else if (code === 38 || code === 48) {
			// Extended colour: 5;n or 2;r;g;b follow. Only the sixteen named colours have a token to draw in.
			const mode = codes[index + 1];
			if (mode === 5) {
				const n = codes[index + 2] ?? -1;
				if (code === 38) style.color = n >= 0 && n < 16 ? (COLORS[n % 8] ?? null) : null;
				index += 2;
			} else if (mode === 2) {
				if (code === 38) style.color = null;
				index += 4;
			}
		}
	}
}

export function parseAnsi(text: string): readonly AnsiSpan[] {
	const source = settleCarriageReturns(text);
	const spans: AnsiSpan[] = [];
	const style: Style = { color: null, bold: false, dim: false, italic: false, underline: false };
	let from = 0;
	const push = (chunk: string) => {
		if (chunk === "") return;
		const last = spans.at(-1);
		if (
			last &&
			last.color === style.color &&
			last.bold === style.bold &&
			last.dim === style.dim &&
			last.italic === style.italic &&
			last.underline === style.underline
		)
			spans[spans.length - 1] = { ...last, text: last.text + chunk };
		else spans.push({ text: chunk, ...style });
	};
	for (const match of source.matchAll(SEQUENCE)) {
		push(source.slice(from, match.index));
		from = match.index + match[0].length;
		if (match[2] === "m") applySgr(style, match[1] ?? "");
	}
	push(source.slice(from));
	return spans;
}
