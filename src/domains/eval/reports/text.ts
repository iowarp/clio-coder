import type { EvalArtifactV2 } from "../schema/artifact.js";

export function renderEvalTextReportV2(artifact: EvalArtifactV2): string {
	return [
		`eval: ${artifact.evalId}`,
		`suite: ${artifact.suite.id}`,
		`target: ${artifact.matrix.target}`,
		`model: ${artifact.matrix.model ?? "none"}`,
		`runs: ${artifact.summary.runs}`,
		`passed: ${artifact.summary.passed}`,
		`failed: ${artifact.summary.failed}`,
		`pass rate: ${(artifact.summary.passRate * 100).toFixed(2)}%`,
		`tokens total: ${artifact.summary.tokens.total}`,
		`wall time ms: ${artifact.summary.wallTimeMs}`,
		"",
	].join("\n");
}
