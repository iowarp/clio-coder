import type { EvalArtifactV4 } from "../schema/artifact.js";

export interface EvalCompareV4Summary {
	baselineEvalId: string;
	candidateEvalId: string;
	passRateDelta: number;
	/** Null when either side observed no usage: a delta against an unknown is not zero. */
	tokenDelta: number | null;
	wallTimeDelta: number;
}

export function compareEvalArtifactsV4(baseline: EvalArtifactV4, candidate: EvalArtifactV4): EvalCompareV4Summary {
	const baselineTokens = baseline.summary.tokens;
	const candidateTokens = candidate.summary.tokens;
	return {
		baselineEvalId: baseline.evalId,
		candidateEvalId: candidate.evalId,
		passRateDelta: candidate.summary.passRate - baseline.summary.passRate,
		tokenDelta: baselineTokens.measured && candidateTokens.measured ? candidateTokens.total - baselineTokens.total : null,
		wallTimeDelta: candidate.summary.wallTimeMs - baseline.summary.wallTimeMs,
	};
}

export function renderEvalComparisonV4(summary: EvalCompareV4Summary): string {
	return [
		`baseline eval: ${summary.baselineEvalId}`,
		`candidate eval: ${summary.candidateEvalId}`,
		`pass-rate delta: ${(summary.passRateDelta * 100).toFixed(2)}%`,
		`token delta: ${summary.tokenDelta === null ? "unmeasured" : summary.tokenDelta}`,
		`wall-time delta ms: ${summary.wallTimeDelta}`,
		"",
	].join("\n");
}
