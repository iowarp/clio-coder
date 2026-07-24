import { WORKER_EXIT_PERMISSION_REQUIRED } from "../../worker/spec-contract.js";
import { isDeterministicOutcomeCode } from "./backoff.js";
import type { RunTerminationEvidence } from "./outcome.js";
import type { RunOutcome, RunOutcomeCode } from "./types.js";
import type { SpawnedWorkerResult } from "./worker-spawn.js";

export type FailureClass =
	| "operator-cancel"
	| "policy"
	| "permission"
	| "target-rate-limit"
	| "target-transient"
	| "capacity"
	| "node-channel"
	| "worker-runtime"
	| "deterministic-task"
	| "internal";

export type RoutePart = "agent" | "target" | "model" | "node" | "runtime";

export interface RetryDecision {
	retry: boolean;
	retryAfterMs?: number;
	excludedRouteParts: RoutePart[];
	mayEscalateQuality: boolean;
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
	if (evidence.stallKilled || outcome === "stalled" || outcome === "spawn_failed" || result?.exitCode === 255) {
		return "node-channel";
	}
	const diagnostic = resultText(result);
	if (/\b429\b|rate[ -]?limit|too many requests/.test(diagnostic)) return "target-rate-limit";
	if (/capacity|out of memory|\boom\b|\bvram\b/.test(diagnostic)) return "capacity";
	if (evidence.timedOut || outcome === "timed_out" || /temporar|unavailable|\b50[234]\b/.test(diagnostic)) {
		return "target-transient";
	}
	if (outcome === "failed") return "worker-runtime";
	return "internal";
}

/** Pure bounded retry policy. attempt is the zero-based lineage attempt. */
export function decideRetry(failureClass: FailureClass, attempt: number, maxRetries: number): RetryDecision {
	const exhausted = maxRetries <= 0 || attempt >= maxRetries;
	const base = (excludedRouteParts: RoutePart[], reasonCode: string, mayEscalateQuality = false): RetryDecision => ({
		retry: !exhausted,
		excludedRouteParts,
		mayEscalateQuality,
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
				mayEscalateQuality: false,
				reasonCode: `non-retryable-${failureClass}`,
			};
		case "node-channel":
			return base(["node"], "retry-node-channel");
		case "target-rate-limit": {
			const decision = base(["target"], "retry-target-rate-limit");
			return decision.retry ? { ...decision, retryAfterMs: 1_000 } : decision;
		}
		case "target-transient":
			return base(["target"], "retry-target-transient");
		case "capacity":
			return base(["node"], "retry-capacity");
		case "worker-runtime":
			return base(["runtime"], "retry-worker-runtime", true);
		case "internal":
			return base([], "retry-internal");
	}
}

export function isInfrastructureFailure(failureClass: FailureClass): boolean {
	return (
		failureClass === "target-rate-limit" ||
		failureClass === "target-transient" ||
		failureClass === "capacity" ||
		failureClass === "node-channel" ||
		failureClass === "worker-runtime" ||
		failureClass === "internal"
	);
}
