import type { EvalArtifactV2 } from "../schema/artifact.js";

export function renderEvalJunitReportV2(artifact: EvalArtifactV2): string {
	const cases = artifact.results
		.map((result) => {
			const name = escapeXml(`${result.taskId}[${result.repeatIndex}]`);
			if (result.pass) return `  <testcase name="${name}" />`;
			return `  <testcase name="${name}"><failure message="${escapeXml(result.failureClass ?? "failed")}" /></testcase>`;
		})
		.join("\n");
	return [
		`<testsuite name="${escapeXml(artifact.suite.id)}" tests="${artifact.summary.runs}" failures="${artifact.summary.failed}">`,
		cases,
		"</testsuite>",
		"",
	].join("\n");
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
