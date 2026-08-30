import type { EvalArtifactResultV4 } from "./artifact.js";
import {
	EVAL_VERDICT_SCHEMA_V1,
	type EvalTrackedMetricsV1,
	type EvalVerdictEnvelopeV1,
	parseEvalVerdictEnvelopeV1,
} from "./verdict.js";

type AdaptableSuiteResult = Pick<
	EvalArtifactResultV4,
	"assignmentId" | "terminalReceiptDigest" | "taskId" | "repeatIndex" | "pass" | "metrics"
>;

/** Adapt one Suite v2 matrix result into the versioned verdict carried by Artifact v4. */
export function adaptSuiteV2ResultToVerdictV1(
	result: AdaptableSuiteResult,
	trackedMetrics: EvalTrackedMetricsV1,
): EvalVerdictEnvelopeV1 {
	const machinery = result.pass ? "ok" : "infrastructure_failure";
	const measuredOutcome = result.metrics["task.solved"];
	const outcome =
		machinery === "infrastructure_failure"
			? "fail"
			: measuredOutcome === true
				? "pass"
				: measuredOutcome === false
					? "fail"
					: "unmeasured";
	const graderExitCode = result.metrics["task.exitCode"];
	return parseEvalVerdictEnvelopeV1({
		schema: EVAL_VERDICT_SCHEMA_V1,
		scenarioId: result.taskId,
		trialIndex: result.repeatIndex,
		outcome,
		machinery,
		trackedMetrics,
		behavioral: null,
		evidence: {
			assignmentId: result.assignmentId,
			terminalReceiptDigest: result.terminalReceiptDigest,
			graderExitCode: typeof graderExitCode === "number" && Number.isInteger(graderExitCode) ? graderExitCode : null,
		},
	});
}
