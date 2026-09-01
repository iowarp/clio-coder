import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { EvalArtifactV4 } from "../schema/artifact.js";
import type { EvalMetricAssertion, EvalSuiteThresholdsV2 } from "../schema/suite.js";

export function loadThresholds(path: string): EvalSuiteThresholdsV2 {
	const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
	const root = isRecord(parsed) && isRecord(parsed.thresholds) ? parsed.thresholds : parsed;
	if (isRecord(root) && (Array.isArray(root.fail) || Array.isArray(root.informational))) {
		return {
			fail: parseAssertions(root.fail, `${path}.fail`),
			informational: parseAssertions(root.informational, `${path}.informational`),
		};
	}
	throw new Error(`invalid thresholds file: ${path}`);
}

function parseAssertions(value: unknown, source: string): EvalMetricAssertion[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${source}: expected array`);
	return value.map((entry, index) => {
		if (!isRecord(entry)) throw new Error(`${source}[${index}]: expected object`);
		if (typeof entry.metric !== "string" || entry.metric.length === 0) {
			throw new Error(`${source}[${index}].metric: expected non-empty string`);
		}
		if (!isOp(entry.op)) throw new Error(`${source}[${index}].op: expected lt, lte, gt, gte, eq, or neq`);
		if (!isScalar(entry.value)) throw new Error(`${source}[${index}].value: expected scalar`);
		return { metric: entry.metric, op: entry.op, value: entry.value };
	});
}

function isOp(value: unknown): value is EvalMetricAssertion["op"] {
	return value === "lt" || value === "lte" || value === "gt" || value === "gte" || value === "eq" || value === "neq";
}

function isScalar(value: unknown): value is number | string | boolean {
	return (
		(typeof value === "number" && Number.isFinite(value)) || typeof value === "string" || typeof value === "boolean"
	);
}

export interface EvalAssertionResolution {
	actual: number | string | boolean | null;
	/** True when neither the metric map nor the artifact carries a value for this metric. */
	unresolved: boolean;
	/** True when the comparison holds against the resolved value. */
	holds: boolean;
}

/**
 * Resolve one assertion against a metric map, keeping "the metric was missing"
 * distinct from "the comparison did not hold". Both readings fail closed, but
 * they fail for different reasons and a report that conflates them tells an
 * operator nothing about whether the check ran.
 */
export function resolveMetricAssertion(
	assertion: EvalMetricAssertion,
	metrics: Readonly<Record<string, unknown>>,
	artifact?: EvalArtifactV4,
): EvalAssertionResolution {
	const actual = metricValue(assertion.metric, metrics, artifact);
	return { actual, unresolved: actual === null, holds: comparisonHolds(assertion, actual) };
}

function comparisonHolds(assertion: EvalMetricAssertion, actual: number | string | boolean | null): boolean {
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
	artifact?: EvalArtifactV4,
): number | string | boolean | null {
	if (metric in metrics) return metrics[metric] as number | string | boolean | null;
	if (artifact !== undefined) {
		if (metric === "result.pass") return artifact.summary.failed === 0;
		if (metric === "latency.wallMs") return artifact.summary.wallTimeMs;
		// An unmeasured artifact answers null rather than 0, so a numeric
		// threshold on token spend fails closed instead of passing on absence.
		if (metric === "tokens.total") return artifact.summary.tokens.measured ? artifact.summary.tokens.total : null;
		if (metric.startsWith("summary.")) return summaryValue(artifact, metric.slice("summary.".length));
	}
	return null;
}

/** Resolve a dotted path under artifact.summary to a scalar, else null. */
function summaryValue(artifact: EvalArtifactV4, path: string): number | string | boolean | null {
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
