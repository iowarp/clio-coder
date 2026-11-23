import type { EditorTheme, MarkdownTheme, SelectListTheme, TuiAltScreenOptions } from "../../engine/tui.js";
import { stripTerminalSequences } from "../../engine/tui.js";
import { GLYPH } from "./glyphs.js";
import type { ClioTheme, PaintMods } from "./tokens.js";

const identity = (text: string): string => text;

/** The `### ` pi-tui paints as its own call before an h3 to h6 heading's text. */
const HEADING_MARKER = /^#{3,6} $/u;

export function markdownTheme(theme: ClioTheme, highlightCode?: MarkdownTheme["highlightCode"]): MarkdownTheme {
	return {
		// The level marker is quiet annotation so the words carry the heading. Only a call whose whole visible text is
		// the marker qualifies, so a heading that spells `###` in its own words keeps every character in the heading role.
		heading: (text) => {
			const visible = stripTerminalSequences(text);
			return HEADING_MARKER.test(visible) ? theme.fg("annotation", visible) : theme.fg("transcriptHeading", text);
		},
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
 * passes the row's own SGR through, so a highlight closes exactly what it opened
 * instead of a full reset that would strip the colour from the rest of a span.
 * Without a palette (depth 16, no color, an unknown background for the badge)
 * the pair itself becomes underline or bold inverse.
 */
export function transcriptSearchTheme(theme: ClioTheme): TranscriptSearchTheme {
	const span = (text: string, mods: PaintMods): string => {
		const { open, close } = theme.sgr(mods);
		return open.length === 0 ? text : `\u001b[${open}m${text}\u001b[${close}m`;
	};
	return {
		searchMatchStyle: (text) => span(text, { bg: "selectionBackground", underline: true }),
		searchCurrentMatchStyle: (text) => span(text, { fg: "onSelection", bg: "selectionBadge", bold: true }),
		searchNavigationButtonStyle: (text, hovered) =>
			hovered ? span(text, { fg: "onSelection", bg: "selectionBadge" }) : theme.fg("commandHint", text),
	};
}
