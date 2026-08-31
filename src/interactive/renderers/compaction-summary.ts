/**
 * Renderers for CompactionSummary session entries (Phase 12 slice 12c).
 *
 * Two output shapes live here:
 *   1. `renderCompactionSummaryLine` is the inline one-liner chat-loop
 *      emits after an auto-compaction or `/context compact` run. It uses the same
 *      `[context engine] <stage>:` shape as the observation-mask notice.
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
import { clioTheme, markdownTheme, screenTitle } from "../theme/index.js";

const LABEL = "compaction summary";
const BODY_INDENT = "  ";

const theme = clioTheme();
const COMPACTION_SUMMARY_THEME: MarkdownTheme = markdownTheme(theme);

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
 * One-line notice the `/context compact` handler writes to stdout. Example:
 *   [context engine] llm_summary: 42 messages summarized to 1823 chars; ~31420 tokens before
 * Split-turn runs carry a `(split turn)` suffix so the user knows the cut
 * landed mid-turn and upstream context may need a re-read.
 */
export function renderCompactionSummaryLine(input: CompactionSummaryLineInput): string {
	const tail = input.isSplitTurn ? " (split turn)" : "";
	return `[context engine] llm_summary: ${input.messagesSummarized} messages summarized to ${input.summaryChars} chars; ~${input.tokensBefore} tokens before${tail}`;
}

/** Why the non-destructive stage had nothing to do before a summary ran. */
export type EvictionSkipReason = "all-protected" | "nothing-evictable" | "disabled";

export interface EvictionSkipLineInput {
	reason: EvictionSkipReason;
	/** Turn starts in the visible slice the policy was offered. */
	turns: number;
	protectLastTurns: number;
	policyId: string;
}

/**
 * One line saying the working-set stage was considered and declined, in the
 * same `[context engine] working set:` voice its eviction notice uses. Without
 * it a short session falls from the pressure threshold straight into the
 * destructive summary with nothing in the transcript explaining why the cheap
 * stage did not run (smoke pass 2, G1).
 */
export function renderEvictionSkipLine(input: EvictionSkipLineInput): string {
	const turnWord = input.turns === 1 ? "turn" : "turns";
	const cause =
		input.reason === "disabled"
			? "eviction is off (context.workingSet.enabled false)"
			: input.reason === "all-protected"
				? `nothing evictable, all ${input.turns} ${turnWord} are inside the protected window (protectLastTurns ${input.protectLastTurns})`
				: `nothing evictable by ${input.policyId} above the protected window (protectLastTurns ${input.protectLastTurns})`;
	return `[context engine] working set: ${cause}; llm_summary runs instead`;
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
function renderCompactionSummaryHeader(entry: CompactionSummaryEntry, width: number): string[] {
	const label = screenTitle(theme, `[${LABEL}]`);
	const tokens = Number.isFinite(entry.tokensBefore) ? entry.tokensBefore.toLocaleString() : "0";
	const trigger = entry.trigger ? ` via ${entry.trigger}` : "";
	const meta = theme.fg("dim", `~${tokens} tokens before, cont. at turn ${entry.firstKeptTurnId}${trigger}`);
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
