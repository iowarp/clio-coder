import type { EvalArtifactV3 } from "../schema/artifact.js";

export function renderEvalMarkdownReportV3(artifact: EvalArtifactV3): string {
	const lines = [
		`# Eval ${artifact.evalId}`,
		"",
		`Suite: ${artifact.suite.id}`,
		`Target: ${artifact.matrix.target}`,
		`Pass rate: ${(artifact.summary.passRate * 100).toFixed(2)}%`,
		"",
		"| Task | Target | Model | Repeat | Pass | Failure |",
		"|---|---|---|---:|---|---|",
		...artifact.results.map(
			(result) =>
				`| ${result.taskId} | ${result.target.id} | ${result.target.model ?? ""} | ${result.repeatIndex} | ${result.pass ? "pass" : "fail"} | ${result.failureClass ?? ""} |`,
		),
		"",
	];
	return `${lines.join("\n")}`;
}
