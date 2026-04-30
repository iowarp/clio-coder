import type { EvalRunArtifact, EvalSummary } from "./types.js";

export function renderEvalReport(artifact: EvalRunArtifact, artifactPath?: string): string {
	const lines = [
		`eval: ${artifact.evalId}`,
		`task file: ${artifact.taskFile}`,
		`repeat: ${artifact.repeat}`,
		...renderSummaryLines(artifact.summary),
	];
	if (artifactPath !== undefined) lines.splice(2, 0, `artifact: ${artifactPath}`);
	const evidenceIds = uniqueEvidenceIds(artifact);
	if (evidenceIds.length > 0) {
		const insertAt = artifactPath === undefined ? 2 : 3;
		lines.splice(insertAt, 0, `evidence: ${evidenceIds.join(", ")}`);
	}
	return `${lines.join("\n")}\n`;
}

export function renderSummaryLines(summary: EvalSummary): string[] {
	return [
		`runs: ${summary.runs}`,
		`passed: ${summary.passed}`,
		`failed: ${summary.failed}`,
		`pass rate: ${formatPercent(summary.passRate)}`,
		`tokens: ${summary.tokens}`,
		`cost USD: ${formatCost(summary.costUsd)}`,
		`wall time ms: ${summary.wallTimeMs}`,
		`failure classes: ${formatFailureClasses(summary)}`,
	];
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(2)}%`;
}

function formatCost(value: number): string {
	return value.toFixed(6);
}

function formatFailureClasses(summary: EvalSummary): string {
	if (summary.failureClasses.length === 0) return "none";
	return summary.failureClasses.map((entry) => `${entry.failureClass}=${entry.count}`).join(", ");
}

function uniqueEvidenceIds(artifact: EvalRunArtifact): string[] {
	return [
		...new Set(artifact.results.flatMap((result) => (result.evidenceId === undefined ? [] : [result.evidenceId]))),
	].sort((left, right) => left.localeCompare(right));
}
