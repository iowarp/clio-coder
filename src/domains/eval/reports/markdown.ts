import type { EvalArtifactV4 } from "../schema/artifact.js";

export function renderEvalMarkdownReportV4(artifact: EvalArtifactV4): string {
	const lines = [
		`# Eval ${artifact.evalId}`,
		"",
		`Suite: ${artifact.suite.id}`,
		`Target: ${artifact.matrix.target}`,
		`Pass rate: ${(artifact.summary.passRate * 100).toFixed(2)}%`,
		"",
		"| Task | Role | Target | Model | Repeat | Result | Behavioral | Failure |",
		"|---|---|---|---|---:|---|---|---|",
		...artifact.results.map(
			(result) =>
				`| ${result.taskId} | ${result.behavioralMetrics?.role ?? ""} | ${result.target.id} | ${result.target.model ?? ""} | ${result.repeatIndex} | ${result.pass ? "pass" : "fail"} | ${result.behavioral?.outcome ?? "unmeasured"} | ${result.failureClass ?? ""} |`,
		),
		"",
	];
	return `${lines.join("\n")}`;
}
