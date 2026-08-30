import type { EvalArtifactV4 } from "../schema/artifact.js";

export function renderEvalTextReportV4(artifact: EvalArtifactV4): string {
	const tokens = artifact.summary.tokens;
	const behavioral = artifact.results.flatMap((result) =>
		result.behavioral === undefined ? [] : [result.behavioral.outcome],
	);
	const behavioralSummary =
		behavioral.length === 0
			? []
			: [
					`behavioral: pass=${count(behavioral, "pass")} failure=${count(behavioral, "behavioral_failure")} unknown=${count(behavioral, "unknown")} unmeasured=${count(behavioral, "unmeasured")} infrastructure=${count(behavioral, "infrastructure_failure")}`,
				];
	return [
		`eval: ${artifact.evalId}`,
		`suite: ${artifact.suite.id}`,
		`target: ${artifact.matrix.target}`,
		`model: ${artifact.matrix.model ?? "none"}`,
		`runs: ${artifact.summary.runs}`,
		`passed: ${artifact.summary.passed}`,
		`failed: ${artifact.summary.failed}`,
		`pass rate: ${(artifact.summary.passRate * 100).toFixed(2)}%`,
		// A run whose child Clio work is out of the harness's sight has no token
		// count. Saying "0" would claim it cost nothing, so the count is
		// reported next to how many runs it actually covers.
		!tokens.measured
			? `tokens total: unmeasured (0 of ${tokens.runs} runs reported usage)`
			: tokens.measuredRuns === tokens.runs
				? `tokens total: ${tokens.total}`
				: `tokens total: ${tokens.total} (measured in ${tokens.measuredRuns} of ${tokens.runs} runs)`,
		`wall time ms: ${artifact.summary.wallTimeMs}`,
		...behavioralSummary,
		"",
	].join("\n");
}

function count(values: ReadonlyArray<string>, wanted: string): number {
	return values.filter((value) => value === wanted).length;
}
