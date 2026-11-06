import { Marked, type Tokens } from "../../engine/tui.js";
import { holdInlineMath, mathFenceAfter } from "./inline-math.js";

/**
 * Where a streaming answer can be cut into a settled head and an open tail that render apart exactly as the whole
 * renders (#428). The transcript renders an answer through pi-tui's Markdown, which lexes the whole text on every
 * delta; at 500 KB that lex was 78% of a frame. A head cut here renders once per width and only the tail is lexed
 * again.
 *
 * A cut sits after a run of blank lines that Pi's lexer reads as a top-level space token between two blocks, and
 * only where no later text can move it:
 * - the line after the blank run is complete, so its indent and marker are known, which is what decides whether a
 *   list or indented code block above continues across the blank run;
 * - the text before it holds no reference definition, which resolves links anywhere in the text;
 * - the inline-math transform has no fence open there, since its fence state runs across the whole text.
 *
 * The lex runs on the text the way Pi's Markdown sees it: inline math set, tabs as three spaces, and Pi's display
 * math block extension, which can join blocks across blank lines. Every cut keeps its line, so a cut in the lexed
 * text maps back to the source by line.
 */

const plainLexer = new Marked();

// A replica of pi-tui 1.5.0's block LaTeX tokenizer (`tokenizeBlockLatex` in dist/components/markdown.js), which Pi
// does not export. Only its block extent matters here, and it must move with the pi-tui pin.
const TABLE_DELIMITER_ROW_REGEX = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
function containsTableStart(source: string): boolean {
	const lines = source.split("\n");
	for (let index = 0; index < lines.length - 1; index++) {
		const delimiterRow = lines[index + 1] ?? "";
		if (
			(delimiterRow.includes("|") || (lines[index] ?? "").includes("|")) &&
			TABLE_DELIMITER_ROW_REGEX.test(delimiterRow)
		)
			return true;
	}
	return false;
}
function looksLikePendingDollarMath(source: string): boolean {
	return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
}
function latexBlock(source: string): Tokens.Generic | undefined {
	const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
	if (dollarMatch?.[1] && !containsTableStart(dollarMatch[1])) return { type: "latexBlock", raw: dollarMatch[0] };
	const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
	if (bracketMatch?.[1] && !containsTableStart(bracketMatch[1])) return { type: "latexBlock", raw: bracketMatch[0] };
	const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (pendingBracket?.[1] && !containsTableStart(pendingBracket[1]))
		return { type: "latexBlock", raw: pendingBracket[0] };
	const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1]) && !containsTableStart(pendingDollar[1]))
		return { type: "latexBlock", raw: pendingDollar[0] };
	return undefined;
}
const latexLexer = new Marked().use({
	extensions: [
		{
			name: "latexBlock",
			level: "block",
			start(source: string) {
				const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
				return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
			},
			tokenizer: latexBlock,
		},
	],
});

/**
 * The length of the longest head of `source` that renders apart from the rest exactly as within the whole, at most
 * `limit`; 0 when there is none yet. Null when the text holds a reference definition or a carriage return, so it
 * never splits.
 */
export function settledMarkdownHead(source: string, hold: string, limit: number): number | null {
	// Marked rewrites CR line ends, which would shift every offset after them.
	if (source.includes("\r")) return null;
	// Every reference definition holds `]:`, and one can complete on a line after its label, so a text that may
	// hold one is always lexed.
	const firstBlank = source.search(/\n[ \t]*\n/u);
	if ((firstBlank < 0 || firstBlank >= limit) && !source.includes("]:")) return 0;
	const text = holdInlineMath(source, hold).replace(/\t/g, "   ");
	const lexer = text.includes("$$") || text.includes("\\[") ? latexLexer : plainLexer;
	const tokens = lexer.lexer(text);
	if (Object.keys(tokens.links).length > 0) return null;
	// Where each line starts in the source, and whether the math fence is open there.
	const lineStart: number[] = [];
	const fenceOpen: boolean[] = [];
	let fence: string | null = null;
	let start = 0;
	for (const line of source.split("\n")) {
		lineStart.push(start);
		fenceOpen.push(fence !== null);
		fence = mathFenceAfter(line, fence);
		start += line.length + 1;
	}
	let offset = 0;
	let line = 0;
	let cut = 0;
	for (let index = 0; index < tokens.length; index++) {
		const raw = tokens[index]?.raw ?? "";
		offset += raw.length;
		for (let at = raw.indexOf("\n"); at >= 0; at = raw.indexOf("\n", at + 1)) line += 1;
		if (tokens[index]?.type !== "space" || index === 0 || index + 1 === tokens.length) continue;
		if (text[offset - 1] !== "\n" || text.indexOf("\n", offset) < 0 || fenceOpen[line] !== false) continue;
		const at = lineStart[line] ?? Number.POSITIVE_INFINITY;
		if (at <= limit) cut = at;
	}
	// The tokens must account for every character, or their offsets cannot be trusted.
	return offset === text.length ? cut : 0;
}
