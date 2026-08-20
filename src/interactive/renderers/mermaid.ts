import { render, type Span } from "grok-mermaid";
import { Marked, type Tokens } from "../../engine/tui.js";
import type { ClioTheme } from "../theme/index.js";

const markdownParser = new Marked();

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
			return theme.fg("frame", span.text);
		case "text":
			return span.text;
		case "edge":
			return theme.fg("accent", span.text);
		case "edgeLabel":
			return theme.fg("muted", span.text);
		case "title":
			return theme.style("accent", span.text, { bold: true });
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
	return (markdown, availableWidth) =>
		markdownParser
			.lexer(markdown)
			.map((token) => {
				if (!isMermaid(token)) return token.raw;
				const art = render(token.text);
				if (!art || art.width > availableWidth) return token.raw;
				const lines = art.styled.map((row) => row.map((span) => styleSpan(span, theme)).join(""));
				return `${lines.map(codeSpan).join("  \n")}\n`;
			})
			.join("");
}
