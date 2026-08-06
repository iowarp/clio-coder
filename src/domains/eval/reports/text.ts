import { tokenMeasurementCoverage } from "../metrics/coverage.js";
import type { EvalArtifactV3 } from "../schema/artifact.js";

export function renderEvalTextReportV3(artifact: EvalArtifactV3): string {
	const coverage = tokenMeasurementCoverage(artifact.results);
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
		coverage.measured === 0
			? `tokens total: unmeasured (0 of ${coverage.total} runs reported usage)`
			: coverage.measured === coverage.total
				? `tokens total: ${artifact.summary.tokens.total}`
				: `tokens total: ${artifact.summary.tokens.total} (measured in ${coverage.measured} of ${coverage.total} runs)`,
		`wall time ms: ${artifact.summary.wallTimeMs}`,
		"",
	].join("\n");
}
