import { isResponseSchemaRejection } from "../../core/response-schema.js";
import { WORKER_EXIT_PERMISSION_REQUIRED } from "../../worker/spec-contract.js";
import { isDeterministicOutcomeCode } from "./backoff.js";
import type { RunTerminationEvidence } from "./outcome.js";
import type { RunOutcome, RunOutcomeCode } from "./types.js";
import type { SpawnedWorkerResult } from "./worker-spawn.js";

export type FailureClass =
	| "operator-cancel"
	| "policy"
	| "permission"
	| "deterministic-task"
	| "model-quality"
	| "target-auth"
	| "target-rate-limit"
	| "target-transient"
	| "capacity"
	| "node-channel"
	| "node-resource"
	| "worker-runtime"
	| "internal";

export type RoutePart = "agent" | "target" | "model" | "node" | "runtime";

export interface RetryDecision {
	retry: boolean;
	retryAfterMs?: number;
	excludedRouteParts: RoutePart[];
	/** Typed authority to consider another agent; only model-quality evidence can carry it. */
	qualityEscalation: null | { kind: "model-quality"; allowAgentChange: true };
	reasonCode: string;
}

function resultText(result: SpawnedWorkerResult | null): string {
	return result?.stderrTail?.toLowerCase() ?? "";
}

/** Classify coordinator-owned termination evidence without mutating routing state. */
export function classifyFailure(
	evidence: RunTerminationEvidence,
	result: SpawnedWorkerResult | null,
	outcome: RunOutcome,
	code: RunOutcomeCode | null | undefined,
): FailureClass {
	if (evidence.abortedByOperator || outcome === "canceled") return "operator-cancel";
	if (evidence.policyDenied !== null || outcome === "denied_by_policy") return "policy";
	if (evidence.permissionFailure || evidence.exitCode === WORKER_EXIT_PERMISSION_REQUIRED) return "permission";
	if (isDeterministicOutcomeCode(code)) return "deterministic-task";
	if (evidence.qualityGateFailure === true) return "model-quality";
	// A typed control-channel failure is node evidence on its own. It is checked
	// before the diagnostic text so a stderr tail that happens to mention a
	// target error cannot reclassify a channel that demonstrably failed.
	if (result?.channelFailure !== undefined) return "node-channel";
	if (evidence.stallKilled || outcome === "stalled" || outcome === "spawn_failed" || result?.exitCode === 255) {
		return "node-channel";
	}
	const diagnostic = resultText(result);
	// A response schema the server will not compile into a grammar is a verdict
	// on the request Clio sent, not on the target. Retrying the identical bytes
	// earns the identical 400, and letting it reach the target breaker parks a
	// healthy endpoint for every other run in the window. Deterministic ends the
	// attempt here and leaves the caller free to redispatch without the schema.
	if (isResponseSchemaRejection(diagnostic)) return "deterministic-task";
	if (/\b(?:401|403)\b|unauthorized|forbidden|invalid api key|authentication/.test(diagnostic)) return "target-auth";
	if (/\b429\b|rate[ -]?limit|too many requests/.test(diagnostic)) return "target-rate-limit";
	if (/\bvram\b|\bgpu\b|\bcuda\b|\boom\b|out of memory/.test(diagnostic)) return "node-resource";
	if (/capacity|overloaded|queue full/.test(diagnostic)) return "capacity";
	if (evidence.timedOut || outcome === "timed_out" || /timeout|temporar|unavailable|\b50[234]\b/.test(diagnostic)) {
		return "target-transient";
	}
	if (outcome === "failed") return "worker-runtime";
	return "internal";
}

/** Pure bounded retry policy. attempt is the zero-based lineage attempt. */
export function decideRetry(failureClass: FailureClass, attempt: number, maxRetries: number): RetryDecision {
	const exhausted = maxRetries <= 0 || attempt >= maxRetries;
	const base = (
		excludedRouteParts: RoutePart[],
		reasonCode: string,
		qualityEscalation: RetryDecision["qualityEscalation"] = null,
	): RetryDecision => ({
		retry: !exhausted,
		excludedRouteParts,
		qualityEscalation,
		reasonCode: exhausted ? "retry-exhausted" : reasonCode,
	});

	switch (failureClass) {
		case "operator-cancel":
		case "policy":
		case "permission":
		case "deterministic-task":
			return {
				retry: false,
				excludedRouteParts: [],
				qualityEscalation: null,
				reasonCode: `non-retryable-${failureClass}`,
			};
		case "model-quality":
			return base(["agent", "model"], "retry-model-quality", {
				kind: "model-quality",
				allowAgentChange: true,
			});
		case "node-channel":
			return base(["node"], "retry-node-channel");
		case "node-resource":
			return base(["node"], "retry-node-resource");
		case "target-auth":
			return base(["target"], "retry-target-auth");
		case "target-rate-limit": {
			const decision = base(["target"], "retry-target-rate-limit");
			return decision.retry ? { ...decision, retryAfterMs: 1_000 } : decision;
		}
		case "target-transient":
			return base(["target"], "retry-target-transient");
		case "capacity":
			return base(["node"], "retry-capacity");
		case "worker-runtime":
			return base(["runtime"], "retry-worker-runtime");
		case "internal":
			return base([], "retry-internal");
	}
}

export function affectsTargetBreaker(failureClass: FailureClass): boolean {
	return (
		failureClass === "target-auth" ||
		failureClass === "target-rate-limit" ||
		failureClass === "target-transient" ||
		failureClass === "worker-runtime"
	);
}

export function affectsNodeBreaker(failureClass: FailureClass): boolean {
	return failureClass === "node-channel" || failureClass === "node-resource" || failureClass === "capacity";
}

export function isInfrastructureFailure(failureClass: FailureClass): boolean {
	return affectsTargetBreaker(failureClass) || affectsNodeBreaker(failureClass) || failureClass === "internal";
}
