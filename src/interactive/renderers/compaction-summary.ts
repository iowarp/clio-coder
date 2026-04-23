/**
 * Renderers for CompactionSummary session entries (Phase 12 slice 12c).
 *
 * Two output shapes live here:
 *   1. `renderCompactionSummaryLine` is the inline one-liner chat-loop
 *      emits to stdout after an auto-compaction or `/compact` run. It is
 *      the pre-slice-4/6 shape and stays intact for that caller.
 *   2. `renderCompactionSummaryEntry` renders a persisted
 *      `CompactionSummaryEntry` as a framed, indented block the chat panel
 *      can splice into a replayed transcript. The block visually marks the
 *      compaction boundary so a resumed or forked session opens with a
 *      clear "here is the summary; the real conversation starts below"
 *      delimiter rather than reading as ordinary chat.
 *
 * Pure functions: no TUI dependency beyond pi-tui's Markdown renderer and
 * the shared ANSI wrap helper. Callers read `SessionEntry` from disk and
 * splice the returned `string[]` into chat-panel's render loop.
 */

import type { CompactionSummaryEntry } from "../../domains/session/entries.js";
import { Markdown, type MarkdownTheme, wrapTextWithAnsi } from "../../engine/tui.js";

const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_DIM = "\u001b[2m";
const ANSI_ITALIC = "\u001b[3m";
const ANSI_UNDERLINE = "\u001b[4m";

const LABEL = "compaction summary";
const BODY_INDENT = "  ";

/**
 * Markdown theme for the framed summary body. Matches the chat-panel theme
 * (bold headings, dim code/quotes) so a compacted block sits in the same
 * visual register as the surrounding chat, just indented by `BODY_INDENT`.
 */
const COMPACTION_SUMMARY_THEME: MarkdownTheme = {
	heading: (text) => `${ANSI_BOLD}${text}${ANSI_RESET}`,
	link: (text) => text,
	linkUrl: (text) => `${ANSI_DIM}${text}${ANSI_RESET}`,
	code: (text) => `${ANSI_DIM}${text}${ANSI_RESET}`,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => `${ANSI_DIM}${text}${ANSI_RESET}`,
	quote: (text) => `${ANSI_DIM}${text}${ANSI_RESET}`,
	quoteBorder: (text) => `${ANSI_DIM}${text}${ANSI_RESET}`,
	hr: (text) => `${ANSI_DIM}${text}${ANSI_RESET}`,
	listBullet: (text) => text,
	bold: (text) => `${ANSI_BOLD}${text}${ANSI_RESET}`,
	italic: (text) => `${ANSI_ITALIC}${text}${ANSI_RESET}`,
	strikethrough: (text) => text,
	underline: (text) => `${ANSI_UNDERLINE}${text}${ANSI_RESET}`,
};

export interface CompactionSummaryLineInput {
	/** How many entries the summarization prompt consumed. */
	messagesSummarized: number;
	/** Final length in characters of the generated summary text. */
	summaryChars: number;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** True when the cut fell mid-turn; callers may want to annotate. */
	isSplitTurn?: boolean;
}

/**
 * One-line notice the `/compact` handler writes to stdout. Example:
 *   [compacted: 42 messages → 1823 chars (~31420 tokens before)]
 * Split-turn runs carry a `(split turn)` suffix so the user knows the cut
 * landed mid-turn and upstream context may need a re-read.
 */
export function renderCompactionSummaryLine(input: CompactionSummaryLineInput): string {
	const tail = input.isSplitTurn ? " (split turn)" : "";
	return `[compacted: ${input.messagesSummarized} messages → ${input.summaryChars} chars (~${input.tokensBefore} tokens before)${tail}]`;
}

export interface RenderCompactionSummaryOptions {
	/** Override the default markdown theme. Defaults to the local theme above. */
	theme?: MarkdownTheme;
	/** Drop the `[compaction summary]` header so the caller can draw its own label. */
	hideLabel?: boolean;
}

/**
 * Render a single header line announcing a compaction boundary. Format:
 *   [compaction summary] ~12345 tokens before → cont. at turn <id>
 * Used on its own for placeholder replays and as the first line of
 * `renderCompactionSummaryEntry` when the body is included too.
 */
export function renderCompactionSummaryHeader(entry: CompactionSummaryEntry, width: number): string[] {
	const dim = (text: string): string => `${ANSI_DIM}${text}${ANSI_RESET}`;
	const label = `${ANSI_BOLD}[${LABEL}]${ANSI_RESET}`;
	const tokens = Number.isFinite(entry.tokensBefore) ? entry.tokensBefore.toLocaleString() : "0";
	const meta = dim(`~${tokens} tokens before, cont. at turn ${entry.firstKeptTurnId}`);
	return wrapTextWithAnsi(`${label} ${meta}`, width);
}

/**
 * Render a persisted CompactionSummary entry as a framed, indented block
 * suitable for chat-panel's render loop. Returns `[]` when the entry has no
 * summary text so an empty entry does not punch a blank block into the
 * chat.
 *
 * Layout:
 *   [compaction summary] ~12345 tokens before, cont. at turn <firstKeptTurnId>
 *     <markdown body line 1>
 *     <markdown body line 2>
 *     ...
 *
 * `width` is the usable chat-pane width; the body is rendered at
 * `width - BODY_INDENT.length` so the indent never forces a line past the
 * pane edge. The Markdown renderer right-pads each line to its requested
 * width; we trim that trailing pad before applying the indent so visible
 * width stays within the pane.
 */
export function renderCompactionSummaryEntry(
	entry: CompactionSummaryEntry,
	width: number,
	options: RenderCompactionSummaryOptions = {},
): string[] {
	const summary = entry.summary.trim();
	if (summary.length === 0) return [];

	const out: string[] = [];
	if (!options.hideLabel) {
		out.push(...renderCompactionSummaryHeader(entry, width));
	}

	const bodyWidth = Math.max(1, width - BODY_INDENT.length);
	const theme = options.theme ?? COMPACTION_SUMMARY_THEME;
	const md = new Markdown(summary, 0, 0, theme);
	for (const line of md.render(bodyWidth)) {
		const trimmed = line.replace(/ +$/, "");
		out.push(`${BODY_INDENT}${trimmed}`);
	}
	return out;
}
