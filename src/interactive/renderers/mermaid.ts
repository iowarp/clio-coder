import { render, type Span } from "grok-mermaid";
import { Marked, type Tokens } from "../../engine/tui.js";
import type { ClioTheme } from "../theme/index.js";

const markdownParser = new Marked();

// Only a diagram that would bury the transcript falls back on height. The old
// limit of about two rows per source line rejected every top-to-bottom chain
// past four or five nodes, since each node draws about five rows.
const MAX_DIAGRAM_ROWS = 120;
const MAX_CACHED_LAYOUTS = 16;
/** Retained UTF-16 code units, excluding object/array overhead. */
const MAX_CACHED_TEXT = 131_072;

function isMermaid(token: Tokens.Generic): token is Tokens.Code {
	return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

function codeSpan(line: string): string {
	const content = line || "\u00a0";
	const longestBacktickRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(longestBacktickRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

function styleSpan(span: Span, theme: ClioTheme): string {
	switch (span.cls) {
		case "border":
			return theme.fg("border", span.text);
		case "text":
			return span.text;
		case "edge":
			return theme.fg("guidance", span.text);
		case "edgeLabel":
			return theme.fg("body", span.text);
		case "title":
			return theme.style("guidance", span.text, { bold: true });
		case "none":
			return span.text;
	}
}

/**
 * Render top-level Mermaid fences through pi-tui's Markdown transform hook.
 * The token-to-code-span strategy follows pi-coding-agent 0.84 so Markdown
 * preserves every box-drawing row and its significant whitespace.
 */
export function createMermaidMarkdownTransform(theme: ClioTheme): (markdown: string, availableWidth: number) => string {
	// A finished diagram is still in the Markdown source on every later text
	// delta. Reuse its layout while continuing to apply the current theme below.
	// Bound both the entry count and retained source/art size: partial diagrams
	// and arbitrary model output must not turn this into a session-sized cache.
	const layouts = new Map<string, { art: ReturnType<typeof render>; size: number }>();
	let retained = 0;
	const layout = (source: string, width: number): ReturnType<typeof render> => {
		const key = `${width}:${source}`;
		const cached = layouts.get(key);
		if (cached !== undefined) {
			layouts.delete(key);
			layouts.set(key, cached);
			return cached.art;
		}
		let art = render(source);
		if (art && art.width > width) {
			const stacked = source.replace(/^(\s*(?:flowchart|graph)\s+)LR\b/, "$1TD");
			if (stacked !== source) art = render(stacked);
		}
		const size =
			key.length +
			(art?.styled.reduce((sum, row) => sum + row.reduce((n, span) => n + span.text.length, 0), 0) ?? 0) +
			(art?.plain.reduce((sum, row) => sum + row.length, 0) ?? 0) +
			(art?.warnings.reduce((sum, warning) => sum + warning.length, 0) ?? 0);
		if (size <= MAX_CACHED_TEXT) {
			layouts.set(key, { art, size });
			retained += size;
			while (layouts.size > MAX_CACHED_LAYOUTS || retained > MAX_CACHED_TEXT) {
				const oldest = layouts.entries().next().value;
				if (oldest === undefined) break;
				retained -= oldest[1].size;
				layouts.delete(oldest[0]);
			}
		}
		return art;
	};
	return (markdown, availableWidth) =>
		markdownParser
			.lexer(markdown)
			.map((token) => {
				if (!isMermaid(token)) return token.raw;
				const art = layout(token.text, availableWidth);
				const fallback = !art
					? "could not be drawn"
					: art.width > availableWidth
						? `is ${art.width} columns wide and the terminal fits ${availableWidth}`
						: art.styled.length > MAX_DIAGRAM_ROWS
							? `is ${art.styled.length} rows tall, over the ${MAX_DIAGRAM_ROWS}-row limit`
							: null;
				if (!art || fallback !== null) {
					// Say why only once the fence is closed, so a diagram still streaming in
					// does not flash a note on every frame.
					if (!/\n[ \t]*(?:`{3,}|~{3,})[ \t]*\n*$/.test(token.raw)) return token.raw;
					return `${token.raw.replace(/\n*$/, "")}\n\n${theme.fg("metadata", `Mermaid diagram shown as source: it ${fallback}.`)}\n\n`;
				}
				const lines = art.styled.map((row) => row.map((span) => styleSpan(span, theme)).join(""));
				return `${lines.map(codeSpan).join("  \n")}\n`;
			})
			.join("");
}
