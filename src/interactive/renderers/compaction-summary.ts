/**
 * Minimal renderer for compactionSummary entries (Phase 12 slice 12c).
 *
 * The rich chat-panel integration (colorized diff, collapsible detail,
 * tokens-before/after badge) lands with Phase 19. This file ships the
 * placeholder line the /compact handler writes to stdout so users get
 * feedback that the compaction ran. Pure; no TUI dependency.
 */

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
 * One-line placeholder the /compact handler writes to stdout.
 * Example output:
 *   [compacted: 42 messages → 1823 chars (~31420 tokens before)]
 * Split-turn runs carry a `(split turn)` suffix so the user knows the cut
 * landed mid-turn and upstream context may need a re-read.
 */
export function renderCompactionSummaryLine(input: CompactionSummaryLineInput): string {
	const tail = input.isSplitTurn ? " (split turn)" : "";
	return `[compacted: ${input.messagesSummarized} messages → ${input.summaryChars} chars (~${input.tokensBefore} tokens before)${tail}]`;
}
