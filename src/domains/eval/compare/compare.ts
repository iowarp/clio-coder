import type { EvalArtifactV2 } from "../schema/artifact-v2.js";

export interface EvalCompareV2Summary {
	baselineEvalId: string;
	candidateEvalId: string;
	passRateDelta: number;
	tokenDelta: number;
	wallTimeDelta: number;
}

export function compareEvalArtifactsV2(baseline: EvalArtifactV2, candidate: EvalArtifactV2): EvalCompareV2Summary {
	return {
		baselineEvalId: baseline.evalId,
		candidateEvalId: candidate.evalId,
		passRateDelta: candidate.summary.passRate - baseline.summary.passRate,
		tokenDelta: candidate.summary.tokens.total - baseline.summary.tokens.total,
		wallTimeDelta: candidate.summary.wallTimeMs - baseline.summary.wallTimeMs,
	};
}

export function renderEvalComparisonV2(summary: EvalCompareV2Summary): string {
	return [
		`baseline eval: ${summary.baselineEvalId}`,
		`candidate eval: ${summary.candidateEvalId}`,
		`pass-rate delta: ${(summary.passRateDelta * 100).toFixed(2)}%`,
		`token delta: ${summary.tokenDelta}`,
		`wall-time delta ms: ${summary.wallTimeDelta}`,
		"",
	].join("\n");
}
