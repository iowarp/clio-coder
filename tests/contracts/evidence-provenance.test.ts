/**
 * The canonical projection is the only thing that decides whether a trust
 * axis is reported. The provenance renderers print the detail behind an
 * axis, never a second reading of it, and they print nothing at all from a
 * receipt the projection withheld.
 */

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	admitRunProvenance,
	type CanonicalTrustStatus,
	composeTrustStatus,
	provenanceCompactSuffix,
	provenanceTranscriptLines,
	type RunProvenanceView,
} from "../../src/domains/evidence/index.js";

const VIEW: RunProvenanceView = {
	pipeline: { fromRunId: "run-up", position: 2, inputBytes: 32, inputTruncated: false },
	personaOverride: { promptHash: "1b3fc16b2c4d5e6f7a8b9c0d1e2f3a4b" },
	escalation: { requested: 2, approved: 0, denied: 1, timedOut: 1 },
	autonomyEnforcement: { grade: "approximated", autonomy: "auto-edit", externalMode: "acceptEdits" },
};

function statusFor(
	integrity: "verified" | "failed" | "unknown",
	autonomy: "approximated" | "absent",
): CanonicalTrustStatus {
	return composeTrustStatus({
		artifactIntegrity: {
			state: integrity,
			source: { kind: "receipt_integrity_verification", id: "run-x" },
			authority: { kind: "clio", id: "receipt-integrity" },
			artifacts: [],
		},
		autonomyEnforcement:
			autonomy === "absent"
				? { state: "absent", reason: "not_observed" }
				: {
						state: autonomy,
						source: { kind: "run_receipt", id: "run-x" },
						authority: { kind: "runtime", id: "acceptEdits" },
						artifacts: [],
					},
	});
}

describe("contracts/evidence provenance is gated on the canonical projection", () => {
	it("admits every field set behind a verified seal and a recorded autonomy axis", () => {
		deepStrictEqual(admitRunProvenance(VIEW, statusFor("verified", "approximated")), VIEW);
		deepStrictEqual(provenanceTranscriptLines(VIEW, statusFor("verified", "approximated")), [
			"pipeline: step 2, input 32 bytes from run-up (not truncated)",
			"persona override: prompt hash 1b3fc16b2c4d...",
			"escalations: 2 requested, 0 approved, 1 denied, 1 timed out",
			"autonomy: auto-edit mode=acceptEdits",
		]);
		strictEqual(
			provenanceCompactSuffix(VIEW, statusFor("verified", "approximated")),
			" pipeline=step2 from=run-up in=32b persona=1b3fc16b2c4d... escalations=2req/0appr/1deny/1timeout autonomy=auto-edit/acceptEdits",
		);
	});

	it("never prints the axis word: that is the trust summary's line", () => {
		const lines = provenanceTranscriptLines(VIEW, statusFor("verified", "approximated")).join("\n");
		const suffix = provenanceCompactSuffix(VIEW, statusFor("verified", "approximated"));
		for (const word of ["approximated", "mediated", "enforced", "bypassed", "enforcement"]) {
			strictEqual(lines.includes(word), false, `${word} in ${lines}`);
			strictEqual(suffix.includes(word), false, `${word} in ${suffix}`);
		}
	});

	it("prints nothing from a receipt whose seal the projection rejected or left unknown", () => {
		for (const integrity of ["failed", "unknown"] as const) {
			deepStrictEqual(admitRunProvenance(VIEW, statusFor(integrity, "absent")), {});
			deepStrictEqual(provenanceTranscriptLines(VIEW, statusFor(integrity, "absent")), []);
			strictEqual(provenanceCompactSuffix(VIEW, statusFor(integrity, "absent")), "");
		}
	});

	it("withholds the autonomy detail when the projection withholds the axis, whatever the receipt says", () => {
		const admitted = admitRunProvenance(VIEW, statusFor("verified", "absent"));
		strictEqual("autonomyEnforcement" in admitted, false);
		strictEqual(provenanceCompactSuffix(VIEW, statusFor("verified", "absent")).includes("autonomy="), false);
	});

	it("admits no axis detail at all without a projection, and passes the non-axis provenance through", () => {
		deepStrictEqual(admitRunProvenance(VIEW), {
			pipeline: VIEW.pipeline,
			personaOverride: VIEW.personaOverride,
			escalation: VIEW.escalation,
		});
		strictEqual(provenanceCompactSuffix(VIEW).includes("autonomy"), false);
		strictEqual(
			provenanceTranscriptLines(VIEW).some((line) => line.startsWith("autonomy")),
			false,
		);
	});

	it("renders an empty view as nothing, with or without a projection", () => {
		deepStrictEqual(provenanceTranscriptLines({}, statusFor("verified", "approximated")), []);
		strictEqual(provenanceCompactSuffix({}), "");
	});
});
