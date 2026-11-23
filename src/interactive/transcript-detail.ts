/** The transcript slice of the presentation tier table. Detailed is still bounded. */
import type { OutputStyle } from "../core/defaults.js";
import { presentationTier, type TierPolicy, tierPolicy } from "../core/presentation-tier.js";

export interface TranscriptDetailPolicy
	extends Pick<
		TierPolicy,
		| "evidence"
		| "provenance"
		| "reasoningRows"
		| "reasoningBeforeActionRows"
		| "invocationRows"
		| "resultRows"
		| "liveResultRows"
		| "bashRows"
		| "operatorBashRows"
		| "diffRows"
		| "workerRows"
		| "workerActivity"
		| "errorRows"
		| "receipt"
	> {
	style: OutputStyle;
}

function slice(tier: OutputStyle): TranscriptDetailPolicy {
	const policy = tierPolicy(tier);
	return {
		style: policy.tier,
		evidence: policy.evidence,
		provenance: policy.provenance,
		reasoningRows: policy.reasoningRows,
		reasoningBeforeActionRows: policy.reasoningBeforeActionRows,
		invocationRows: policy.invocationRows,
		resultRows: policy.resultRows,
		liveResultRows: policy.liveResultRows,
		bashRows: policy.bashRows,
		operatorBashRows: policy.operatorBashRows,
		diffRows: policy.diffRows,
		workerRows: policy.workerRows,
		workerActivity: policy.workerActivity,
		errorRows: policy.errorRows,
		receipt: policy.receipt,
	};
}

const SLICES: Readonly<Record<OutputStyle, TranscriptDetailPolicy>> = {
	compact: slice("compact"),
	standard: slice("standard"),
	detailed: slice("detailed"),
};

/** The transcript budgets of `style`, or of the current presentation tier when none is named. */
export function transcriptDetail(style: OutputStyle = presentationTier()): TranscriptDetailPolicy {
	return SLICES[style];
}
