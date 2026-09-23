/**
 * Transcript notices. Every notice the transcript keeps is one block with a
 * mark in the gutter, like every other block: `ℹ` information, `✓` success,
 * `⚠` a warning, `✗` an error and `↻` a provider retry. The mark carries the
 * level in shape and color, the text stays `muted`, and a wrapped notice hangs
 * in the content column. The `[Clio Coder]` product tag is dropped because the
 * whole transcript is Clio's; a subsystem tag such as `[/context compact]` or
 * `[model]` stays, dim, because it names which part of Clio is speaking.
 *
 * Pure: no I/O, no module-level mutable state beyond the shared theme handle.
 */
import { visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { type ClioToken, clioTheme, GLYPH } from "../theme/index.js";

const theme = clioTheme();

// A leading bracketed tag is `[` then any run of non-`]` characters then `]`,
// capturing the whole tag (including inner spaces like `[file read]`) and the
// remainder as the message body.
const LEADING_TAG = /^(\[[^\]]+\])([\s\S]*)$/u;
const PRODUCT_TAG = /^\s*\[Clio Coder\]\s*/u;

export type NoticeMark = "info" | "success" | "warning" | "error" | "retry";

const MARKS: Readonly<Record<NoticeMark, { glyph: string; token: ClioToken }>> = {
	info: { glyph: GLYPH.info, token: "info" },
	success: { glyph: GLYPH.ok, token: "success" },
	warning: { glyph: GLYPH.warn, token: "warning" },
	error: { glyph: GLYPH.error, token: "error" },
	retry: { glyph: GLYPH.phaseRetry, token: "warning" },
};

/** A leading bracketed tag in `dim`, the message in `muted`; untagged text passes unchanged. */
function styleTaggedNotice(line: string): string {
	const match = LEADING_TAG.exec(line);
	if (!match) return line;
	const tag = match[1] ?? "";
	const body = match[2] ?? "";
	const styledTag = theme.fg(tag === "[retry]" ? "warning" : "dim", tag);
	return body.length > 0 ? `${styledTag}${theme.fg("muted", body)}` : styledTag;
}

/** The notice as the operator reads it: one line, without the product tag. */
function noticeText(text: string): string {
	return text
		.replace(/\r/gu, "")
		.replace(/\s*\n+\s*/gu, " ")
		.replace(PRODUCT_TAG, "")
		.trim();
}

/**
 * One transcript notice: its mark in the gutter and the text in the content
 * column, every wrapped row hanging two cells in. Empty text renders nothing.
 */
export function renderNoticeRow(text: string, mark: NoticeMark, width: number): string[] {
	const body = noticeText(text);
	if (body.length === 0) return [];
	const { glyph, token } = MARKS[mark];
	const tagged = LEADING_TAG.exec(body);
	const styled = tagged ? styleTaggedNotice(body) : theme.fg("muted", body);
	const inner = Math.max(1, width - 2);
	const rows = visibleWidth(styled) <= inner ? [styled] : wrapTextWithAnsi(styled, inner);
	return rows.map((row, index) => (index === 0 ? `${theme.fg(token, glyph)} ${row}` : `  ${row}`));
}
