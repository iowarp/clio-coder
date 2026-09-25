import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { verifyReceiptIntegrity, withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { isLegacyReadOnlyReceipt } from "../../src/domains/dispatch/types.js";
import {
	inspectRunReceiptTrustStatus,
	TRUST_STATUS_AXES,
	validateTrustStatus,
} from "../../src/domains/evidence/trust-status.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

test("a sealed legacy autonomy block verifies while trust projects five axes", () => {
	const envelope = fixtureEnvelope("legacy-autonomy");
	const draft = {
		...fixtureReceiptDraft(envelope),
		autonomyEnforcement: { grade: "approximated", autonomy: "read-only", externalMode: "read-only" },
	} as RunReceiptDraft;
	const receipt = withReceiptIntegrity(draft, envelope);
	deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
	equal(isLegacyReadOnlyReceipt(receipt), true);
	equal(isLegacyReadOnlyReceipt({ ...receipt, autonomy: "default" }), false);
	const projection = inspectRunReceiptTrustStatus(receipt, envelope);
	equal(projection.integrity.ok, true);
	equal(projection.status.artifactIntegrity.state, "verified");
	equal(TRUST_STATUS_AXES.length, 5);
	ok(!Object.hasOwn(projection.status, "autonomyEnforcement"));
	const historical = { ...projection.status, autonomyEnforcement: { state: "absent", reason: "not_recorded" } };
	const parsed = validateTrustStatus(historical);
	equal(parsed.ok, true);
	if (parsed.ok) ok(!Object.hasOwn(parsed.status, "autonomyEnforcement"));
});
