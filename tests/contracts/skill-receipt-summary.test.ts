import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { isSkillActivation, skillActivationFromToolDetails } from "../../src/core/skill-activation.js";
import { verifyReceiptIntegrity, withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { compactHelperResultLines, receiptEvidenceLabels } from "../../src/tools/worker-evidence.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

function activation(name: string, source?: "recipe" | "model" | "operator") {
	const value = skillActivationFromToolDetails({
		name,
		path: `/private/skills/${name}/SKILL.md`,
		hash: "a".repeat(64),
		source: "path",
		...(source ? { activation: source } : {}),
	});
	ok(value);
	return value;
}

describe("worker receipt skill load summary", () => {
	it("carries recipe binding provenance and separates loading from commits", () => {
		const envelope = fixtureEnvelope("skill-run");
		const draft = fixtureReceiptDraft(envelope);
		draft.skillActivations = [activation("fix-issue", "recipe"), activation("ship", "recipe")];
		strictEqual(draft.skillActivations[0]?.requestSource, "recipe");
		const receipt = withReceiptIntegrity(draft, envelope);
		const integrity = verifyReceiptIntegrity(receipt, envelope);
		ok(integrity.ok);
		const summary = receiptEvidenceLabels(receipt, receipt.verification, integrity).join("\n");
		match(summary, /skill loads \(2\): "fix-issue" \(recipe-bound\), "ship" \(recipe-bound\)/);
		match(summary, /Activation records a load, not execution of the skill workflow or a commit/);
		ok(!summary.includes("/private/skills/"), "receipt summary must not disclose skill paths");
		const loads = receipt.skillActivations;
		ok(loads);
		const forgedOrigin = {
			...receipt,
			skillActivations: loads.map((item) => ({ ...item, requestSource: "operator" as const })),
		};
		strictEqual(verifyReceiptIntegrity(forgedOrigin, envelope).ok, false);
	});

	it("bounds names and marks old receipts without binding provenance as unknown", () => {
		const envelope = fixtureEnvelope("legacy-skill-run");
		const draft = fixtureReceiptDraft(envelope);
		const legacy = activation("ship");
		ok(isSkillActivation(legacy));
		draft.skillActivations = [
			legacy,
			...Array.from({ length: 100 }, (_, i) => activation(`long-${i}-${"x".repeat(100)}`, "recipe")),
		];
		const receipt = withReceiptIntegrity(draft, envelope);
		const labels = receiptEvidenceLabels(receipt, receipt.verification, verifyReceiptIntegrity(receipt, envelope));
		const line = labels.find((item) => item.startsWith("skill loads"));
		ok(line);
		match(line, /"ship" \(binding unrecorded\)/);
		match(line, /and 95 more/);
		ok(Buffer.byteLength(line, "utf8") < 700, `summary was ${Buffer.byteLength(line, "utf8")} bytes`);
		const tampered = { ...receipt, task: "forged" };
		const invalid = receiptEvidenceLabels(tampered, tampered.verification, verifyReceiptIntegrity(tampered, envelope));
		ok(!invalid.some((item) => item.startsWith("skill loads")), "untrusted activations must be withheld");
	});

	it("keeps the same clarification in compact helper receipt summaries", () => {
		const envelope = fixtureEnvelope("helper-skill-run");
		const draft = fixtureReceiptDraft(envelope);
		const structured = {
			version: 1 as const,
			kind: "provenance-report" as const,
			data: { confirmedFacts: [], missingEvidence: [], nextInspections: [] },
		};
		const text = JSON.stringify(structured.data);
		draft.output = { state: "final", text, bytes: Buffer.byteLength(text), truncated: false, structured };
		draft.quality.resultContract = {
			sourceId: "agent-result-contract:provenance-report",
			validatorDigest: "a".repeat(64),
			conformance: "pass",
			quality: "unmeasured",
		};
		draft.skillActivations = [activation("ship", "recipe")];
		const receipt = withReceiptIntegrity(draft, envelope);
		const lines = compactHelperResultLines(receipt, verifyReceiptIntegrity(receipt, envelope), 1024);
		ok(lines);
		match(lines.join("\n"), /skill loads \(1\): "ship" \(recipe-bound\).*not execution.*or a commit/);
	});
});
