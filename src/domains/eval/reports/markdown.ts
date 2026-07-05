import type { EvalArtifactV2 } from "../schema/artifact.js";

export function renderEvalMarkdownReportV2(artifact: EvalArtifactV2): string {
	const lines = [
		`# Eval ${artifact.evalId}`,
		"",
		`Suite: ${artifact.suite.id}`,
		`Target: ${artifact.matrix.target}`,
		`Pass rate: ${(artifact.summary.passRate * 100).toFixed(2)}%`,
		"",
		"| Task | Repeat | Pass | Failure |",
		"|---|---:|---|---|",
		...artifact.results.map(
			(result) =>
				`| ${result.taskId} | ${result.repeatIndex} | ${result.pass ? "pass" : "fail"} | ${result.failureClass ?? ""} |`,
		),
		"",
	];
	return `${lines.join("\n")}`;
}
