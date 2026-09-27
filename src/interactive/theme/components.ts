import type { EditorTheme, MarkdownTheme, SelectListTheme } from "../../engine/tui.js";
import { GLYPH } from "./glyphs.js";
import type { ClioTheme } from "./tokens.js";

const identity = (text: string): string => text;

export function markdownTheme(theme: ClioTheme, highlightCode?: MarkdownTheme["highlightCode"]): MarkdownTheme {
	return {
		heading: (text) => theme.fg("transcriptHeading", text),
		link: (text) => theme.fg("link", text),
		linkUrl: (text) => theme.fg("citation", text),
		code: (text) => theme.fg("inlineCode", text),
		codeBlock: (text) => text,
		codeBlockBorder: (text) => theme.fg("border", text),
		quote: (text) => theme.fg("quotation", text),
		quoteBorder: (text) => theme.fg("border", text),
		hr: (text) => theme.fg("border", text),
		listBullet: (text) => theme.fg("listMarker", text),
		bold: (text) => theme.fg("proseEmphasis", text),
		italic: (text) => theme.paint(text, { italic: true }),
		strikethrough: identity,
		underline: (text) => theme.paint(text, { underline: true }),
		...(highlightCode ? { highlightCode } : {}),
	};
}

export function selectListTheme(theme: ClioTheme): SelectListTheme {
	return {
		// Autocomplete and standalone selectors share the same focus marker.
		cursor: GLYPH.cursor,
		selectedPrefix: () => theme.fg("selectedOption", `${GLYPH.cursor} `),
		selectedText: (text) => theme.style("selectedOption", text.replace(/^→ /u, `${GLYPH.cursor} `), { bold: true }),
		description: (text) => theme.fg("menuDescription", text),
		scrollInfo: (text) => theme.fg("positionCount", text),
		noMatch: (text) => theme.fg("emptyState", text),
	};
}

export function editorTheme(theme: ClioTheme): EditorTheme {
	return {
		borderColor: (text) => theme.style("composerRail", text, { bold: true }),
		selectList: selectListTheme(theme),
	};
}
