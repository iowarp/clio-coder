export const EVAL_VERDICT_SCHEMA_V1 = "clio.eval.verdict.v1" as const;

export const EVAL_TRACKED_METRIC_NAMES = [
	"modelCalls",
	"uncachedPrefillTokens",
	"cacheReadTokens",
	"generatedTokens",
	"reasoningTokens",
	"toolCalls",
	"toolErrors",
	"ttftMsFirstCall",
	"wallClockMs",
	"contextTokensAtEnd",
	"compactions",
] as const;

export type EvalTrackedMetricName = (typeof EVAL_TRACKED_METRIC_NAMES)[number];
export type EvalMetricSource = "ledger" | "receipt" | "estimated";
export type EvalVerdictOutcome = "pass" | "fail" | "unmeasured";
export type EvalVerdictMachinery = "ok" | "infrastructure_failure";

export interface EvalSourcedNumber {
	value: number;
	source: EvalMetricSource;
}

export interface EvalSourcedNullableNumber {
	value: number | null;
	source: EvalMetricSource;
}

export interface EvalTrackedMetricsV1 {
	modelCalls: EvalSourcedNumber;
	uncachedPrefillTokens: EvalSourcedNumber;
	cacheReadTokens: EvalSourcedNumber;
	generatedTokens: EvalSourcedNumber;
	reasoningTokens: EvalSourcedNullableNumber;
	toolCalls: EvalSourcedNumber;
	toolErrors: EvalSourcedNumber;
	ttftMsFirstCall: EvalSourcedNumber;
	wallClockMs: EvalSourcedNumber;
	contextTokensAtEnd: EvalSourcedNumber;
	compactions: EvalSourcedNumber;
	expectedColdReasons: Record<string, EvalSourcedNumber>;
}

export interface EvalVerdictEvidenceV1 {
	assignmentId: string | null;
	terminalReceiptDigest: string | null;
	graderExitCode: number | null;
}

export interface EvalVerdictEnvelopeV1 {
	schema: typeof EVAL_VERDICT_SCHEMA_V1;
	scenarioId: string;
	trialIndex: number;
	outcome: EvalVerdictOutcome;
	machinery: EvalVerdictMachinery;
	trackedMetrics: EvalTrackedMetricsV1;
	behavioral: null;
	evidence: EvalVerdictEvidenceV1;
}

export type EvalVerdictParseResult = { ok: true; verdict: EvalVerdictEnvelopeV1 } | { ok: false; error: string };

/** Parse the v1 verdict and reject contradictions that could publish a false pass. */
export function parseEvalVerdictEnvelopeV1(value: unknown, source = "verdict"): EvalVerdictEnvelopeV1 {
	const record = asRecord(value, source);
	if (record.schema !== EVAL_VERDICT_SCHEMA_V1) {
		throw new Error(`${source}.schema: expected ${EVAL_VERDICT_SCHEMA_V1}`);
	}
	const scenarioId = readNonEmptyString(record, source, "scenarioId");
	const trialIndex = readNonNegativeInteger(record, source, "trialIndex");
	const outcome = readOutcome(record.outcome, `${source}.outcome`);
	const machinery = readMachinery(record.machinery, `${source}.machinery`);
	if (machinery === "infrastructure_failure" && outcome === "pass") {
		throw new Error(`${source}: infrastructure_failure cannot carry a pass outcome`);
	}
	if (record.behavioral !== null) throw new Error(`${source}.behavioral: expected null in verdict v1`);
	return {
		schema: EVAL_VERDICT_SCHEMA_V1,
		scenarioId,
		trialIndex,
		outcome,
		machinery,
		trackedMetrics: parseTrackedMetrics(record.trackedMetrics, `${source}.trackedMetrics`),
		behavioral: null,
		evidence: parseEvidence(record.evidence, `${source}.evidence`),
	};
}

export function safeParseEvalVerdictEnvelopeV1(value: unknown, source = "verdict"): EvalVerdictParseResult {
	try {
		return { ok: true, verdict: parseEvalVerdictEnvelopeV1(value, source) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function parseTrackedMetrics(value: unknown, source: string): EvalTrackedMetricsV1 {
	const record = asRecord(value, source);
	const expectedColdReasons = asRecord(record.expectedColdReasons, `${source}.expectedColdReasons`);
	return {
		modelCalls: readSourcedNumber(record.modelCalls, `${source}.modelCalls`),
		uncachedPrefillTokens: readSourcedNumber(record.uncachedPrefillTokens, `${source}.uncachedPrefillTokens`),
		cacheReadTokens: readSourcedNumber(record.cacheReadTokens, `${source}.cacheReadTokens`),
		generatedTokens: readSourcedNumber(record.generatedTokens, `${source}.generatedTokens`),
		reasoningTokens: readSourcedNullableNumber(record.reasoningTokens, `${source}.reasoningTokens`),
		toolCalls: readSourcedNumber(record.toolCalls, `${source}.toolCalls`),
		toolErrors: readSourcedNumber(record.toolErrors, `${source}.toolErrors`),
		ttftMsFirstCall: readSourcedNumber(record.ttftMsFirstCall, `${source}.ttftMsFirstCall`),
		wallClockMs: readSourcedNumber(record.wallClockMs, `${source}.wallClockMs`),
		contextTokensAtEnd: readSourcedNumber(record.contextTokensAtEnd, `${source}.contextTokensAtEnd`),
		compactions: readSourcedNumber(record.compactions, `${source}.compactions`),
		expectedColdReasons: Object.fromEntries(
			Object.entries(expectedColdReasons).map(([reason, metric]) => {
				if (reason.trim().length === 0) throw new Error(`${source}.expectedColdReasons: expected non-empty reason`);
				return [reason, readSourcedNumber(metric, `${source}.expectedColdReasons.${reason}`)];
			}),
		),
	};
}

function parseEvidence(value: unknown, source: string): EvalVerdictEvidenceV1 {
	const record = asRecord(value, source);
	const terminalReceiptDigest = readNullableString(record, source, "terminalReceiptDigest");
	if (terminalReceiptDigest !== null && !/^[a-f0-9]{64}$/u.test(terminalReceiptDigest)) {
		throw new Error(`${source}.terminalReceiptDigest: expected sha256 digest or null`);
	}
	const graderExitCode = record.graderExitCode;
	if (graderExitCode !== null && (!Number.isInteger(graderExitCode) || !Number.isFinite(graderExitCode))) {
		throw new Error(`${source}.graderExitCode: expected integer or null`);
	}
	return {
		assignmentId: readNullableString(record, source, "assignmentId"),
		terminalReceiptDigest,
		graderExitCode: graderExitCode as number | null,
	};
}

function readSourcedNumber(value: unknown, source: string): EvalSourcedNumber {
	const record = asRecord(value, source);
	return {
		value: readNonNegativeNumber(record.value, `${source}.value`),
		source: readMetricSource(record.source, source),
	};
}

function readSourcedNullableNumber(value: unknown, source: string): EvalSourcedNullableNumber {
	const record = asRecord(value, source);
	return {
		value: record.value === null ? null : readNonNegativeNumber(record.value, `${source}.value`),
		source: readMetricSource(record.source, source),
	};
}

function readMetricSource(value: unknown, source: string): EvalMetricSource {
	if (value === "ledger" || value === "receipt" || value === "estimated") return value;
	throw new Error(`${source}.source: expected ledger, receipt, or estimated`);
}

function readOutcome(value: unknown, source: string): EvalVerdictOutcome {
	if (value === "pass" || value === "fail" || value === "unmeasured") return value;
	throw new Error(`${source}: expected pass, fail, or unmeasured`);
}

function readMachinery(value: unknown, source: string): EvalVerdictMachinery {
	if (value === "ok" || value === "infrastructure_failure") return value;
	throw new Error(`${source}: expected ok or infrastructure_failure`);
}

function readNonNegativeNumber(value: unknown, source: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${source}: expected non-negative number`);
	}
	return value;
}

function readNonNegativeInteger(record: Record<string, unknown>, source: string, field: string): number {
	const value = record[field];
	if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
		throw new Error(`${source}.${field}: expected non-negative integer`);
	}
	return value;
}

function readNonEmptyString(record: Record<string, unknown>, source: string, field: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${source}.${field}: expected string`);
	return value;
}

function readNullableString(record: Record<string, unknown>, source: string, field: string): string | null {
	const value = record[field];
	if (value === null) return null;
	if (typeof value !== "string" || value.length === 0) throw new Error(`${source}.${field}: expected string or null`);
	return value;
}

function asRecord(value: unknown, source: string): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	throw new Error(`${source}: expected object`);
}
