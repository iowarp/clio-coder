import type { EvalArtifactV2 } from "../schema/artifact-v2.js";
import type { EvalMetricAssertion, EvalSuiteThresholdsV2 } from "../schema/suite-v2.js";
import { evaluateMetricAssertion } from "./thresholds.js";

export interface EvalGateResult {
	pass: boolean;
	failures: EvalMetricAssertion[];
}

export function evaluateGate(artifact: EvalArtifactV2, thresholds: EvalSuiteThresholdsV2): EvalGateResult {
	const failures = thresholds.fail.filter((assertion) => evaluateMetricAssertion(assertion, {}, artifact));
	return { pass: failures.length === 0, failures };
}
