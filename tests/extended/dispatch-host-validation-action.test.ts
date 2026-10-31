import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";

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
	const receipt = finishRunResult(draft, envelope, {
		terminal: { terminalReason: draft.terminalReason ?? "completed" },
		processExitCode: envelope.exitCode,
		frameType: null,
		usage: undefined,
	}).result;
	const integrity = { state: "verified" as const, by: "producer" as const };

	return {
		receipt,
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
		match(nextHostValidationAction(run.receipt) ?? "", /run verify\(check="test"\) in the host workspace/);
		match(
			formatDispatchOutput("parallel", [run], 16_384),
			/next host validation for run-unchecked: run verify\(check="test"\)/,
		);
	});

	it("does not request another host check after host evidence", () => {
		const run = ungroundedRun("test");
		const envelope = fixtureEnvelope("run-unchecked");
		const { digest: _digest, ...draft } = run.receipt;
		const verified = finishRunResult({ ...draft, hostVerification: { status: "verified", checks: [] } }, envelope, {
			terminal: { terminalReason: "completed" },
			processExitCode: envelope.exitCode,
			frameType: null,
			usage: undefined,
		}).result;
		strictEqual(nextHostValidationAction(verified), null);
		const rejected = finishRunResult(
			{
				...draft,
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
			{ terminal: { terminalReason: "completed" }, processExitCode: envelope.exitCode, frameType: null, usage: undefined },
		).result;
		strictEqual(nextHostValidationAction(rejected), null);
	});
});
