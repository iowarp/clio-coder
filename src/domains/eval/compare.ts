import type { EvalFailureClass, EvalRunArtifact, EvalRunRecord, EvalSummary } from "./types.js";

export const EVAL_COMPARE_MATCHING_RULE = "taskId+repeatIndex";

export interface EvalCompareTotals {
	passed: number;
	failed: number;
	passRate: number;
	tokens: number;
	costUsd: number;
	wallTimeMs: number;
}

export interface EvalCompareDeltas {
	passRate: number;
	tokens: number;
	costUsd: number;
	wallTimeMs: number;
}

export interface EvalCompareResultRef {
	taskId: string;
	repeatIndex: number;
	runId: string;
	pass: boolean;
	failureClass: EvalFailureClass | null;
}

export interface EvalCompareMatchedChange {
	taskId: string;
	repeatIndex: number;
	baselineRunId: string;
	candidateRunId: string;
	baselineFailureClass: EvalFailureClass | null;
	candidateFailureClass: EvalFailureClass | null;
}

export interface EvalComparisonSummary {
	version: 1;
	baselineEvalId: string;
	candidateEvalId: string;
	matchingRule: typeof EVAL_COMPARE_MATCHING_RULE;
	matchedCount: number;
	addedCount: number;
	missingCount: number;
	baseline: EvalCompareTotals;
	candidate: EvalCompareTotals;
	deltas: EvalCompareDeltas;
	regressions: EvalCompareMatchedChange[];
	improvements: EvalCompareMatchedChange[];
	unchangedPassCount: number;
	unchangedFailCount: number;
	failureClassChanges: EvalCompareMatchedChange[];
	added: EvalCompareResultRef[];
	missing: EvalCompareResultRef[];
}

export function compareEvalArtifacts(baseline: EvalRunArtifact, candidate: EvalRunArtifact): EvalComparisonSummary {
	const baselineIndex = indexRecords(baseline.results, "baseline", baseline.evalId);
	const candidateIndex = indexRecords(candidate.results, "candidate", candidate.evalId);
	const regressions: EvalCompareMatchedChange[] = [];
	const improvements: EvalCompareMatchedChange[] = [];
	const failureClassChanges: EvalCompareMatchedChange[] = [];
	const missing: EvalCompareResultRef[] = [];
	let matchedCount = 0;
	let unchangedPassCount = 0;
	let unchangedFailCount = 0;

	for (const baselineRecord of sortedRecords(baselineIndex)) {
		const candidateRecord = candidateIndex.get(resultKey(baselineRecord));
		if (candidateRecord === undefined) {
			missing.push(resultRef(baselineRecord));
			continue;
		}
		matchedCount += 1;
		const change = matchedChange(baselineRecord, candidateRecord);
		if (baselineRecord.pass && !candidateRecord.pass) {
			regressions.push(change);
			continue;
		}
		if (!baselineRecord.pass && candidateRecord.pass) {
			improvements.push(change);
			continue;
		}
		if (baselineRecord.pass && candidateRecord.pass) {
			unchangedPassCount += 1;
			continue;
		}
		unchangedFailCount += 1;
		if ((baselineRecord.failureClass ?? null) !== (candidateRecord.failureClass ?? null)) {
			failureClassChanges.push(change);
		}
	}

	const added = sortedRecords(candidateIndex)
		.filter((candidateRecord) => !baselineIndex.has(resultKey(candidateRecord)))
		.map(resultRef);
	const baselineTotals = summaryTotals(baseline.summary);
	const candidateTotals = summaryTotals(candidate.summary);

	return {
		version: 1,
		baselineEvalId: baseline.evalId,
		candidateEvalId: candidate.evalId,
		matchingRule: EVAL_COMPARE_MATCHING_RULE,
		matchedCount,
		addedCount: added.length,
		missingCount: missing.length,
		baseline: baselineTotals,
		candidate: candidateTotals,
		deltas: {
			passRate: candidateTotals.passRate - baselineTotals.passRate,
			tokens: candidateTotals.tokens - baselineTotals.tokens,
			costUsd: candidateTotals.costUsd - baselineTotals.costUsd,
			wallTimeMs: candidateTotals.wallTimeMs - baselineTotals.wallTimeMs,
		},
		regressions,
		improvements,
		unchangedPassCount,
		unchangedFailCount,
		failureClassChanges,
		added,
		missing,
	};
}

export function renderEvalComparison(summary: EvalComparisonSummary): string {
	const lines = [
		`baseline eval: ${summary.baselineEvalId}`,
		`candidate eval: ${summary.candidateEvalId}`,
		`matching: ${summary.matchingRule}`,
		`matched: ${summary.matchedCount}`,
		`added: ${summary.addedCount}`,
		`missing: ${summary.missingCount}`,
		`baseline passed: ${summary.baseline.passed}`,
		`baseline failed: ${summary.baseline.failed}`,
		`candidate passed: ${summary.candidate.passed}`,
		`candidate failed: ${summary.candidate.failed}`,
		`pass-rate delta: ${formatSignedPercent(summary.deltas.passRate)}`,
		`token delta: ${formatSignedInteger(summary.deltas.tokens)}`,
		`cost delta USD: ${formatSignedCost(summary.deltas.costUsd)}`,
		`wall-time delta ms: ${formatSignedInteger(summary.deltas.wallTimeMs)}`,
		`regressions: ${summary.regressions.length}`,
		...formatMatchedChanges(summary.regressions),
		`fixes/improvements: ${summary.improvements.length}`,
		...formatMatchedChanges(summary.improvements),
		`unchanged pass: ${summary.unchangedPassCount}`,
		`unchanged fail: ${summary.unchangedFailCount}`,
		`failure class changes: ${summary.failureClassChanges.length}`,
		...formatMatchedChanges(summary.failureClassChanges),
		`added results: ${summary.added.length}`,
		...formatResultRefs(summary.added),
		`missing results: ${summary.missing.length}`,
		...formatResultRefs(summary.missing),
	];
	return `${lines.join("\n")}\n`;
}

function summaryTotals(summary: EvalSummary): EvalCompareTotals {
	return {
		passed: summary.passed,
		failed: summary.failed,
		passRate: summary.passRate,
		tokens: summary.tokens,
		costUsd: summary.costUsd,
		wallTimeMs: summary.wallTimeMs,
	};
}

function indexRecords(
	records: ReadonlyArray<EvalRunRecord>,
	label: "baseline" | "candidate",
	evalId: string,
): Map<string, EvalRunRecord> {
	const index = new Map<string, EvalRunRecord>();
	for (const record of records) {
		const key = resultKey(record);
		if (index.has(key)) {
			throw new Error(
				`${label} eval ${evalId} has duplicate result identity: ${formatIdentity(record.taskId, record.repeatIndex)}`,
			);
		}
		index.set(key, record);
	}
	return index;
}

function sortedRecords(index: ReadonlyMap<string, EvalRunRecord>): EvalRunRecord[] {
	return [...index.values()].sort(compareRecords);
}

function compareRecords(a: EvalRunRecord, b: EvalRunRecord): number {
	const byTask = a.taskId.localeCompare(b.taskId);
	if (byTask !== 0) return byTask;
	return a.repeatIndex - b.repeatIndex;
}

function matchedChange(baselineRecord: EvalRunRecord, candidateRecord: EvalRunRecord): EvalCompareMatchedChange {
	return {
		taskId: baselineRecord.taskId,
		repeatIndex: baselineRecord.repeatIndex,
		baselineRunId: baselineRecord.runId,
		candidateRunId: candidateRecord.runId,
		baselineFailureClass: baselineRecord.failureClass ?? null,
		candidateFailureClass: candidateRecord.failureClass ?? null,
	};
}

function resultRef(record: EvalRunRecord): EvalCompareResultRef {
	return {
		taskId: record.taskId,
		repeatIndex: record.repeatIndex,
		runId: record.runId,
		pass: record.pass,
		failureClass: record.failureClass ?? null,
	};
}

function resultKey(record: EvalRunRecord): string {
	return `${record.taskId}\u0000${record.repeatIndex}`;
}

function formatMatchedChanges(changes: ReadonlyArray<EvalCompareMatchedChange>): string[] {
	return changes.map(
		(change) =>
			`  ${formatIdentity(change.taskId, change.repeatIndex)} baseline=${change.baselineRunId} candidate=${change.candidateRunId} failure=${formatFailureChange(change)}`,
	);
}

function formatResultRefs(results: ReadonlyArray<EvalCompareResultRef>): string[] {
	return results.map(
		(result) =>
			`  ${formatIdentity(result.taskId, result.repeatIndex)} run=${result.runId} pass=${String(result.pass)} failure=${formatFailureClass(result.failureClass)}`,
	);
}

function formatIdentity(taskId: string, repeatIndex: number): string {
	return `task=${taskId} repeat=${repeatIndex}`;
}

function formatFailureChange(change: EvalCompareMatchedChange): string {
	return `${formatFailureClass(change.baselineFailureClass)}->${formatFailureClass(change.candidateFailureClass)}`;
}

function formatFailureClass(failureClass: EvalFailureClass | null): string {
	return failureClass ?? "none";
}

function formatSignedPercent(value: number): string {
	return `${formatSignedNumber(value * 100, 2)}pp`;
}

function formatSignedCost(value: number): string {
	return formatSignedNumber(value, 6);
}

function formatSignedInteger(value: number): string {
	return value > 0 ? `+${value}` : String(value);
}

function formatSignedNumber(value: number, digits: number): string {
	const formatted = value.toFixed(digits);
	return value > 0 ? `+${formatted}` : formatted;
}
