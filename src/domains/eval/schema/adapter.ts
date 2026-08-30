import type { EvalArtifactResultV4 } from "./artifact.js";
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
