import type { EvalArtifactResultV4, EvalTokenAccountingV4 } from "../schema/artifact.js";
import { type EvalTokenMetricsV4, ZERO_TOKEN_METRICS_V4 } from "../schema/artifact.js";
import { tokenMeasurementCoverage } from "./coverage.js";

/**
 * Aggregate an artifact's whole-run token accounting from its results. Only
 * runs that reported usage contribute, and an artifact where none did carries
 * no counts at all: the reader learns that the work was unobserved rather than
 * reading a zero as a free run.
 */
export function tokenAccountingFrom(
	results: ReadonlyArray<Pick<EvalArtifactResultV4, "metrics">>,
): EvalTokenAccountingV4 {
	const coverage = tokenMeasurementCoverage(results);
	if (coverage.measured === 0) return { measured: false, runs: coverage.total, measuredRuns: 0 };
	const totals = results.reduce(
		(total, result) =>
			result.metrics["tokens.measured"] === true ? addTokenMetrics(total, tokenMetricsFrom(result.metrics)) : total,
		zeroTokenMetrics(),
	);
	return { measured: true, runs: coverage.total, measuredRuns: coverage.measured, ...totals };
}

export function tokenMetricsFrom(metrics: Readonly<Record<string, unknown>>): EvalTokenMetricsV4 {
	return {
		input: numberMetric(metrics, "tokens.input"),
		output: numberMetric(metrics, "tokens.output"),
		total: numberMetric(metrics, "tokens.total"),
		cacheRead: numberMetric(metrics, "tokens.cacheRead"),
		cacheWrite: numberMetric(metrics, "tokens.cacheWrite"),
	};
}

export function addTokenMetrics(left: EvalTokenMetricsV4, right: EvalTokenMetricsV4): EvalTokenMetricsV4 {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		total: left.total + right.total,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
	};
}

export function zeroTokenMetrics(): EvalTokenMetricsV4 {
	return { ...ZERO_TOKEN_METRICS_V4 };
}

function numberMetric(metrics: Readonly<Record<string, unknown>>, key: string): number {
	const value = metrics[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
