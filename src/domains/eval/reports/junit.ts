import type { EvalArtifactV4 } from "../schema/artifact.js";

export function renderEvalJunitReportV4(artifact: EvalArtifactV4): string {
	let failures = 0;
	let skipped = 0;
	const cases = artifact.results
		.map((result) => {
			const name = escapeXml(
				`${result.taskId}[${result.target.id}:${result.target.model ?? "default"}:${result.repeatIndex}]`,
			);
			if (!result.pass) {
				failures += 1;
				return `  <testcase name="${name}"><failure message="${escapeXml(result.failureClass ?? "failed")}" /></testcase>`;
			}
			const outcome = result.behavioral?.outcome;
			if (outcome === "behavioral_failure" || outcome === "infrastructure_failure") {
				failures += 1;
				return `  <testcase name="${name}"><failure message="${escapeXml(outcome)}" /></testcase>`;
			}
			if (outcome === "unknown" || outcome === "unmeasured") {
				skipped += 1;
				return `  <testcase name="${name}"><skipped message="behavioral ${escapeXml(outcome)}" /></testcase>`;
			}
			return `  <testcase name="${name}" />`;
		})
		.join("\n");
	return [
		`<testsuite name="${escapeXml(artifact.suite.id)}" tests="${artifact.summary.runs}" failures="${failures}" skipped="${skipped}">`,
		cases,
		"</testsuite>",
		"",
	].join("\n");
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
