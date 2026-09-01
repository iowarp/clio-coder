import type { EvalArtifactResultV4 } from "./artifact.js";
import type { EvalBehaviorCategoryV1, EvalBehaviorLabelV1 } from "./behavioral.js";

export const EVAL_BEHAVIOR_METRICS_SCHEMA_V1 = "clio.eval.behavior.metrics.v1" as const;

export const EVAL_BEHAVIOR_METRIC_DEFINITIONS_V1 = [
	{
		name: "correctness.taskSolved",
		family: "correctness",
		direction: "higher" as const,
		hardGate: true,
		source: "grader" as const,
	},
	{
		name: "safety.violations",
		family: "safety",
		direction: "lower" as const,
		hardGate: true,
		source: "behavioral-label" as const,
	},
	{
		name: "behavior.labelViolations",
		family: "behavior",
		direction: "lower" as const,
		hardGate: false,
		source: "behavioral-label" as const,
	},
	{
		name: "efficiency.toolCalls",
		family: "efficiency",
		direction: "lower" as const,
		hardGate: false,
		source: "tool-event" as const,
	},
	{
		name: "exploration.unnecessaryReads",
		family: "exploration",
		direction: "lower" as const,
		hardGate: false,
		source: "tool-event" as const,
	},
	{
		name: "delegation.quality",
		family: "delegation",
		direction: "higher" as const,
		hardGate: false,
		source: "behavioral-label" as const,
	},
	{
		name: "claims.unsupported",
		family: "claims",
		direction: "lower" as const,
		hardGate: false,
		source: "grader" as const,
	},
	{
		name: "tokens.total",
		family: "tokens",
		direction: "lower" as const,
		hardGate: false,
		source: "runner" as const,
	},
	{
		name: "latency.wallMs",
		family: "latency",
		direction: "lower" as const,
		hardGate: false,
		source: "runner" as const,
	},
	{
		name: "cost.usd",
		family: "cost",
		direction: "lower" as const,
		hardGate: false,
		source: "receipt" as const,
	},
] as const;

export type EvalBehaviorMetricDefinitionV1 = (typeof EVAL_BEHAVIOR_METRIC_DEFINITIONS_V1)[number];
export type EvalBehaviorMetricNameV1 = EvalBehaviorMetricDefinitionV1["name"];
export type EvalBehaviorMetricFamilyV1 = EvalBehaviorMetricDefinitionV1["family"];
export type EvalBehaviorMetricDirectionV1 = "higher" | "lower";
export type EvalBehaviorMetricSourceV1 = "grader" | "behavioral-label" | "tool-event" | "runner" | "receipt";

export interface EvalBehaviorMetricObservationV1 {
	value: number | null;
	source: EvalBehaviorMetricSourceV1;
}

export interface EvalBehaviorMetricsV1 {
	schema: typeof EVAL_BEHAVIOR_METRICS_SCHEMA_V1;
	scenarioId: string;
	role: string;
	target: { id: string; model: string | null };
	metrics: Record<EvalBehaviorMetricNameV1, EvalBehaviorMetricObservationV1>;
}

export function buildEvalBehaviorMetricsV1(
	result: Pick<EvalArtifactResultV4, "taskId" | "target" | "metrics" | "behavioral">,
	role: string,
): EvalBehaviorMetricsV1 {
	const label = (category: EvalBehaviorCategoryV1): EvalBehaviorLabelV1 | null =>
		result.behavioral?.labels.find((entry) => entry.category === category)?.label ?? null;
	const observedLabels = result.behavioral?.labels.filter(
		(entry) => entry.label === "satisfied" || entry.label === "violated",
	);
	const values: Record<EvalBehaviorMetricNameV1, number | null> = {
		"correctness.taskSolved": booleanMetric(result.metrics["task.solved"]),
		"safety.violations": violationMetric(label("safety_comprehension")),
		"behavior.labelViolations":
			observedLabels === undefined || observedLabels.length !== result.behavioral?.labels.length
				? null
				: observedLabels.filter((entry) => entry.label === "violated").length,
		"efficiency.toolCalls": numberMetric(result.metrics["tools.totalCalls"]),
		"exploration.unnecessaryReads": numberMetric(result.metrics["tools.read.outsideAllowed"]),
		"delegation.quality": qualityMetric(label("delegation")),
		"claims.unsupported": numberMetric(result.metrics["claims.unsupported"]),
		"tokens.total": numberMetric(result.metrics["tokens.total"]),
		"latency.wallMs": numberMetric(result.metrics["latency.wallMs"]),
		"cost.usd": numberMetric(result.metrics["cost.usd"]),
	};
	const metrics = Object.fromEntries(
		EVAL_BEHAVIOR_METRIC_DEFINITIONS_V1.map((definition) => [
			definition.name,
			{ value: values[definition.name], source: definition.source },
		]),
	) as Record<EvalBehaviorMetricNameV1, EvalBehaviorMetricObservationV1>;
	return {
		schema: EVAL_BEHAVIOR_METRICS_SCHEMA_V1,
		scenarioId: result.taskId,
		role,
		target: { id: result.target.id, model: result.target.model },
		metrics,
	};
}

export function parseEvalBehaviorMetricsV1(value: unknown, source = "behavioral metrics"): EvalBehaviorMetricsV1 {
	const record = asRecord(value, source);
	if (record.schema !== EVAL_BEHAVIOR_METRICS_SCHEMA_V1) {
		throw new Error(`${source}.schema: expected ${EVAL_BEHAVIOR_METRICS_SCHEMA_V1}`);
	}
	const target = asRecord(record.target, `${source}.target`);
	const rawMetrics = asRecord(record.metrics, `${source}.metrics`);
	const expectedMetricNames = new Set(EVAL_BEHAVIOR_METRIC_DEFINITIONS_V1.map((definition) => definition.name));
	for (const metricName of Object.keys(rawMetrics)) {
		if (!expectedMetricNames.has(metricName as EvalBehaviorMetricNameV1)) {
			throw new Error(`${source}.metrics.${metricName}: unknown behavioral metric`);
		}
	}
	const metrics = Object.fromEntries(
		EVAL_BEHAVIOR_METRIC_DEFINITIONS_V1.map((definition) => {
			const observation = asRecord(rawMetrics[definition.name], `${source}.metrics.${definition.name}`);
			const metricSource = observation.source;
			if (metricSource !== definition.source) {
				throw new Error(`${source}.metrics.${definition.name}.source: expected ${definition.source}`);
			}
			const metricValue = observation.value;
			if (metricValue !== null && (typeof metricValue !== "number" || !Number.isFinite(metricValue))) {
				throw new Error(`${source}.metrics.${definition.name}.value: expected finite number or null`);
			}
			return [definition.name, { value: metricValue, source: metricSource }];
		}),
	) as Record<EvalBehaviorMetricNameV1, EvalBehaviorMetricObservationV1>;
	return {
		schema: EVAL_BEHAVIOR_METRICS_SCHEMA_V1,
		scenarioId: readString(record.scenarioId, `${source}.scenarioId`),
		role: readString(record.role, `${source}.role`),
		target: {
			id: readString(target.id, `${source}.target.id`),
			model: target.model === null ? null : readString(target.model, `${source}.target.model`),
		},
		metrics,
	};
}

function numberMetric(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanMetric(value: unknown): number | null {
	return typeof value === "boolean" ? (value ? 1 : 0) : null;
}

function violationMetric(label: EvalBehaviorLabelV1 | null): number | null {
	if (label === "violated") return 1;
	if (label === "satisfied") return 0;
	return null;
}

function qualityMetric(label: EvalBehaviorLabelV1 | null): number | null {
	if (label === "satisfied") return 1;
	if (label === "violated") return 0;
	return null;
}

function asRecord(value: unknown, source: string): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	throw new Error(`${source}: expected object`);
}

function readString(value: unknown, source: string): string {
	if (typeof value === "string" && value.length > 0) return value;
	throw new Error(`${source}: expected non-empty string`);
}
