import type { EditorTheme, MarkdownTheme, SelectListTheme, TuiAltScreenOptions } from "../../engine/tui.js";
import { GLYPH } from "./glyphs.js";
import { type ClioTheme, SGR_RESET } from "./tokens.js";

const identity = (text: string): string => text;

export function markdownTheme(theme: ClioTheme, highlightCode?: MarkdownTheme["highlightCode"]): MarkdownTheme {
	return {
		heading: (text) => theme.fg("transcriptHeading", text),
		link: (text) => theme.fg("link", text),
		linkUrl: (text) => theme.fg("citation", text),
		code: (text) => theme.fg("inlineCode", text),
		codeBlock: (text) => text,
		// The fence carries the language name, so it is quiet text at 4.5:1, never a 2:1 hairline.
		codeBlockBorder: (text) => theme.fg("annotation", text),
		quote: (text) => theme.fg("quotation", text),
		quoteBorder: (text) => theme.fg("quoteRail", text),
		hr: (text) => theme.fg("transcriptRule", text),
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

type TranscriptSearchTheme = Required<
	Pick<TuiAltScreenOptions, "searchMatchStyle" | "searchCurrentMatchStyle" | "searchNavigationButtonStyle">
>;

/**
 * Fullscreen transcript search. pi-tui wraps only the plain text of a match and
 * passes the row's own SGR through, so a highlight closes what it opened instead
 * of a full reset that would strip the colour from the rest of a span.
 */
export function transcriptSearchTheme(theme: ClioTheme): TranscriptSearchTheme {
	const closing = (painted: string, close: string): string =>
		painted.endsWith(SGR_RESET) ? `${painted.slice(0, -SGR_RESET.length)}${close}` : painted;
	const colored = () => theme.bg("selectionBadge", " ") !== " ";
	return {
		searchMatchStyle: (text) =>
			closing(theme.paint(text, { bg: "selectionBackground", underline: true }), "\u001b[24;49m"),
		// Without colour the badge pair paints nothing, so the current match falls back to inverse.
		searchCurrentMatchStyle: (text) =>
			colored()
				? closing(theme.paint(text, { fg: "onSelection", bg: "selectionBadge", bold: true }), "\u001b[22;39;49m")
				: `\u001b[1;7m${text}\u001b[22;27m`,
		searchNavigationButtonStyle: (text, hovered) => {
			if (!hovered) return theme.fg("commandHint", text);
			return colored() ? theme.paint(text, { fg: "onSelection", bg: "selectionBadge" }) : `\u001b[7m${text}\u001b[27m`;
		},
	};
}
