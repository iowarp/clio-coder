import { type EvalTokenMetricsV2, ZERO_TOKEN_METRICS_V2 } from "../schema/artifact-v2.js";

export function tokenMetricsFrom(metrics: Readonly<Record<string, unknown>>): EvalTokenMetricsV2 {
	return {
		input: numberMetric(metrics, "tokens.input"),
		output: numberMetric(metrics, "tokens.output"),
		total: numberMetric(metrics, "tokens.total"),
		cacheRead: numberMetric(metrics, "tokens.cacheRead"),
		cacheWrite: numberMetric(metrics, "tokens.cacheWrite"),
	};
}

export function addTokenMetrics(left: EvalTokenMetricsV2, right: EvalTokenMetricsV2): EvalTokenMetricsV2 {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		total: left.total + right.total,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
	};
}

export function zeroTokenMetrics(): EvalTokenMetricsV2 {
	return { ...ZERO_TOKEN_METRICS_V2 };
}

function numberMetric(metrics: Readonly<Record<string, unknown>>, key: string): number {
	const value = metrics[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
