import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyReceiptIntegrity, withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { formatDispatchOutput, nextHostValidationAction } from "../../src/tools/dispatch-runner.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

function ungroundedRun(declaredCheck?: string) {
	const envelope = fixtureEnvelope("run-unchecked");
	const draft = fixtureReceiptDraft(envelope);
	draft.output = { state: "final", text: "Source inspected; tests pass.", bytes: 29, truncated: false };
	draft.validationGrounding = {
		claimed: 1,
		grounded: 0,
		ungrounded: ["tests pass"],
		basis: "no-command-executed",
	};
	if (declaredCheck) {
		draft.intent = {
			version: 2,
			readRoots: [],
			writeRoots: [],
			relevantPaths: [],
			pathProvenance: [],
			expectedOutputs: [],
			verification: [{ check: declaredCheck, timeoutMs: 60_000 }],
		};
	}
	const receipt = withReceiptIntegrity(draft, envelope);
	const integrity = verifyReceiptIntegrity(receipt, envelope);
	ok(integrity.ok);
	return {
		receipt,
		receiptPath: null,
		integrity,
		summary: { count: 0, types: [], lastAssistantText: "", terminalAttemptRunId: receipt.runId },
	};
}

describe("dispatch host validation action", () => {
	it("leads an ungrounded worker return with the next host check sequence", () => {
		const run = ungroundedRun();
		const output = formatDispatchOutput("parallel", [run], 16_384);
		match(
			output,
			/next host validation for run-unchecked: inspect the worker diff, list available host checks with verify\(\), then run the applicable test or build check in the host workspace/,
		);
		match(output, /inspect the actual exit code and output, and record that result before reporting verified completion/);
		ok(output.indexOf("next host validation") < output.indexOf("worker claims"));
		match(output, /validations=claimed:1 grounded:0/);
	});

	it("names the declared verifier id instead of guessing a shell command", () => {
		const run = ungroundedRun("test");
		match(nextHostValidationAction(run.receipt, run.integrity) ?? "", /run verify\(check="test"\) in the host workspace/);
		match(
			formatDispatchOutput("parallel", [run], 16_384),
			/next host validation for run-unchecked: run verify\(check="test"\)/,
		);
	});

	it("does not request another host check after verified host evidence or from an invalid seal", () => {
		const run = ungroundedRun("test");
		const envelope = fixtureEnvelope("run-unchecked");
		const verified = withReceiptIntegrity(
			{ ...run.receipt, hostVerification: { status: "verified", checks: [] } },
			envelope,
		);
		strictEqual(nextHostValidationAction(verified, verifyReceiptIntegrity(verified, envelope)), null);
		const rejected = withReceiptIntegrity(
			{
				...run.receipt,
				hostVerification: {
					status: "rejected",
					checks: [
						{
							check: "test",
							argv: ["node", "test.js"],
							cwd: "/workspace",
							exitCode: 1,
							durationMs: 10,
							memo: false,
							outputTail: "failed",
						},
					],
				},
			},
			envelope,
		);
		strictEqual(nextHostValidationAction(rejected, verifyReceiptIntegrity(rejected, envelope)), null);
		const tampered = { ...run.receipt, task: "tampered" };
		const failedIntegrity = verifyReceiptIntegrity(tampered, fixtureEnvelope("run-unchecked"));
		strictEqual(failedIntegrity.ok, false);
		strictEqual(nextHostValidationAction(tampered, failedIntegrity), null);
		doesNotMatch(
			formatDispatchOutput("parallel", [{ ...run, receipt: tampered, integrity: failedIntegrity }], 16_384),
			/next host validation/,
		);
	});
});
