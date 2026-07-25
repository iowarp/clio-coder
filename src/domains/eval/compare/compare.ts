import type { EvalArtifactV3 } from "../schema/artifact.js";

export interface EvalCompareV3Summary {
	baselineEvalId: string;
	candidateEvalId: string;
	passRateDelta: number;
	tokenDelta: number;
	wallTimeDelta: number;
}

export function compareEvalArtifactsV3(baseline: EvalArtifactV3, candidate: EvalArtifactV3): EvalCompareV3Summary {
	return {
		baselineEvalId: baseline.evalId,
		candidateEvalId: candidate.evalId,
		passRateDelta: candidate.summary.passRate - baseline.summary.passRate,
		tokenDelta: candidate.summary.tokens.total - baseline.summary.tokens.total,
		wallTimeDelta: candidate.summary.wallTimeMs - baseline.summary.wallTimeMs,
	};
}

export function renderEvalComparisonV3(summary: EvalCompareV3Summary): string {
	return [
		`baseline eval: ${summary.baselineEvalId}`,
		`candidate eval: ${summary.candidateEvalId}`,
		`pass-rate delta: ${(summary.passRateDelta * 100).toFixed(2)}%`,
		`token delta: ${summary.tokenDelta}`,
		`wall-time delta ms: ${summary.wallTimeDelta}`,
		"",
	].join("\n");
}
