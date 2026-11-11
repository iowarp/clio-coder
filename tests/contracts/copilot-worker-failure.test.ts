import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFailure, decideRetry } from "../../src/domains/dispatch/failure-classification.js";
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

describe("copilot worker failure", () => {
	it("does not retry a Copilot worker that is not signed in", () => {
		const stderrTail =
			"[worker] agent ended with stopReason=error: GitHub Copilot is not signed in. Sign in with the official GitHub Copilot CLI (`copilot login`) or the GitHub CLI (`gh auth login`), then retry. Clio never signs in to Copilot itself.";
		const failureClass = classifyFailure(evidence, { exitCode: 1, signal: null, stderrTail }, "failed", null);
		strictEqual(decideRetry(failureClass, 0, 2).retry, false);
	});
});
