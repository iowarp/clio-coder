import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
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
		match(labels, /validation observed passing: python -m pytest/u);
		match(labels, /validationGrounding:validated/u);
		match(labels, /completionEvidence:evidenced/u);
		match(labels, /evidence_verification=verified\/validation-tool/u);
		strictEqual(run.facts.outcome, "failed");
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
