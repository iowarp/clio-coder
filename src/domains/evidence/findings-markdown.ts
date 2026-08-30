import { formatTrustAxes, formatTrustSummary, trustVerdict } from "./trust-projection.js";
import type { EvidenceFinding, EvidenceTrustStatusFile } from "./types.js";

/** Render the canonical verdict before the diagnostic records in every evidence bundle. */
export function renderEvidenceFindingsMarkdown(
	findings: ReadonlyArray<EvidenceFinding>,
	trustStatus: EvidenceTrustStatusFile,
): string {
	const lines = ["# Findings", "", "## Canonical trust", ""];
	if (trustStatus.runs.length === 0) {
		lines.push("No linked run trust status.");
	} else {
		for (const run of trustStatus.runs) {
			lines.push(
				`- run=${run.runId}`,
				`  tier: ${trustVerdict(run.status)}`,
				`  summary: ${formatTrustSummary(run.status)}`,
				`  axes: ${formatTrustAxes(run.status)}`,
			);
		}
	}
	lines.push("", "## Finding records", "");
	if (findings.length === 0) {
		lines.push("No findings.");
	} else {
		for (const item of findings) {
			const run = item.runId === null ? "" : ` run=${item.runId}`;
			lines.push(`- ${item.id} [${item.severity}] ${item.tag}${run}: ${item.message}`);
		}
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}
