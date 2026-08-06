import type { EvalArtifactV4 } from "../schema/artifact.js";
import type { EvalMetricAssertion, EvalSuiteThresholdsV2 } from "../schema/suite.js";
import { resolveMetricAssertion } from "./thresholds.js";

export interface EvalGateFailure {
	assertion: EvalMetricAssertion;
	actual: number | string | boolean | null;
	/** True when the metric could not be resolved from the artifact. */
	unresolved: boolean;
	/** The run this failure was read from; absent for whole-artifact readings. */
	taskId?: string;
	repeatIndex?: number;
}

export interface EvalGateResult {
	pass: boolean;
	failures: EvalGateFailure[];
}

/**
 * A gate fails closed: a fail threshold whose condition holds is a failure,
 * and so is a threshold whose metric the artifact cannot resolve. A typoed or
 * uncollected metric must never let a release gate pass silently.
 *
 * Whole-artifact metrics (`result.pass`, `latency.wallMs`, `tokens.total`,
 * `summary.*`) are read once. Everything else is a per-run reading, and the
 * gate covers every run: one run that trips the condition fails the gate, and
 * so does one run the metric could not be read from. Reading them per run is
 * what lets the failure name the offending run and its value instead of
 * collapsing the matrix into a single aggregate nobody can act on.
 */
export function evaluateGate(artifact: EvalArtifactV4, thresholds: EvalSuiteThresholdsV2): EvalGateResult {
	const failures: EvalGateFailure[] = [];
	for (const assertion of thresholds.fail) {
		const whole = resolveMetricAssertion(assertion, {}, artifact);
		if (!whole.unresolved) {
			if (whole.holds) failures.push({ assertion, actual: whole.actual, unresolved: false });
			continue;
		}
		if (artifact.results.length === 0) {
			failures.push({ assertion, actual: null, unresolved: true });
			continue;
		}
		for (const result of artifact.results) {
			const perRun = resolveMetricAssertion(assertion, result.metrics);
			if (!perRun.unresolved && !perRun.holds) continue;
			failures.push({
				assertion,
				actual: perRun.actual,
				unresolved: perRun.unresolved,
				taskId: result.taskId,
				repeatIndex: result.repeatIndex,
			});
		}
	}
	return { pass: failures.length === 0, failures };
}

/** One operator-facing line per gate failure, naming the run when there is one. */
export function renderGateFailure(failure: EvalGateFailure): string {
	const run = failure.taskId === undefined ? "" : ` [${failure.taskId}#${failure.repeatIndex ?? 0}]`;
	const { metric, op, value } = failure.assertion;
	return failure.unresolved
		? `  ${metric}${run}: unresolved metric (fail closed)\n`
		: `  ${metric} ${op} ${JSON.stringify(value)}${run}: actual ${JSON.stringify(failure.actual)}\n`;
}
