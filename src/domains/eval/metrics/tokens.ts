import { type EvalTokenMetricsV3, ZERO_TOKEN_METRICS_V3 } from "../schema/artifact.js";

export function tokenMetricsFrom(metrics: Readonly<Record<string, unknown>>): EvalTokenMetricsV3 {
	return {
		input: numberMetric(metrics, "tokens.input"),
		output: numberMetric(metrics, "tokens.output"),
		total: numberMetric(metrics, "tokens.total"),
		cacheRead: numberMetric(metrics, "tokens.cacheRead"),
		cacheWrite: numberMetric(metrics, "tokens.cacheWrite"),
	};
}

export function addTokenMetrics(left: EvalTokenMetricsV3, right: EvalTokenMetricsV3): EvalTokenMetricsV3 {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		total: left.total + right.total,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
	};
}

export function zeroTokenMetrics(): EvalTokenMetricsV3 {
	return { ...ZERO_TOKEN_METRICS_V3 };
}

function numberMetric(metrics: Readonly<Record<string, unknown>>, key: string): number {
	const value = metrics[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
