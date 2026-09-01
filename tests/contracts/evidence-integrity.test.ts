import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { withReceiptIntegrity, verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { attributeEvidenceFailure, type EvidenceFailureFacts } from "../../src/domains/evidence/failure-attribution.js";
import { admitRunProvenance, runProvenanceFromUnknown } from "../../src/domains/evidence/provenance.js";
import { createRedactionTally, redactSecretsDeep } from "../../src/domains/evidence/redact.js";
import { evidenceDirectory } from "../../src/domains/evidence/store.js";
import { createProtectedArtifactsRegistration } from "../../src/domains/safety/protected-artifacts-registration.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

const FAILURE: EvidenceFailureFacts = {
	outcome: "failed",
	outcomeCode: null,
	outcomeDetail: null,
	failureMessage: null,
};

describe("evidence integrity boundary", () => {
	it("treats artifact names as identities, never paths", () => {
		strictEqual(evidenceDirectory("/data", "evidence-123"), "/data/evidence/evidence-123");
		for (const id of ["../receipt", "nested/receipt", "/absolute"]) {
			throws(() => evidenceDirectory("/data", id), /invalid evidence id|path separators/);
		}
	});

	it("admits only validated provenance fields", () => {
		const view = runProvenanceFromUnknown({
			pipeline: { fromRunId: "run-parent", position: 2, inputBytes: 1024, inputTruncated: false },
			personaOverride: { promptHash: "a".repeat(64) },
			autonomyEnforcement: { grade: "bypassed", autonomy: "full", dangerousBypass: true },
		});
		deepStrictEqual(view.pipeline, {
			fromRunId: "run-parent",
			position: 2,
			inputBytes: 1024,
			inputTruncated: false,
		});
		deepStrictEqual(runProvenanceFromUnknown({ pipeline: { position: "2", inputBytes: -1 } }), {});
		deepStrictEqual(admitRunProvenance(view), {
			pipeline: view.pipeline,
			personaOverride: view.personaOverride,
		});
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

	it("binds a receipt to its run and rejects post-seal tampering", () => {
		const envelope = fixtureEnvelope("run-integrity");
		const receipt = withReceiptIntegrity(
			{
				...fixtureReceiptDraft(envelope),
				pipeline: { fromRunId: "run-parent", position: 1, inputBytes: 512, inputTruncated: false },
			},
			envelope,
		);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
		strictEqual(verifyReceiptIntegrity({ ...receipt, task: "substituted task" }, envelope).ok, false);
		strictEqual(verifyReceiptIntegrity(receipt, { ...envelope, id: "different-run" }).ok, false);
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
