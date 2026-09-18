import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import {
	affectsTargetBreaker,
	classifyFailure,
	decideRetry,
} from "../../src/domains/dispatch/failure-classification.js";
import type { RunTerminationEvidence } from "../../src/domains/dispatch/outcome.js";

const evidence: RunTerminationEvidence = {
	exitCode: 1,
	abortedByOperator: false,
	stallKilled: false,
	timedOut: false,
	permissionFailure: false,
	policyDenied: null,
	stopReason: null,
};

function classifyTail(stderrTail: string) {
	return classifyFailure(evidence, { exitCode: 1, signal: null, stderrTail }, "failed", null);
}

describe("dispatch failure classification", () => {
	it("keeps a provider context overflow off the target breaker and out of retry", () => {
		for (const tail of [
			"[worker] provider error: 400 This model's maximum context length is 8192 tokens. However, you requested 9000 tokens",
			"[worker] provider error: exceed_context_size_error: request (8009 tokens) exceeds the available context size (2048 tokens), try increasing it",
			"[worker] provider error: prompt too long; exceeded max context length by 812 tokens",
		]) {
			const failureClass = classifyTail(tail);
			strictEqual(failureClass, "deterministic-task", tail);
			strictEqual(affectsTargetBreaker(failureClass), false, tail);
			strictEqual(decideRetry(failureClass, 0, 2).retry, false, tail);
		}
	});

	it("treats bare 500s and connection failures as target-transient", () => {
		for (const tail of [
			"[worker] provider error: 500 status code (no body)",
			"[worker] provider error: Internal Server Error",
			"[worker] provider error: connect ECONNREFUSED 192.168.86.20:11434",
			"[worker] provider error: read ECONNRESET",
			"[worker] provider error: TypeError: fetch failed",
		]) {
			strictEqual(classifyTail(tail), "target-transient", tail);
		}
	});
});
