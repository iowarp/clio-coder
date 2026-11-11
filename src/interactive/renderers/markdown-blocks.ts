import { Marked, type Tokens } from "../../engine/tui.js";
import { holdInlineMath, mathFenceAfter } from "./inline-math.js";

/**
 * Where a streaming answer can be cut into a settled head and an open tail that render apart exactly as the whole
 * renders (#428). The transcript renders an answer through pi-tui's Markdown, which lexes the whole text on every
 * delta; at 500 KB that lex was 78% of a frame. A head cut here renders once per width and only the tail is lexed
 * again.
 *
 * A cut sits after a run of blank lines that Pi's lexer reads as a top-level space token between two blocks, or
 * between two blocks with no blank line where the first is closed by the line that starts the second: a heading,
 * fence or rule, or a paragraph, list or quote that a heading, fence or rule ends. Pi follows most blocks with a
 * spacing row only when another block comes next, so such a head renders with that row added (`spacing`). A cut
 * sits only where no later text can move it:
 * - the line after the blank run is complete, so its indent and marker are known, which is what decides whether a
 *   list or indented code block above continues across the blank run;
 * - the text before it holds no reference definition, which resolves links anywhere in the text;
 * - the inline-math transform has no fence open there, since its fence state runs across the whole text;
 * - no block above it holds a display-math opening line (`$$`, `\[`) that Pi has not read as math, since a closing
 *   line arriving later makes one math block from that line on, across blank lines and the blocks between;
 * - neither block beside the blank run holds only HTML comments, since pi-tui 1.5.1 and later draw no row for such
 *   a block and drop one blank run beside it, and which run goes depends on the blocks around it.
 *
 * The lex runs on the text the way Pi's Markdown sees it: inline math set, tabs as three spaces, and Pi's display
 * math block extension, which can join blocks across blank lines. Every cut keeps its line, so a cut in the lexed
 * text maps back to the source by line.
 */

const plainLexer = new Marked();

// A replica of pi-tui 1.5.2's block LaTeX tokenizer (`tokenizeBlockLatex` in dist/components/markdown.js), which Pi
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

// pi-tui's own test for a block it hides (`removeHtmlCommentBlocks` in dist/components/markdown.js), which Pi does
// not export: an unclosed comment runs to the end of its block.
const HTML_COMMENT_REGEX = /<!--[\s\S]*?(?:-->|$)/g;
function isHiddenCommentBlock(token: Tokens.Generic | undefined): boolean {
	return token?.type === "html" && token.raw.replace(HTML_COMMENT_REGEX, "").trim() === "";
}

/** Blocks that end where the next line starts a heading, fence or rule. */
const ENDED_BY_INTERRUPT = new Set(["paragraph", "list", "blockquote"]);
/** Blocks that a line cannot continue: whatever follows starts a block of its own. */
const SELF_CLOSING = new Set(["heading", "code", "hr"]);
const INTERRUPTS = new Set(["heading", "code", "hr"]);
const AFTER_SELF_CLOSING = new Set(["heading", "code", "hr", "paragraph", "list", "blockquote"]);

/**
 * Whether Pi ends a top-level block with no blank line, where `next` comes straight after `block` as their source
 * reads, and whether the whole then draws a spacing row between them. Undefined where no cut may sit.
 */
function joinedCut(
	first: Tokens.Generic | undefined,
	second: Tokens.Generic | undefined,
): { spacing: boolean } | undefined {
	// An indented code block draws its spacing apart from the rule below, so a cut stays clear of one.
	if (first?.codeBlockStyle === "indented" || second?.codeBlockStyle === "indented") return undefined;
	const block = first?.type;
	const next = second?.type;
	if (block === undefined || next === undefined) return undefined;
	if (SELF_CLOSING.has(block) ? !AFTER_SELF_CLOSING.has(next) : !ENDED_BY_INTERRUPT.has(block) || !INTERRUPTS.has(next))
		return undefined;
	// pi-tui draws no spacing row after a list, nor after a paragraph a list follows.
	return { spacing: block !== "list" && !(block === "paragraph" && next === "list") };
}

/** A display-math opening line, as Pi's block extension starts one. */
const MATH_OPENER = /(?:^|\n) {0,3}(?:\$\$|\\\[)/u;

/** A line that may start a heading, fence or rule, or a blank line: where any cut can sit. */
const CUT_CANDIDATE = /(?:^|\n)(?:[ \t]*\n| {0,3}(?:#{1,6}(?:[ \t]|\n)|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}\n))/u;

/** A settled head: how long it is, and whether the whole draws a spacing row right after it. */
export type SettledHead = { length: number; spacing: boolean };

/**
 * The longest head of `source` that renders apart from the rest exactly as within the whole, at most `limit`
 * long; length 0 when there is none yet. A head with `spacing` renders as within the whole only with a blank line
 * added after it. Null when the text holds a reference definition or a carriage return, so it never splits.
 */
export function settledMarkdownHead(source: string, hold: string, limit: number): SettledHead | null {
	// Marked rewrites CR line ends, which would shift every offset after them.
	if (source.includes("\r")) return null;
	// Every reference definition holds `]:`, and one can complete on a line after its label, so a text that may
	// hold one is always lexed.
	const candidate = source.search(CUT_CANDIDATE);
	if ((candidate < 0 || candidate >= limit) && !source.includes("]:")) return { length: 0, spacing: false };
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
	let cut: SettledHead = { length: 0, spacing: false };
	let mathPending = false;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		const raw = token?.raw ?? "";
		offset += raw.length;
		for (let at = raw.indexOf("\n"); at >= 0; at = raw.indexOf("\n", at + 1)) line += 1;
		// A math opening line still read as text may become one math block with whatever follows; no cut sits after it.
		if (!mathPending && token?.type !== "latexBlock" && token?.type !== "code") mathPending = MATH_OPENER.test(raw);
		if (mathPending || index + 1 === tokens.length) continue;
		let spacing = false;
		if (tokens[index]?.type === "space") {
			if (index === 0) continue;
			if (isHiddenCommentBlock(tokens[index - 1]) || isHiddenCommentBlock(tokens[index + 1])) continue;
		} else {
			const joined = joinedCut(tokens[index], tokens[index + 1]);
			if (joined === undefined) continue;
			spacing = joined.spacing;
		}
		if (text[offset - 1] !== "\n" || text.indexOf("\n", offset) < 0 || fenceOpen[line] !== false) continue;
		const at = lineStart[line] ?? Number.POSITIVE_INFINITY;
		if (at <= limit) cut = { length: at, spacing };
	}
	// The tokens must account for every character, or their offsets cannot be trusted.
	return offset === text.length ? cut : { length: 0, spacing: false };
}
