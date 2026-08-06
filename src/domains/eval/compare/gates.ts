import type { EvalArtifactV4 } from "../schema/artifact.js";
import type { EvalMetricAssertion, EvalSuiteThresholdsV2 } from "../schema/suite.js";
import { evaluateMetricAssertion, metricValue } from "./thresholds.js";

export interface EvalGateFailure {
	assertion: EvalMetricAssertion;
	actual: number | string | boolean | null;
	/** True when the metric could not be resolved from the artifact. */
	unresolved: boolean;
}

export interface EvalGateResult {
	pass: boolean;
	failures: EvalGateFailure[];
}

/**
 * A gate fails closed: a fail threshold whose condition holds is a failure,
 * and so is a threshold whose metric the artifact cannot resolve. A typoed or
 * uncollected metric must never let a release gate pass silently.
 */
export function evaluateGate(artifact: EvalArtifactV4, thresholds: EvalSuiteThresholdsV2): EvalGateResult {
	const failures: EvalGateFailure[] = [];
	for (const assertion of thresholds.fail) {
		const actual = metricValue(assertion.metric, {}, artifact);
		if (actual === null) {
			failures.push({ assertion, actual, unresolved: true });
			continue;
		}
		if (evaluateMetricAssertion(assertion, {}, artifact)) {
			failures.push({ assertion, actual, unresolved: false });
		}
	}
	return { pass: failures.length === 0, failures };
}
