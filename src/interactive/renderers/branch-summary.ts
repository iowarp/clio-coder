/**
 * Renderer for BranchSummary session entries (Phase 12 / slice 12b).
 *
 * A branchSummary entry is produced when a fork inherits a compacted parent
 * context: the new session opens with a single summary block standing in for
 * the parent lineage. Showing that block up front is what tells a forked
 * session's chat panel "you inherited this context" without replaying the
 * pre-fork transcript verbatim.
 *
 * The renderer is pure: `(entry, width) -> string[]`. It mirrors the segment
 * output shape the existing chat-panel render loop emits so a later slice can
 * feed the lines through the transcript unchanged. No pi-agent-core or
 * session-writer imports; tests construct a synthetic entry and assert on the
 * rendered lines directly.
 */

import type { BranchSummaryEntry } from "../../domains/session/entries.js";
import { Markdown, type MarkdownTheme, wrapTextWithAnsi } from "../../engine/tui.js";

const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_DIM = "\u001b[2m";
const ANSI_ITALIC = "\u001b[3m";
const ANSI_UNDERLINE = "\u001b[4m";

const LABEL = "branch summary";
const BODY_INDENT = "  ";

/**
 * Default markdown theme for the framed summary body. Matches the chat-panel
 * theme (bold headings, dim code/quotes) so a branch summary visually sits
 * in the same register as the rest of the chat, just indented by
 * `BODY_INDENT` to signal that it is context the user did not author.
 */
const BRANCH_SUMMARY_THEME: MarkdownTheme = {
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

export interface RenderBranchSummaryOptions {
	/** Override the default markdown theme. Falls back to the branch-summary theme above. */
	theme?: MarkdownTheme;
	/** Drop the `[branch summary]` header line. Useful when the label is drawn by the caller. */
	hideLabel?: boolean;
}

/**
 * One-line banner that announces a branch summary without the body. The
 * replay path can use it as a placeholder when the full block is rendered
 * lazily (future `Ctrl+O`-style expand).
 */
export function renderBranchSummaryHeader(entry: BranchSummaryEntry, width: number): string[] {
	const dim = (text: string): string => `${ANSI_DIM}${text}${ANSI_RESET}`;
	const label = `${ANSI_BOLD}[${LABEL}]${ANSI_RESET}`;
	const meta = dim(`from turn ${entry.fromTurnId}`);
	return wrapTextWithAnsi(`${label} ${meta}`, width);
}

/**
 * Render a BranchSummary entry as a framed, indented block the chat panel
 * can splice into its transcript. Returns `[]` when the entry has no summary
 * text so empty entries do not punch a blank block into the chat.
 *
 * Layout:
 *   [branch summary] from turn <fromTurnId>
 *     <markdown body line 1>
 *     <markdown body line 2>
 *     ...
 *
 * The leading label and the two-space body indent give the block a visible
 * left edge without drawing box characters; box-drawing would collide with
 * pi-tui's Markdown left pad and drift under wraps. `width` is the usable
 * chat-pane width; the body is rendered at `width - BODY_INDENT.length` so
 * the indent never forces a line past the pane edge.
 */
export function renderBranchSummaryEntry(
	entry: BranchSummaryEntry,
	width: number,
	options: RenderBranchSummaryOptions = {},
): string[] {
	const summary = entry.summary.trim();
	if (summary.length === 0) return [];

	const out: string[] = [];
	if (!options.hideLabel) {
		out.push(...renderBranchSummaryHeader(entry, width));
	}

	const bodyWidth = Math.max(1, width - BODY_INDENT.length);
	const theme = options.theme ?? BRANCH_SUMMARY_THEME;
	const md = new Markdown(summary, 0, 0, theme);
	for (const line of md.render(bodyWidth)) {
		// Markdown right-pads each line to `bodyWidth` so background colors
		// extend edge-to-edge. Trim the trailing pad before applying the
		// indent so the visible width stays within the pane.
		const trimmed = line.replace(/ +$/, "");
		out.push(`${BODY_INDENT}${trimmed}`);
	}
	return out;
}
