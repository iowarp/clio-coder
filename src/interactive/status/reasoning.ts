import type { ReasoningTokenProvenance, RunTally, TurnSummary } from "./types.js";

/**
 * One projection of a turn's reasoning spend for every surface that shows it.
 *
 * Reasoning counts used to be derived in three places (the status tally, the
 * chat panel's own `message_end` re-derivation, and a chars/4 estimate over the
 * visible thinking text), so the transcript, the turn receipt, and the footer
 * could each report a different number for the same turn. Everything now reads
 * `RunTally`/`TurnSummary` through this module, so a surface can differ in
 * layout but never in the number or its provenance.
 *
 * `unmeasured` is a view-only state: nothing has been folded yet, so the count
 * is unknown rather than zero. It never reaches `TurnSummary`, which keeps its
 * persisted `provider | estimated | mixed` vocabulary.
 */
export type ReasoningProvenance = ReasoningTokenProvenance | "unmeasured";

export interface ReasoningUsageView {
	tokens: number;
	provenance: ReasoningProvenance;
}

export const UNMEASURED_REASONING: ReasoningUsageView = { tokens: 0, provenance: "unmeasured" };

function provenanceOf(hadProvider: boolean, hadEstimated: boolean): ReasoningProvenance {
	if (hadProvider && hadEstimated) return "mixed";
	if (hadProvider) return "provider";
	if (hadEstimated) return "estimated";
	return "unmeasured";
}

function finiteTokens(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Live view of the in-flight turn, folded message by message as the run settles. */
export function reasoningFromTally(tally: RunTally | undefined): ReasoningUsageView {
	if (!tally) return UNMEASURED_REASONING;
	const provenance = provenanceOf(tally.hadProviderReasoning === true, tally.hadEstimatedReasoning === true);
	if (provenance === "unmeasured") return UNMEASURED_REASONING;
	return { tokens: finiteTokens(tally.reasoningTokens), provenance };
}

/** Settled view of a turn, including one replayed from a persisted summary. */
export function reasoningFromSummary(summary: TurnSummary | undefined): ReasoningUsageView {
	if (!summary || typeof summary.reasoningTokens !== "number") return UNMEASURED_REASONING;
	// A summary persisted before provenance was recorded carries a count and no
	// label. `summaryFromRunTally` writes both together, so this only covers
	// replayed history, where the count came from provider usage.
	return { tokens: finiteTokens(summary.reasoningTokens), provenance: summary.reasoningTokenProvenance ?? "provider" };
}

/**
 * Compact token text for the surfaces that have no formatter of their own. The
 * footer passes its own `formatFooterTokens` so its chips keep the width
 * budget the rest of the footer is measured against.
 */
export function compactReasoningTokens(value: number): string {
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) {
		const scaled = (value / 1000).toFixed(1);
		return `${scaled.endsWith(".0") ? scaled.slice(0, -2) : scaled}k`;
	}
	const scaled = (value / 1_000_000).toFixed(1);
	return `${scaled.endsWith(".0") ? scaled.slice(0, -2) : scaled}M`;
}

/**
 * `r123` for a provider-attested count, `r≈123` for anything Clio inferred.
 * Null when there is nothing to state: an unmeasured turn, or one that spent no
 * reasoning tokens at all (a chip reading `r0` names the provenance of zero).
 */
export function formatReasoningChip(
	view: ReasoningUsageView,
	format: (value: number) => string = compactReasoningTokens,
): string | null {
	if (view.provenance === "unmeasured" || view.tokens <= 0) return null;
	return `r${view.provenance === "provider" ? "" : "≈"}${format(view.tokens)}`;
}

export function formatReasoningLabel(view: ReasoningUsageView): string {
	if (view.provenance === "provider") return "provider-reported";
	if (view.provenance === "estimated") return "estimated";
	if (view.provenance === "mixed") return "mixed";
	return "unmeasured";
}
