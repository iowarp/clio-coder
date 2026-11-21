import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";

import { formatDispatchOutput, nextHostValidationAction } from "../../src/tools/dispatch-runner.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

function ungroundedRun(declaredCheck?: string, contractKind?: string) {
	const envelope = fixtureEnvelope("run-unchecked");
	const draft = fixtureReceiptDraft(envelope);
	if (contractKind !== undefined) {
		draft.quality = {
			...draft.quality,
			resultContract: {
				sourceId: `agent-result-contract:${contractKind}:digest`,
				validatorDigest: "validator",
				conformance: "pass",
				quality: "pass",
			},
		};
	}
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
	it("names declared expected outputs the run left unwritten, so the caller moves them instead of searching", () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-coder-expected-outputs-"));
		try {
			writeFileSync(join(cwd, "app.js"), "");
			const envelope = fixtureEnvelope("run-plan");
			const draft = fixtureReceiptDraft(envelope);
			draft.output = {
				state: "final",
				text: "wrote plan artifact (9B) to .clio-coder/artifacts/PLAN.md",
				bytes: 57,
				truncated: false,
			};
			draft.reproducibility = {
				cwd,
				safetyPolicy: {
					version: 1,
					rulePackHash: null,
					rulePackVersion: null,
					projectPolicyPath: null,
					projectPolicyHash: null,
					projectPolicyValid: null,
				},
			};
			draft.intent = {
				version: 2,
				readRoots: [],
				writeRoots: [],
				relevantPaths: [],
				pathProvenance: [],
				expectedOutputs: ["PLAN.md", "app.js"],
				verification: [],
			};
			const receipt = finishRunResult(draft, envelope, {
				terminal: { terminalReason: "completed" },
				processExitCode: envelope.exitCode,
				frameType: null,
				usage: undefined,
			}).result;
			const run = {
				receipt,
				integrity: { state: "verified" as const, by: "producer" as const },
				summary: { count: 0, types: [], lastAssistantText: "", terminalAttemptRunId: receipt.runId },
			};
			const output = formatDispatchOutput("parallel", [run], 16_384);
			match(output, /^expected_outputs run-plan: not written \["PLAN\.md"\]; its answer names what it wrote/m);
			doesNotMatch(output, /not written \[[^\]]*app\.js/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("counts an expected output a merged task worktree changed as written once the worktree is gone (M-17)", () => {
		const envelope = fixtureEnvelope("run-merged");
		const draft = fixtureReceiptDraft(envelope);
		const gone = join(tmpdir(), "clio-coder-merged-worktree-removed");
		draft.reproducibility = {
			cwd: gone,
			safetyPolicy: {
				version: 1,
				rulePackHash: null,
				rulePackVersion: null,
				projectPolicyPath: null,
				projectPolicyHash: null,
				projectPolicyValid: null,
			},
		};
		draft.worktree = {
			path: gone,
			branch: "clio-coder/task/run-merged",
			diffHash: "hash",
			changedPaths: ["a.js"],
			commit: "96abc3e",
			apply: "merge",
			applied: true,
		};
		draft.intent = {
			version: 2,
			readRoots: [],
			writeRoots: [],
			relevantPaths: [],
			pathProvenance: [],
			expectedOutputs: ["a.js", "b.js"],
			verification: [],
		};
		const receipt = finishRunResult(draft, envelope, {
			terminal: { terminalReason: "completed" },
			processExitCode: envelope.exitCode,
			frameType: null,
			usage: undefined,
		}).result;
		const run = {
			receipt,
			integrity: { state: "verified" as const, by: "producer" as const },
			summary: { count: 0, types: [], lastAssistantText: "", terminalAttemptRunId: receipt.runId },
		};
		match(formatDispatchOutput("parallel", [run], 16_384), /^expected_outputs run-merged: not written \["b\.js"\];/m);
	});

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

	it("tells the parent to use a read-only reviewer's sealed findings instead of running host checks", () => {
		const run = { ...ungroundedRun(undefined, "verifier-report"), readOnly: true };
		const output = formatDispatchOutput("parallel", [run], 16_384);
		match(
			output,
			/next step for run-unchecked: use the sealed findings; spot-check consequential claims\. Its passing checks are review judgments/,
		);
		strictEqual(/verify\(\)|worker diff/.test(output.split("\n\n")[0] ?? ""), false);
	});

	it("frames a read-only reviewer's unexecuted checks as judgments, not checks to re-run", () => {
		const base = ungroundedRun(undefined, "verifier-report");
		const envelope = fixtureEnvelope("run-unchecked");
		const { digest: _digest, ...draft } = base.receipt;
		const receipt = finishRunResult(
			{ ...draft, verification: { state: "not_applicable", basis: "read-only-agent" } },
			envelope,
			{ terminal: { terminalReason: "completed" }, processExitCode: envelope.exitCode, frameType: null, usage: undefined },
		).result;
		const output = formatDispatchOutput("parallel", [{ ...base, receipt, readOnly: true }], 16_384);
		match(output, /non-evidence: this run reported "tests pass" as passing review judgments and executed no command/);
		strictEqual(output.includes("Re-run the check yourself"), false);
		match(formatDispatchOutput("parallel", [ungroundedRun()], 16_384), /Re-run the check yourself/);
	});

	it("keeps a report contract's checks out of host validation even off a read-only class", () => {
		match(nextHostValidationAction(ungroundedRun(undefined, "research-report").receipt) ?? "", /use the sealed findings/);
		match(nextHostValidationAction(ungroundedRun(undefined, "mutation-report").receipt) ?? "", /inspect the worker diff/);
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
