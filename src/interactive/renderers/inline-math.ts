import { renderLatex } from "../../engine/tui.js";

/**
 * Inline math (`$x_i - \mu$`) set as one unbreakable run before Markdown wraps the paragraph.
 *
 * Pi renders inline LaTeX to Unicode and then wraps at any space inside it, so a formula could split at
 * `(xᵢ` and start the next row with `- μ)²`, which reads as a list bullet. Each inline span is rendered
 * here instead, its spaces replaced by `hold` (a visible blank the wrapper does not break at, turned
 * back into a space after wrapping) and its Markdown punctuation escaped so it prints as written.
 * Fenced blocks, inline code and display math (`$$`) are left for Pi, and a span Pi's renderer cannot
 * read stays as its source.
 */
const INLINE_MATH = /(?<![\\$\w])\$(?![\s$])([^$\n]*?[^\s\\$])\$(?![$\w])/gu;
// Only marks that open inline Markdown are escaped: an escaped `(` would open Pi's own `\(…\)` math.
const MARKDOWN_PUNCTUATION = /[\\`*_[\]|<>~$]/gu;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

export function holdInlineMath(text: string, hold: string): string {
	if (!text.includes("$")) return text;
	let fence: string | null = null;
	return text
		.split("\n")
		.map((line) => {
			const outside = fence === null;
			fence = mathFenceAfter(line, fence);
			if (!outside || fence !== null) return line;
			if (!line.includes("$")) return line;
			// Inline code is copied through untouched: split on backtick runs and set only the parts outside them.
			return line
				.split(/(`+[^`]*`+)/u)
				.map((part, index) =>
					index % 2 === 1 ? part : part.replace(INLINE_MATH, (whole, source: string) => setMath(whole, source, hold)),
				)
				.join("");
		})
		.join("\n");
}

/**
 * The fence `holdInlineMath` holds open after `line`, given the one open before it. Its state runs across the
 * whole text, so a caller that sets a text in pieces cuts only where this is null (#428).
 */
export function mathFenceAfter(line: string, fence: string | null): string | null {
	const opened = FENCE.exec(line);
	if (fence !== null) return opened?.[1]?.startsWith(fence) ? null : fence;
	return opened === null ? null : (opened[1]?.charAt(0).repeat(3) ?? null);
}

function setMath(whole: string, source: string, hold: string): string {
	const rendered = renderLatex(source);
	if (rendered === undefined || rendered.includes("\n")) return whole;
	return rendered.replace(MARKDOWN_PUNCTUATION, "\\$&").replaceAll(" ", hold);
}
