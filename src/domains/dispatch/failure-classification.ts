import { isResponseSchemaRejection } from "../../core/response-schema.js";
import { isEngineContextOverflow, isProviderContentFilter } from "../../engine/ai.js";
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
	| "provider-refusal"
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

/**
 * Target failures worth another attempt. A bare 500 and a refused, reset, or
 * failed connection mean the endpoint could not answer this time, not that the
 * worker runtime is broken, so they fail over to another target. "Request timed
 * out." and "Connection error." are the OpenAI SDK's own wording for the same.
 */
const TRANSIENT_TARGET_TEXT =
	/timeout|timed out|temporar|unavailable|\b50[0234]\b|internal server error|econnrefused|econnreset|fetch failed|connection error/;

const WORKERSPEC_REJECTION = /\[worker\] fatal: workerspec/;

function resultText(result: SpawnedWorkerResult | null, providerError?: string | null): string {
	return [result?.stderrTail, providerError]
		.filter((part): part is string => typeof part === "string" && part.length > 0)
		.join("\n")
		.toLowerCase();
}

/**
 * Whether a deterministic-task class came from the provider's context-overflow
 * verdict rather than an outcome code, a rejected schema, or a rejected worker
 * spec. Only this cause can succeed elsewhere: the same prompt fits a route
 * whose window is larger.
 */
export function isContextOverflowFailure(
	failureClass: FailureClass,
	result: SpawnedWorkerResult | null,
	code: RunOutcomeCode | null | undefined,
	providerError?: string | null,
): boolean {
	if (failureClass !== "deterministic-task" || isDeterministicOutcomeCode(code)) return false;
	const diagnostic = resultText(result, providerError);
	if (diagnostic === "" || isResponseSchemaRejection(diagnostic) || WORKERSPEC_REJECTION.test(diagnostic)) return false;
	return isEngineContextOverflow(diagnostic);
}

/**
 * Classify coordinator-owned termination evidence without mutating routing state.
 * `providerError` is the worker's last provider error message. A worker that
 * ends on a structured handoff writes nothing to stderr, so without it a 429
 * or a content filter on a scout classified as a worker runtime failure. The
 * ACP path already passes the provider message in place of stderr.
 */
export function classifyFailure(
	evidence: RunTerminationEvidence,
	result: SpawnedWorkerResult | null,
	outcome: RunOutcome,
	code: RunOutcomeCode | null | undefined,
	providerError?: string | null,
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
	const diagnostic = resultText(result, providerError);
	// The provider's content filter answered, so the endpoint is up and the
	// worker runtime did nothing wrong. Charging it to the target breaker let
	// three filtered scouts in a row park a healthy Mercury endpoint for every
	// other run. The filter is stochastic: over 28 scout attempts on this
	// repository it stopped 13, and a same-route retry recovered half of the
	// filtered assignments.
	if (outcome === "failed" && isProviderContentFilter(diagnostic)) return "provider-refusal";
	// A response schema the server will not compile into a grammar is a verdict
	// on the request Clio sent, not on the target. Retrying the identical bytes
	// earns the identical 400, and letting it reach the target breaker parks a
	// healthy endpoint for every other run in the window. Deterministic ends the
	// attempt here and leaves the caller free to redispatch without the schema.
	if (isResponseSchemaRejection(diagnostic)) return "deterministic-task";
	// The worker rejected the specification the orchestrator wrote. A retry sends
	// a document built the same way from the same settings and earns the same
	// rejection, so three attempts only tripled the cost of one configuration
	// error. Ending it here surfaces the contract message the operator has to act
	// on instead of burying it under two more identical failures.
	if (WORKERSPEC_REJECTION.test(diagnostic)) return "deterministic-task";
	// A provider that reports the prompt no longer fits the model's context
	// window has judged the request, not the target. The identical input earns
	// the identical overflow on every retry, and charging it to the target
	// breaker would park a healthy endpoint for runs whose prompts do fit. The
	// engine's detector carries pi-ai's per-provider patterns, including the
	// llama.cpp and Ollama "exceeds the available context size" wording.
	if (diagnostic !== "" && isEngineContextOverflow(diagnostic)) return "deterministic-task";
	if (/\b(?:401|403)\b|unauthorized|forbidden|invalid api key|authentication/.test(diagnostic)) return "target-auth";
	if (/\b429\b|rate[ -]?limit|too many requests/.test(diagnostic)) return "target-rate-limit";
	if (/\bvram\b|\bgpu\b|\bcuda\b|\boom\b|out of memory/.test(diagnostic)) return "node-resource";
	if (/capacity|overloaded|queue full/.test(diagnostic)) return "capacity";
	if (evidence.timedOut || outcome === "timed_out" || TRANSIENT_TARGET_TEXT.test(diagnostic)) {
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
		case "provider-refusal":
			return base([], "retry-provider-refusal");
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
