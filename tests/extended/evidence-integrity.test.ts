import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { attributeEvidenceFailure, type EvidenceFailureFacts } from "../../src/domains/evidence/failure-attribution.js";
import { admitRunProvenance } from "../../src/domains/evidence/provenance.js";
import { createRedactionTally, redactSecretsDeep } from "../../src/domains/evidence/redact.js";
import { inspectRunEvidence } from "../../src/domains/evidence/run-evidence.js";
import { inspectRunTrustStatus } from "../../src/domains/evidence/trust-status.js";
import { createProtectedArtifactsRegistration } from "../../src/domains/safety/protected-artifacts-registration.js";

const FAILURE: EvidenceFailureFacts = {
	outcome: "failed",
	outcomeCode: null,
	outcomeDetail: null,
	failureMessage: null,
};

describe("evidence integrity boundary", () => {
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
