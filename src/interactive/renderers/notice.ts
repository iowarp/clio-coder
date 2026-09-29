/**
 * Transcript notices. Routine notices keep a mark in the gutter:
 * `i` information, `✓` success,
 * `⚠` a warning, `✗` an error, `↻` a provider retry and `⊘` a turn the
 * operator cancelled. The mark carries the level in shape and color, the text
 * stays neutral, and a wrapped notice hangs in the content column. The
 * `[Clio Coder]` product tag is dropped because the whole transcript is
 * Clio's; a subsystem tag such as `[/context compact]` or `[model]` stays,
 * dim, because it names which part of Clio is speaking. Operator tips use a
 * compact frame so they do not read as part of the assistant's answer.
 *
 * Pure: no I/O, no module-level mutable state beyond the shared theme handle.
 */
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { type ClioToken, clioTheme, frame, GLYPH } from "../theme/index.js";

const theme = clioTheme();

// A leading bracketed tag is `[` then any run of non-`]` characters then `]`,
// capturing the whole tag (including inner spaces like `[file read]`) and the
// remainder as the message body.
const LEADING_TAG = /^(\[[^\]]+\])([\s\S]*)$/u;
const PRODUCT_TAG = /^\s*\[Clio Coder\]\s*/u;
const TIP_TAG = /^\[tip\](?:\s+|$)/u;
const TIP_GUTTER = "  ";
const TIP_MAX_WIDTH = 88;

export type NoticeMark = "info" | "success" | "warning" | "error" | "retry" | "cancelled";

const MARKS: Readonly<Record<NoticeMark, { glyph: string; token: ClioToken }>> = {
	info: { glyph: GLYPH.info, token: "info" },
	success: { glyph: GLYPH.ok, token: "success" },
	warning: { glyph: GLYPH.warn, token: "warning" },
	error: { glyph: GLYPH.error, token: "error" },
	retry: { glyph: GLYPH.phaseRetry, token: "warning" },
	// An operator cancel is not a warning; the footer settles the same turn as
	// `⊘ cancelled`, so its closing row matches (BT-013).
	cancelled: { glyph: GLYPH.cancelled, token: "toolMetadata" },
};

/** A leading bracketed tag in `dim`, the message in `muted`; untagged text passes unchanged. */
function styleTaggedNotice(line: string): string {
	const match = LEADING_TAG.exec(line);
	if (!match) return line;
	const tag = match[1] ?? "";
	const body = match[2] ?? "";
	const styledTag = theme.fg(tag === "[retry]" ? "warning" : "toolMetadata", tag);
	return body.length > 0 ? `${styledTag}${theme.fg("body", body)}` : styledTag;
}

/** The notice as the operator reads it: one line, without the product tag. */
function noticeText(text: string): string {
	return sanitizeCallTargetText(text).replace(PRODUCT_TAG, "").trim();
}

function renderTipCard(text: string, width: number): string[] {
	if (text.length === 0) return [];
	if (width < 8) return wrapTextWithAnsi(theme.fg("body", text), Math.max(1, width));
	const boxWidth = Math.min(TIP_MAX_WIDTH, width - TIP_GUTTER.length);
	const body = wrapTextWithAnsi(text, boxWidth - 4);
	const title = theme.style("guidance", `${GLYPH.info} Tip`, { bold: true });
	return frame(theme, title, body, boxWidth).map((line) => `${TIP_GUTTER}${line}`);
}

/**
 * One transcript notice. Routine marks stay in the gutter; operator tips sit
 * in a compact frame. Empty text renders nothing.
 */
export function renderNoticeRow(text: string, mark: NoticeMark, width: number): string[] {
	const body = noticeText(text);
	if (body.length === 0) return [];
	if (mark === "info" && TIP_TAG.test(body)) return renderTipCard(body.replace(TIP_TAG, ""), width);
	const { glyph, token } = MARKS[mark];
	const tagged = LEADING_TAG.exec(body);
	const styled = tagged ? styleTaggedNotice(body) : theme.fg("body", body);
	const inner = Math.max(1, width - 2);
	const rows = visibleWidth(styled) <= inner ? [styled] : wrapTextWithAnsi(styled, inner);
	return rows.map((row, index) => (index === 0 ? `${theme.fg(token, glyph)} ${row}` : `  ${row}`));
}
