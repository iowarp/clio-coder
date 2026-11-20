import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunTelemetryV1 } from "../../src/core/telemetry/dto.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import {
	deriveRunVerification,
	typedValidationFactsFromObservedEffects,
} from "../../src/domains/dispatch/run-findings.js";
import { settleFinishedRun } from "../../src/domains/dispatch/run-settlement.js";
import { assessRun } from "../../src/domains/evidence/assessment.js";

import { attributeEvidenceFailure, type EvidenceFailureFacts } from "../../src/domains/evidence/failure-attribution.js";
import { admitRunProvenance } from "../../src/domains/evidence/provenance.js";
import { createRedactionTally, redactSecretsDeep } from "../../src/domains/evidence/redact.js";
import { inspectRunEvidence } from "../../src/domains/evidence/run-evidence.js";
import { readRunTrust } from "../../src/domains/evidence/run-trust.js";
import { inspectRunTrustStatus } from "../../src/domains/evidence/trust-status.js";
import { createProtectedArtifactsRegistration } from "../../src/domains/safety/protected-artifacts-registration.js";
import { createRunEffectsRecorder } from "../../src/domains/safety/run-effects.js";
import { telemetryObjectRef } from "../../src/domains/telemetry/objects.js";
import { finishedRun, PRODUCER_INTEGRITY, runEvidenceLabels } from "../../src/tools/worker-evidence.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

const FAILURE: EvidenceFailureFacts = {
	outcome: "failed",
	outcomeCode: null,
	outcomeDetail: null,
	failureMessage: null,
};

describe("evidence integrity boundary", () => {
	it("reports host-observed passing validation and recorded completion when a run fails before submitting", () => {
		const effects = createRunEffectsRecorder("/repo");
		effects.start("pytest", "bash", { command: "python3 -m pytest -q" });
		effects.finish("pytest", false);
		effects.start("diff", "bash", { command: "git diff" });
		effects.finish("diff", false);
		const typedValidations = typedValidationFactsFromObservedEffects(effects.snapshot());
		const draft = fixtureReceiptDraft(fixtureEnvelope("failed-validation-evidence"));
		draft.exitCode = 1;
		draft.outcome = "failed";
		delete draft.output;
		draft.toolStats = [{ tool: "bash", count: 1, ok: 1, errors: 0, blocked: 0, totalDurationMs: 1 }];
		draft.quality.typedValidations = typedValidations;
		draft.verification = deriveRunVerification({ toolStats: draft.toolStats, typedValidations });
		const run = finishedRun(draft);
		const settlement = settleFinishedRun(draft, {
			terminal: { terminalReason: "worker_failed" },
			processExitCode: 1,
			frameType: null,
			usage: undefined,
		});
		const ctx = { sessionId: null, runId: run.runId, agent: { role: "worker" as const, id: run.runId } };
		const clock = { t: draft.endedAt, mono: 1 };
		const assessed = assessRun(run.runId, {
			records: [
				makeTelemetryRecord(
					"completion.evaluated",
					{
						decision: "ok",
						reason: "validation_evidence",
						rigor: "normal",
						mutatedPaths: 3,
						evidenceKinds: ["validation_command"],
						verification: { passedChecks: ["validation command passed: python -m pytest"], acceptance: [] },
					},
					ctx,
					clock,
				),
				makeTelemetryRecord(
					"run.settled",
					{ ...settlement.facts, result: telemetryObjectRef("run-result", settlement.result) },
					ctx,
					clock,
				),
			],
			context: null,
			gateDecisions: [],
			decisions: null,
		});
		ok(assessed);
		run.assessment = assessed.data;
		const labels = runEvidenceLabels(run, PRODUCER_INTEGRITY).join(" ");
		match(labels, /validation observed passing: python3 -m pytest -q/u);
		match(labels, /validationGrounding:validated/u);
		match(labels, /completionEvidence:evidenced/u);
		match(labels, /evidence_verification=verified\/host-observed-command/u);
		strictEqual(run.facts.outcome, "failed");
		// bt-20: `fleet view` and `evidence inspect` read one sealed run DTO and must agree on its completion axis.
		const record = {
			row: { runId: run.runId },
			settled: { ...settlement.facts, at: draft.endedAt, digest: "a".repeat(64) },
			seal: { status: "verified" },
			assessment: { ...assessed.data, at: draft.endedAt, content: null },
		} as unknown as RunTelemetryV1;
		strictEqual(inspectRunTrustStatus(record).status.completionEvidence.state, "evidenced");
		deepStrictEqual(readRunTrust(record).trust, inspectRunTrustStatus(record).status);
	});

	it("names an approval timeout as the cause of a refused worker call (bt-11 t)", () => {
		const draft = fixtureReceiptDraft(fixtureEnvelope("approval-timeout-refusal"));
		draft.toolStats = [
			{ tool: "read", count: 1, ok: 1, errors: 0, blocked: 0, totalDurationMs: 1 },
			{ tool: "bash", count: 1, ok: 0, errors: 0, blocked: 1, totalDurationMs: 1 },
		];
		draft.safety = {
			decisions: {
				allowed: 1,
				blocked: 0,
				permissionRequested: 1,
				escalationRequested: 1,
				escalationApproved: 0,
				escalationDenied: 0,
				escalationTimedOut: 1,
			},
			blockedAttempts: [],
			permissionRequestedAttempts: [{ tool: "bash", actionClass: "execute" }],
		};
		const labels = runEvidenceLabels(finishedRun(draft), PRODUCER_INTEGRITY).join(" ");
		match(labels, /refused_cause=approval_timeout:1 \(a call waited for approval and no one answered in time\)/u);
	});

	it("counts every refused ask out of the sealed tools row, past the 50 the receipt lists (SC-2)", () => {
		const draft = fixtureReceiptDraft(fixtureEnvelope("asks-past-the-list"));
		draft.toolStats = [{ tool: "bash", count: 61, ok: 0, errors: 0, blocked: 61, totalDurationMs: 1 }];
		draft.safety = {
			decisions: { allowed: 0, blocked: 1, permissionRequested: 60 },
			blockedAttempts: [{ tool: "bash" }],
			permissionRequestedAttempts: Array.from({ length: 50 }, () => ({ tool: "bash", permissionRequired: true })),
		};
		const settle = (askedByTool?: ReadonlyMap<string, number>) =>
			settleFinishedRun(draft, {
				terminal: { terminalReason: "completed" },
				processExitCode: 0,
				frameType: null,
				usage: undefined,
				...(askedByTool !== undefined ? { askedByTool } : {}),
			}).facts.tools[0];
		// The exact count the producer kept wins over the capped list; without it the list is all there is. The refused asks
		// stay on the row as `asked`, so calls = ok + errors + blocked + asked (FX-3).
		deepStrictEqual(settle(new Map([["bash", 60]])), {
			tool: "bash",
			calls: 61,
			ok: 0,
			errors: 0,
			blocked: 1,
			asked: 60,
		});
		deepStrictEqual(settle(), { tool: "bash", calls: 61, ok: 0, errors: 0, blocked: 11, asked: 50 });
	});

	it("keeps unfinished calls and route warnings on the sealed record, so a sealed reader shows them too (FL-6)", () => {
		const draft = fixtureReceiptDraft(fixtureEnvelope("unfinished-sealed"));
		draft.toolActivity = { calls: 0, succeeded: 0, failed: 0, blocked: 0, mutatingSucceeded: false };
		draft.safety = {
			decisions: { allowed: 1, blocked: 0, permissionRequested: 0 },
			blockedAttempts: [],
			toolTelemetry: {
				coverage: "partial",
				ingestionErrors: 0,
				unfinished: [{ tool: "bash", count: 1 }],
				workspaceMutationPossible: true,
			},
		};
		draft.runtimeResolution = {
			diagnostics: [
				{ severity: "warning", code: "thinking-coerced", message: "thinking high is not supported; ran medium" },
				{ severity: "info", code: "window", message: "context window from catalog" },
			],
		} as unknown as NonNullable<typeof draft.runtimeResolution>;
		const settlement = settleFinishedRun(draft, {
			terminal: { terminalReason: "worker_failed" },
			processExitCode: 1,
			frameType: null,
			usage: undefined,
		});
		strictEqual(settlement.facts.toolActivity?.unfinished, 1);
		deepStrictEqual(settlement.facts.routeWarnings, ["thinking high is not supported; ran medium"]);
		const sealed = {
			runId: draft.runId,
			digest: null,
			facts: settlement.facts,
			delivered: settlement.result,
			assessment: null,
		};
		match(runEvidenceLabels(sealed, PRODUCER_INTEGRITY).join(" "), /work=calls:0 .* unfinished:1/u);
	});

	it("reads mutations:no when the only state change was refused and a shell call left the tree unmoved (FL-1)", () => {
		const draft = fixtureReceiptDraft(fixtureEnvelope("refused-only-mutation"));
		draft.toolStats = [
			{ tool: "bash", count: 2, ok: 1, errors: 0, blocked: 1, totalDurationMs: 1 },
			{ tool: "limitation", count: 1, ok: 1, errors: 0, blocked: 0, totalDurationMs: 1 },
		];
		draft.toolActivity = { calls: 3, succeeded: 2, failed: 0, blocked: 1, mutatingSucceeded: true };
		match(runEvidenceLabels(finishedRun(draft), PRODUCER_INTEGRITY).join(" "), /blocked:1 mutations:yes/u);
		draft.checkoutChanges = { cwd: "/repo", changedPaths: [], attribution: "observed-delta" };
		match(runEvidenceLabels(finishedRun(draft), PRODUCER_INTEGRITY).join(" "), /blocked:1 mutations:no/u);
		draft.toolStats.push({ tool: "edit", count: 1, ok: 1, errors: 0, blocked: 0, totalDurationMs: 1 });
		match(runEvidenceLabels(finishedRun(draft), PRODUCER_INTEGRITY).join(" "), /mutations:yes/u);
	});

	it("does not call a run whose validation failed a first-pass success (FL-3, bt-48-9)", () => {
		const draft = fixtureReceiptDraft(fixtureEnvelope("validation-failed-first-pass"));
		draft.quality.resultContract = {
			sourceId: `agent-result-contract:mutation-report:${"a".repeat(64)}`,
			validatorDigest: "b".repeat(64),
			conformance: "pass",
			quality: "fail",
		};
		const settlement = settleFinishedRun(draft, {
			terminal: { terminalReason: "completed" },
			processExitCode: 0,
			frameType: null,
			usage: undefined,
		});
		const ctx = { sessionId: null, runId: draft.runId, agent: { role: "worker" as const, id: draft.runId } };
		const assessed = assessRun(draft.runId, {
			records: [
				makeTelemetryRecord(
					"run.settled",
					{ ...settlement.facts, result: telemetryObjectRef("run-result", settlement.result) },
					ctx,
					{ t: draft.endedAt, mono: 1 },
				),
			],
			context: { sessionId: null, cwd: "/repo", attempt: 0, decisionRefs: [], pipeline: null, personaOverride: null },
			gateDecisions: [],
			decisions: null,
		});
		ok(assessed);
		strictEqual(settlement.facts.outcome, "succeeded");
		strictEqual(assessed.data.trust.validationGrounding.state, "failed");
		strictEqual(assessed.data.firstPassSuccess, false);
	});

	it("treats run ids as identities, never paths", async () => {
		for (const id of ["../receipt", "nested/receipt", "/absolute"]) {
			await rejects(inspectRunEvidence("/state", id), /invalid run id|path separators/);
		}
	});

	it("admits provenance only under a verified integrity axis", () => {
		const view = {
			pipeline: { fromRunId: "run-parent", position: 2, inputBytes: 1024, inputTruncated: false },
			personaOverride: { promptHash: "a".repeat(64) },
		};
		deepStrictEqual(admitRunProvenance(view), view);
		const unsealed = inspectRunTrustStatus(null).status;
		deepStrictEqual(admitRunProvenance(view, unsealed), {});
	});

	it("redacts an opaque authorization credential but not a variable or prose", () => {
		const tally = createRedactionTally();
		const redacted = redactSecretsDeep(
			{
				header: "Authorization: Bearer CANARY-opaque-abcdef123456",
				scheme: "sent bearer abcdef123456 upstream",
				reference: 'curl -H "Authorization: Bearer $TOKEN"',
				prose: "a bearer credential is required",
			},
			tally,
		);
		strictEqual(redacted.header, "Authorization: Bearer [redacted:authorization]");
		strictEqual(redacted.scheme, "sent bearer [redacted:authorization] upstream");
		strictEqual(redacted.reference, 'curl -H "Authorization: Bearer $TOKEN"');
		strictEqual(redacted.prose, "a bearer credential is required");
		strictEqual(tally.count, 2);
	});

	it("redacts secrets deeply and accounts for every replacement", () => {
		const tally = createRedactionTally();
		const source = {
			task: "deploy with ghp_abcdefghijklmnopqrstuvwxyz012345",
			tool: { command: "API_KEY=hunter2hunter2hunter2" },
			clean: "npm test",
		};
		const redacted = redactSecretsDeep(source, tally);
		strictEqual(redacted.clean, source.clean);
		ok(!JSON.stringify(redacted).includes("ghp_abcdefghijklmnopqrstuvwxyz012345"));
		ok(!JSON.stringify(redacted).includes("hunter2hunter2hunter2"));
		strictEqual(tally.count, 2);
	});

	it("attributes failures from typed facts before bounded diagnostics", () => {
		strictEqual(
			attributeEvidenceFailure({
				...FAILURE,
				outcomeCode: "worker_tool_call_cap_exhausted",
				failureMessage: "HTTP 401 Unauthorized",
			}),
			"tool-loop",
		);
		strictEqual(attributeEvidenceFailure({ ...FAILURE, outcome: "timed_out" }), "timeout");
		strictEqual(attributeEvidenceFailure({ ...FAILURE, failureMessage: "HTTP 429 rate limit" }), "provider-transient");
		strictEqual(attributeEvidenceFailure({ ...FAILURE, failureMessage: "worker ended" }), "unknown");
	});

	it("hard-blocks mutations of protected evidence while permitting reads", () => {
		const guard = createProtectedArtifactsRegistration({
			initialState: {
				artifacts: [
					{
						path: "/repo/receipt.json",
						protectedAt: "2026-08-01T00:00:00.000Z",
						reason: "sealed evidence",
						source: "user",
					},
				],
			},
		});
		const writeEffects = guard.evaluate({
			hook: "before_tool",
			toolName: "write",
			toolArgs: { path: "/repo/receipt.json", content: "replacement" },
		});
		strictEqual(writeEffects[0]?.kind, "block_tool");
		if (writeEffects[0]?.kind === "block_tool") match(writeEffects[0].reason, /protected artifact blocked/);
		deepStrictEqual(
			guard.evaluate({ hook: "before_tool", toolName: "read", toolArgs: { path: "/repo/receipt.json" } }),
			[],
		);
	});
});
