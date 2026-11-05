/**
 * Transcript notices. Routine notices keep a mark in the gutter:
 * `i` information, `✓` success,
 * `⚠` a warning, `✗` an error, `↻` a provider retry and `⊘` a turn the
 * operator cancelled. The mark carries the level in shape and color, the text
 * stays neutral, and a wrapped notice hangs in the content column. The
 * `[Clio Coder]` product tag is dropped because the whole transcript is
 * Clio's; a subsystem tag such as `[/context compact]` or `[model]` stays,
 * dim, because it names which part of Clio is speaking. An advisory, text
 * addressed to the operator such as a tip, a reminder, a memory note or a
 * multi-sentence approval, budget or fleet notice, gets a titled frame instead
 * so it does not read as part of the assistant's answer.
 * Which of the two a notice gets is decided by its `source`, never by width.
 *
 * Pure: no I/O, no module-level mutable state beyond the shared theme handle.
 */
import { taskMemoryNoteForDisplay } from "../../domains/memory/task-memory-ref.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { redactUrlCredentials } from "../../domains/safety/redaction.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import type { NoticeSource } from "../../session-control/notice-source.js";
import { type ClioToken, clioTheme, frame, GLYPH } from "../theme/index.js";

const theme = clioTheme();

// A leading bracketed tag is `[` then any run of non-`]` characters then `]`,
// capturing the whole tag (including inner spaces like `[file read]`) and the
// remainder as the message body.
const LEADING_TAG = /^(\[[^\]]+\])([\s\S]*)$/u;
const PRODUCT_TAG = /^\s*\[Clio Coder\]\s*/u;
const CALLOUT_GUTTER = "  ";
const CALLOUT_MAX_WIDTH = 88;

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
	return sanitizeCallTargetText(redactUrlCredentials(text)).replace(PRODUCT_TAG, "").trim();
}

/** The text without a leading `[tag]` the callout title already says. */
function withoutTag(...tags: string[]): (text: string) => string {
	return (text) => {
		for (const tag of tags) if (text.startsWith(`[${tag}]`)) return text.slice(tag.length + 2).trimStart();
		return text;
	};
}

/**
 * What each advisory source is called and how its text reads once the harness plumbing is off it.
 * Clio's own formatters write sentences that already open with a capital, because a message may open
 * with a command or identifier (`/context`, `npm run x`) that display must not change. A memory note is
 * model-written, so its display form (`taskMemoryNoteForDisplay`) is the one place that capitalizes.
 */
const CALLOUTS: Readonly<Record<NoticeSource, { title: string; body(text: string): string }>> = {
	tip: { title: "Tip", body: (text) => text },
	reminder: { title: "Reminder", body: (text) => text },
	memory: { title: "Memory", body: taskMemoryNoteForDisplay },
	watchdog: { title: "Watchdog", body: withoutTag("watchdog") },
	images: { title: "Images", body: (text) => text },
	approval: { title: "Approval", body: withoutTag("approval") },
	budget: { title: "Budget", body: withoutTag("budget") },
	safety: { title: "Safety", body: withoutTag("safety-net") },
	// A worker's escalation reads `[approval] Worker ...` and a scope notice `[dispatch scope] ...`.
	fleet: { title: "Fleet", body: withoutTag("approval", "dispatch scope") },
	hooks: { title: "Hooks", body: withoutTag("middleware") },
};

function renderCallout(source: NoticeSource, text: string, mark: NoticeMark, width: number): string[] {
	const { title, body: display } = CALLOUTS[source];
	const shown = display(text);
	if (shown.length === 0) return [];
	if (width < 8) return wrapTextWithAnsi(theme.fg("body", shown), Math.max(1, width));
	const boxWidth = Math.min(CALLOUT_MAX_WIDTH, width - CALLOUT_GUTTER.length);
	const { glyph, token } = MARKS[mark];
	const heading = theme.style(token, `${glyph} ${title}`, { bold: true });
	return frame(theme, heading, wrapTextWithAnsi(shown, boxWidth - 4), boxWidth).map(
		(line) => `${CALLOUT_GUTTER}${line}`,
	);
}

/**
 * What a reminder said, as one line: its first line, up to the end of its first
 * sentence or the colon that introduces a list.
 */
function reminderGist(text: string): string {
	// The list a reminder introduces can arrive flattened onto its first line, so the colon ends the gist too.
	const firstLine = (text.split("\n")[0] ?? "").trim();
	return (/^(.+?)(?::\s|:$|[.!?](?:\s|$))/u.exec(firstLine)?.[1] ?? firstLine).trim();
}

/**
 * A reminder is written to the model, so the operator's transcript keeps one
 * row of it: that Clio reminded the model, and of what. The whole text is in
 * /view, which renders the block in full.
 */
function renderReminderRow(text: string, mark: NoticeMark, width: number): string[] {
	const { glyph, token } = MARKS[mark];
	const gist = reminderGist(text);
	const lead = `${theme.fg(token, glyph)} ${theme.style(token, "Reminder", { bold: true })} ${theme.fg("annotation", "to the model ·")} `;
	const tail = theme.fg("commandHint", " · /view");
	// The /view pointer shows whenever the row holds less than the whole reminder.
	const whole = gist.length >= text.trim().replace(/[.!?:]$/u, "").length;
	const fits = visibleWidth(lead) + visibleWidth(gist) <= width;
	const room = Math.max(1, width - visibleWidth(lead) - (whole && fits ? 0 : visibleWidth(tail)));
	const shown = theme.fg("body", truncateToWidth(gist, room, GLYPH.ellipsis, false));
	return [truncateToWidth(`${lead}${shown}${whole && fits ? "" : tail}`, width)];
}

/**
 * One transcript notice. An event keeps its mark in the gutter; an advisory,
 * which the emitting source names, sits in a titled frame. A reminder keeps one
 * row unless `full` asks for its whole text, as /view does. Empty text renders
 * nothing.
 */
export function renderNoticeRow(
	text: string,
	mark: NoticeMark,
	width: number,
	source?: NoticeSource,
	full = false,
): string[] {
	const body = noticeText(text);
	if (body.length === 0) return [];
	if (source === "reminder" && !full && width >= 8) return renderReminderRow(body, mark, width);
	if (source !== undefined) return renderCallout(source, body, mark, width);
	const { glyph, token } = MARKS[mark];
	const tagged = LEADING_TAG.exec(body);
	const styled = tagged ? styleTaggedNotice(body) : theme.fg("body", body);
	const inner = Math.max(1, width - 2);
	const rows = visibleWidth(styled) <= inner ? [styled] : trimStrandedSeparators(wrapTextWithAnsi(styled, inner));
	return rows.map((row, index) => (index === 0 ? `${theme.fg(token, glyph)} ${row}` : `  ${row}`));
}

const ANSI_RUN = "((?:\u001b\\[[0-9;]*m)*)";
const TRAILING_SEPARATOR = new RegExp(`\\s*·${ANSI_RUN}\\s*$`, "u");
const LEADING_SEPARATOR = new RegExp(`^${ANSI_RUN}·\\s+`, "u");

/**
 * A wrap between two facts leaves their ` · ` at a row's end or start, where it separates nothing: `recovered after
 * 2 provider waits ·` read as a fact cut off (N3, E4). The break itself already separates them.
 */
export function trimStrandedSeparators(rows: ReadonlyArray<string>): string[] {
	return rows.map((row) => row.replace(TRAILING_SEPARATOR, "$1").replace(LEADING_SEPARATOR, "$1"));
}
