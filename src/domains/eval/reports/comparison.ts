import type { EvalCompareV4Summary } from "../compare/compare.js";
import { renderEvalComparisonV4 } from "../compare/compare.js";

export type EvalComparisonReportFormat = "text" | "json" | "md" | "junit";

export function renderEvalComparisonReportV1(
	summary: EvalCompareV4Summary,
	format: EvalComparisonReportFormat,
): string {
	if (format === "json") return `${JSON.stringify(summary, null, 2)}\n`;
	if (format === "md") return renderMarkdown(summary);
	if (format === "junit") return renderJunit(summary);
	return renderEvalComparisonV4(summary);
}

function renderMarkdown(summary: EvalCompareV4Summary): string {
	const rows = summary.behavioralMetrics.map(
		(row) =>
			`| ${cell(row.scenarioId)} | ${cell(row.role)} | ${cell(`${row.target.id}/${row.target.model ?? "none"}`)} | ${row.family} | ${row.metric} | ${format(row.baseline.mean)} | ${format(row.baseline.variance)} | ${row.baseline.measured}/${row.baseline.observations} | ${format(row.candidate.mean)} | ${format(row.candidate.variance)} | ${row.candidate.measured}/${row.candidate.observations} | ${row.change} | ${row.varianceChange} | ${row.comparability.comparable ? "comparable" : cell(row.comparability.mismatchedFields.join(", "))} | ${row.hardGate ? "hard" : "informational"} |`,
	);
	const scenarioRows = summary.scenarioReports.map(
		(report) => `| ${cell(report.id)} | ${changeCounts(report.metrics)} | ${changeCounts(report.variance)} |`,
	);
	const roleRows = summary.roleReports.map(
		(report) => `| ${cell(report.id)} | ${changeCounts(report.metrics)} | ${changeCounts(report.variance)} |`,
	);
	return [
		`# Eval comparison ${summary.baselineEvalId} → ${summary.candidateEvalId}`,
		"",
		`Behavioral hard gate: **${summary.hardGate.pass ? "pass" : "fail"}**`,
		...summary.hardGate.failures.map(
			(failure) =>
				`- Hard failure: ${failure.scenarioId} / ${failure.role} / ${failure.target.id}/${failure.target.model ?? "none"} / ${failure.metric}: ${failure.change}`,
		),
		...summary.envelopeMismatches.map(
			(mismatch) =>
				`- Incomparable envelope: ${mismatch.scenarioId} / ${mismatch.role} / ${mismatch.target.id}/${mismatch.target.model ?? "none"}: ${mismatch.fields.join(", ")}`,
		),
		...summary.affectedCorpusResults.map(
			(result) => `- Affected corpus result: ${result.scenarioId} / ${result.role}: ${result.changedFields.join(", ")}`,
		),
		`Pass-rate delta: ${(summary.passRateDelta * 100).toFixed(2)}%`,
		`Token delta: ${summary.tokenDelta === null ? "unmeasured" : summary.tokenDelta}`,
		`Wall-time delta ms: ${summary.wallTimeDelta}`,
		"",
		"| Scenario | Role | Target/model | Family | Metric | Baseline mean | Baseline variance | Baseline measured | Candidate mean | Candidate variance | Candidate measured | Change | Variance | Comparability | Gate |",
		"|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---|",
		...rows,
		"",
		"## Per-scenario baseline/candidate report",
		"",
		"| Scenario | Metric changes | Variance changes |",
		"|---|---|---|",
		...scenarioRows,
		"",
		"## Per-role baseline/candidate report",
		"",
		"| Role | Metric changes | Variance changes |",
		"|---|---|---|",
		...roleRows,
		"",
	].join("\n");
}

function renderJunit(summary: EvalCompareV4Summary): string {
	const failures = new Set(
		summary.hardGate.failures.map((failure) =>
			JSON.stringify([failure.scenarioId, failure.role, failure.target.id, failure.target.model, failure.metric]),
		),
	);
	const represented = new Set<string>();
	const cases = summary.behavioralMetrics.map((row) => {
		const name = `${row.scenarioId}[${row.role}:${row.target.id}:${row.target.model ?? "none"}].${row.metric}`;
		const key = JSON.stringify([row.scenarioId, row.role, row.target.id, row.target.model, row.metric]);
		represented.add(key);
		const detail = `change=${row.change} variance=${row.varianceChange} baseline=${format(row.baseline.mean)} candidate=${format(row.candidate.mean)}`;
		return failures.has(key)
			? `  <testcase classname="eval.behavior.${escapeXml(row.family)}" name="${escapeXml(name)}"><failure message="${escapeXml(row.change)}">${escapeXml(detail)}</failure></testcase>`
			: `  <testcase classname="eval.behavior.${escapeXml(row.family)}" name="${escapeXml(name)}"><system-out>${escapeXml(detail)}</system-out></testcase>`;
	});
	for (const failure of summary.hardGate.failures) {
		const key = JSON.stringify([
			failure.scenarioId,
			failure.role,
			failure.target.id,
			failure.target.model,
			failure.metric,
		]);
		if (represented.has(key)) continue;
		const name = `${failure.scenarioId}[${failure.role}:${failure.target.id}:${failure.target.model ?? "none"}].${failure.metric}`;
		cases.push(
			`  <testcase classname="eval.behavior.hard" name="${escapeXml(name)}"><failure message="${escapeXml(failure.change)}">hard behavioral gate</failure></testcase>`,
		);
	}
	for (const failure of summary.hardGate.envelopeFailures) {
		const name = `${failure.scenarioId}[${failure.role}:${failure.target.id}:${failure.target.model ?? "none"}].execution-envelope`;
		cases.push(
			`  <testcase classname="eval.behavior.envelope" name="${escapeXml(name)}"><failure message="incomparable">${escapeXml(failure.fields.join(", "))}</failure></testcase>`,
		);
	}
	return [
		`<testsuite name="eval-comparison" tests="${cases.length}" failures="${summary.hardGate.failures.length + summary.hardGate.envelopeFailures.length}">`,
		...cases,
		"</testsuite>",
		"",
	].join("\n");
}

function changeCounts(counts: {
	improved: number;
	regressed: number;
	unchanged: number;
	incomparable: number;
}): string {
	return `improved ${counts.improved}, regressed ${counts.regressed}, unchanged ${counts.unchanged}, incomparable ${counts.incomparable}`;
}

function format(value: number | null): string {
	return value === null ? "null" : Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function cell(value: string): string {
	return value.replaceAll("|", "\\|");
}

function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
