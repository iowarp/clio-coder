import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { EvalArtifactV2 } from "../schema/artifact.js";
import type { EvalMetricAssertion, EvalSuiteThresholdsV2 } from "../schema/suite.js";

export function loadThresholds(path: string): EvalSuiteThresholdsV2 {
	const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
	if (isRecord(parsed) && Array.isArray(parsed.fail)) return { fail: parsed.fail as EvalMetricAssertion[] };
	if (isRecord(parsed) && isRecord(parsed.thresholds) && Array.isArray(parsed.thresholds.fail)) {
		return { fail: parsed.thresholds.fail as EvalMetricAssertion[] };
	}
	throw new Error(`invalid thresholds file: ${path}`);
}

export function evaluateMetricAssertion(
	assertion: EvalMetricAssertion,
	metrics: Readonly<Record<string, unknown>>,
	artifact?: EvalArtifactV2,
): boolean {
	const actual = metricValue(assertion.metric, metrics, artifact);
	switch (assertion.op) {
		case "lt":
			return typeof actual === "number" && typeof assertion.value === "number" && actual < assertion.value;
		case "lte":
			return typeof actual === "number" && typeof assertion.value === "number" && actual <= assertion.value;
		case "gt":
			return typeof actual === "number" && typeof assertion.value === "number" && actual > assertion.value;
		case "gte":
			return typeof actual === "number" && typeof assertion.value === "number" && actual >= assertion.value;
		case "eq":
			return actual === assertion.value;
		case "neq":
			return actual !== assertion.value;
	}
}

export function metricValue(
	metric: string,
	metrics: Readonly<Record<string, unknown>>,
	artifact?: EvalArtifactV2,
): number | string | boolean | null {
	if (metric in metrics) return metrics[metric] as number | string | boolean | null;
	if (artifact !== undefined) {
		if (metric === "result.pass") return artifact.summary.failed === 0;
		if (metric === "latency.wallMs") return artifact.summary.wallTimeMs;
		if (metric === "tokens.total") return artifact.summary.tokens.total;
		if (metric.startsWith("summary.")) return summaryValue(artifact, metric.slice("summary.".length));
	}
	return null;
}

/** Resolve a dotted path under artifact.summary to a scalar, else null. */
function summaryValue(artifact: EvalArtifactV2, path: string): number | string | boolean | null {
	let current: unknown = artifact.summary;
	for (const segment of path.split(".")) {
		if (!isRecord(current) || !(segment in current)) return null;
		current = current[segment];
	}
	return typeof current === "number" || typeof current === "string" || typeof current === "boolean" ? current : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
