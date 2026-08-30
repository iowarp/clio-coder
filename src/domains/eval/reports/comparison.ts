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
			`| ${cell(row.scenarioId)} | ${cell(row.role)} | ${cell(`${row.target.id}/${row.target.model ?? "none"}`)} | ${row.family} | ${row.metric} | ${format(row.baseline.mean)} | ${format(row.baseline.variance)} | ${row.baseline.measured}/${row.baseline.observations} | ${format(row.candidate.mean)} | ${format(row.candidate.variance)} | ${row.candidate.measured}/${row.candidate.observations} | ${row.change} | ${row.varianceChange} | ${row.hardGate ? "hard" : "informational"} |`,
	);
	return [
		`# Eval comparison ${summary.baselineEvalId} → ${summary.candidateEvalId}`,
		"",
		`Behavioral hard gate: **${summary.hardGate.pass ? "pass" : "fail"}**`,
		...summary.hardGate.failures.map(
			(failure) =>
				`- Hard failure: ${failure.scenarioId} / ${failure.role} / ${failure.target.id}/${failure.target.model ?? "none"} / ${failure.metric}: ${failure.change}`,
		),
		`Pass-rate delta: ${(summary.passRateDelta * 100).toFixed(2)}%`,
		`Token delta: ${summary.tokenDelta === null ? "unmeasured" : summary.tokenDelta}`,
		`Wall-time delta ms: ${summary.wallTimeDelta}`,
		"",
		"| Scenario | Role | Target/model | Family | Metric | Baseline mean | Baseline variance | Baseline measured | Candidate mean | Candidate variance | Candidate measured | Change | Variance | Gate |",
		"|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|",
		...rows,
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
	return [
		`<testsuite name="eval-comparison" tests="${cases.length}" failures="${summary.hardGate.failures.length}">`,
		...cases,
		"</testsuite>",
		"",
	].join("\n");
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
