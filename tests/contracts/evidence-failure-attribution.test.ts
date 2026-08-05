import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { attributeEvidenceFailure, type EvidenceFailureFacts } from "../../src/domains/evidence/failure-attribution.js";

const BASE: EvidenceFailureFacts = {
	outcome: "failed",
	outcomeCode: null,
	outcomeDetail: null,
	failureMessage: null,
};

describe("evidence failure attribution", () => {
	it("uses typed termination facts before diagnostic text", () => {
		strictEqual(
			attributeEvidenceFailure({
				...BASE,
				outcomeCode: "worker_tool_call_cap_exhausted",
				outcomeDetail: "HTTP 429 rate limit after the tool loop ended",
			}),
			"tool-loop",
		);
		strictEqual(attributeEvidenceFailure({ ...BASE, outcome: "timed_out" }), "timeout");
		strictEqual(attributeEvidenceFailure({ ...BASE, outcome: "stalled" }), "timeout");
	});

	it("attributes bounded diagnostics to the observed interaction failure", () => {
		const cases: ReadonlyArray<[string, string]> = [
			["HTTP 401 Unauthorized", "auth-failure"],
			["provider returned 429 rate limit", "provider-transient"],
			["maximum context length exceeded", "context-overflow"],
			["Cannot find module 'scientific-core'", "missing-dependency"],
			["runtime mismatch: unsupported runtime", "wrong-runtime"],
			["test suite failed with 3 errors", "test-failure"],
			["build failed with exit code 2", "build-failure"],
		];
		for (const [diagnostic, expected] of cases) {
			strictEqual(attributeEvidenceFailure({ ...BASE, failureMessage: diagnostic }), expected);
		}
	});

	it("abstains when termination evidence cannot support a cause", () => {
		strictEqual(attributeEvidenceFailure(BASE), "unknown");
		strictEqual(
			attributeEvidenceFailure({
				...BASE,
				outcomeDetail: "exit code 1",
				failureMessage: "worker process ended",
			}),
			"unknown",
		);
	});
});
