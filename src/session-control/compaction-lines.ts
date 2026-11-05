export interface CompactionSummaryLineInput {
	/** How many entries the summarization prompt consumed. */
	messagesSummarized: number;
	/** Final length in characters of the generated summary text. */
	summaryChars: number;
	/** Context tokens the footer showed before compaction. */
	tokensBefore: number;
	/**
	 * Context tokens the footer shows after compaction. This is the whole next
	 * request (system prompt, tool schemas, summary and retained suffix), not the
	 * summary alone, so the row and the footer name one figure.
	 */
	tokensAfter: number;
	/** True when the cut fell mid-turn; callers may want to annotate. */
	isSplitTurn?: boolean;
}

/** `36175` as `36.2K`, the footer's own reading of a token count. */
export function footerTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens < 1000) return String(Math.max(0, Math.round(tokens)));
	const thousands = tokens / 1000;
	const fixed = thousands.toFixed(1);
	if (thousands < 1000) return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed}K`;
	const millions = (tokens / 1_000_000).toFixed(1);
	return `${millions.endsWith(".0") ? millions.slice(0, -2) : millions}M`;
}

/**
 * The persistent transcript row an automatic or `/context compact` run leaves.
 * Example:
 *   Clio compacted 36.2K → 28.6K tokens: 42 earlier messages now read as one summary
 * The `[context engine]` tag and `summarized to 1823 chars` were Clio's own bookkeeping; the row says what changed for
 * the conversation. A split-turn run says the cut landed inside a turn, so upstream context may need a re-read, and a
 * run that saved nothing says so instead of leaving `13K → 13K` to be decoded.
 */
/** How the compaction row starts, so a surface that routes it to the footer can tell it apart. */
export const COMPACTION_LINE_LEAD = "Clio compacted ";

export function renderCompactionSummaryLine(input: CompactionSummaryLineInput): string {
	const count = input.messagesSummarized;
	const messages = `${count} earlier message${count === 1 ? "" : "s"} now read${count === 1 ? "s" : ""} as one summary`;
	const flat = input.tokensAfter >= input.tokensBefore ? "; the context is no smaller" : "";
	const tail = input.isSplitTurn ? " (the cut fell inside a turn)" : "";
	return `${COMPACTION_LINE_LEAD}${footerTokens(input.tokensBefore)} → ${footerTokens(input.tokensAfter)} tokens: ${messages}${flat}${tail}`;
}

/** Why the non-destructive stage had nothing to do before a summary ran. */
export type EvictionSkipReason = "all-protected" | "nothing-evictable" | "disabled";

export interface EvictionSkipLineInput {
	reason: EvictionSkipReason;
	/** Turn starts in the visible slice the policy was offered. */
	turns: number;
	protectLastTurns: number;
	protectLastSteps: number;
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
	const window = `protectLastTurns ${input.protectLastTurns}, protectLastSteps ${input.protectLastSteps}`;
	const cause =
		input.reason === "disabled"
			? "eviction is off (context.workingSet.enabled false)"
			: input.reason === "all-protected"
				? `nothing evictable, all ${input.turns} ${turnWord} are inside the protected window (${window})`
				: `nothing evictable by ${input.policyId} above the protected window (${window})`;
	return `[context engine] working set: ${cause}; llm_summary runs instead`;
}
