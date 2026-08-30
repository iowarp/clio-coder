import { createHash } from "node:crypto";
import type { EvalArtifactResultV4 } from "./artifact.js";
import {
	assertEvalBehaviorReferencesVerdictV1,
	type EvalBehaviorFactSourceV1,
	type EvalBehaviorJudgeFactV1,
	type EvalBehaviorScenarioV1,
	type EvalBehaviorVerdictV1,
	judgeEvalBehaviorV1,
} from "./behavioral.js";
import {
	EVAL_VERDICT_SCHEMA_V1,
	type EvalTrackedMetricsV1,
	type EvalVerdictEnvelopeV1,
	parseEvalVerdictEnvelopeV1,
} from "./verdict.js";

type AdaptableSuiteResult = Pick<
	EvalArtifactResultV4,
	"assignmentId" | "terminalReceiptDigest" | "taskId" | "repeatIndex" | "pass" | "failureClass" | "metrics"
>;

/** Adapt one Suite v2 matrix result into the versioned verdict carried by Artifact v4. */
export function adaptSuiteV2ResultToVerdictV1(
	result: AdaptableSuiteResult,
	trackedMetrics: EvalTrackedMetricsV1,
): EvalVerdictEnvelopeV1 {
	// The suite runner owns the one final pass decision. In particular, a
	// declared grader failure changes `pass` without pretending the runner or
	// its invariants broke; every other failed result is a machinery failure.
	const machinery = result.pass || result.failureClass === "grader_failed" ? "ok" : "infrastructure_failure";
	const outcome = result.pass ? "pass" : "fail";
	const graderExitCode = result.metrics["task.exitCode"];
	return parseEvalVerdictEnvelopeV1({
		schema: EVAL_VERDICT_SCHEMA_V1,
		scenarioId: result.taskId,
		trialIndex: result.repeatIndex,
		outcome,
		machinery,
		reason: result.pass ? null : (result.failureClass ?? "result_failed"),
		trackedMetrics,
		behavioral: null,
		evidence: {
			assignmentId: result.assignmentId,
			terminalReceiptDigest: result.terminalReceiptDigest,
			graderExitCode: typeof graderExitCode === "number" && Number.isInteger(graderExitCode) ? graderExitCode : null,
		},
	});
}

/** Adapt Suite v2 metrics into deterministic, bounded facts for a behavioral scenario. */
export function adaptSuiteV2ResultToBehaviorV1(
	result: AdaptableSuiteResult,
	verdict: EvalVerdictEnvelopeV1,
	scenario: EvalBehaviorScenarioV1,
): EvalBehaviorVerdictV1 {
	const facts = Object.entries(result.metrics).flatMap(([key, value]) => {
		if (value === null) return [];
		const source = metricFactSource(key);
		const serialized = JSON.stringify({ source, key, value });
		const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
		const fact: EvalBehaviorJudgeFactV1 = {
			id: `metric-${digest.slice(0, 16)}`,
			source,
			key,
			value,
			evidence: { locator: `artifact.metrics.${key}`, digest, excerpt: serialized.slice(0, 1_000) },
		};
		return [fact];
	});
	const presentSources = new Set(facts.map((fact) => fact.source));
	const allSources: EvalBehaviorFactSourceV1[] = ["transcript", "tool", "receipt", "grader"];
	const unavailableSources = allSources.filter(
		(source) => !presentSources.has(source) || (source === "tool" && scenario.execution.toolTarget === "none"),
	);
	const behavior = judgeEvalBehaviorV1(scenario, verdict, {
		facts,
		unavailableSources,
		infrastructureFailure: verdict.machinery === "infrastructure_failure",
	});
	assertEvalBehaviorReferencesVerdictV1(behavior, verdict);
	return behavior;
}

function metricFactSource(key: string): EvalBehaviorFactSourceV1 {
	if (key.startsWith("tools.")) return "tool";
	if (key.startsWith("task.") || key === "result.pass" || key === "verifier.exitCode") return "grader";
	if (
		key.startsWith("receipt.") ||
		key.startsWith("evidence.") ||
		key.startsWith("boundary.") ||
		key.startsWith("loop.") ||
		key.startsWith("cost.")
	)
		return "receipt";
	return "transcript";
}
