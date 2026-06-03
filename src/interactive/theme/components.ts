import type { EditorTheme, MarkdownTheme, SelectListTheme, SettingsListTheme } from "../../engine/tui.js";
import type { ClioTheme } from "./tokens.js";

const identity = (text: string): string => text;

export function markdownTheme(theme: ClioTheme, highlightCode?: MarkdownTheme["highlightCode"]): MarkdownTheme {
	return {
		heading: (text) => theme.style("title", text, { bold: true }),
		link: (text) => theme.fg("info", text),
		linkUrl: (text) => theme.fg("dim", text),
		code: (text) => theme.fg("muted", text),
		codeBlock: (text) => text,
		codeBlockBorder: (text) => theme.fg("frame", text),
		quote: (text) => theme.fg("muted", text),
		quoteBorder: (text) => theme.fg("frame", text),
		hr: (text) => theme.fg("frame", text),
		listBullet: (text) => theme.fg("accent", text),
		bold: (text) => theme.paint(text, { bold: true }),
		italic: (text) => theme.paint(text, { italic: true }),
		strikethrough: identity,
		underline: (text) => theme.paint(text, { underline: true }),
		...(highlightCode ? { highlightCode } : {}),
	};
}

export function selectListTheme(theme: ClioTheme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.style("accent", text, { bold: true }),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	};
}

export function settingsListTheme(theme: ClioTheme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.style("accent", text, { bold: true }) : text),
		value: (text, selected) => (selected ? theme.fg("success", text) : theme.fg("muted", text)),
		description: (text) => theme.fg("muted", text),
		cursor: "▸",
		hint: (text) => theme.fg("dim", text),
	};
}

export function editorTheme(theme: ClioTheme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("frame", text),
		selectList: selectListTheme(theme),
	};
}
