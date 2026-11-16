import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { CanonicalTrustStatus } from "../../src/domains/evidence/index.js";
import { type FinishedRun, workerTextLabel } from "../../src/tools/worker-evidence.js";

function failedBy(authority: string): CanonicalTrustStatus {
	return {
		validationGrounding: { state: "failed", authority: { kind: "validator", id: authority } },
	} as unknown as CanonicalTrustStatus;
}

function verifierRun(verdict: object): FinishedRun {
	return {
		facts: { quality: { resultContract: { sourceId: "agent-result-contract:verifier-report:abc" } } },
		delivered: { output: { state: "final", text: JSON.stringify(verdict) } },
	} as unknown as FinishedRun;
}

const failVerdict = {
	verdict: "fail",
	checks: [
		{ name: "claims cite evidence", passed: false, evidence: "intro paragraph 2 cites nothing" },
		{ name: "word budget", passed: true, evidence: "1180 of 1200" },
		{ name: "terminology", passed: false, evidence: "admission and gating used for one concept" },
	],
};

describe("a read-only reviewer's fail verdict reads as a review verdict (WTF-P 0.8.3 A3)", () => {
	it("labels a verifier-report fail with its finding count", () => {
		strictEqual(
			workerTextLabel(failedBy("result-quality"), verifierRun(failVerdict)),
			"review verdict: fail (2 findings):",
		);
	});

	it("keeps 'validation failed' when a check actually executed", () => {
		strictEqual(
			workerTextLabel(failedBy("host-observed-command"), verifierRun(failVerdict)),
			"worker claims (validation failed; a check ran and did not pass):",
		);
	});
});
