import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { verifyReceiptIntegrity, withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import {
	compactHelperResultLines,
	receiptEvidenceLabels,
	receiptHelperResult,
} from "../../src/tools/worker-evidence.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

test("compact helper consumption preserves unmeasured quality and withholds failed or altered handoffs", () => {
	const envelope = fixtureEnvelope("helper-consumption");
	const draft = fixtureReceiptDraft(envelope);
	ok(draft.quality);
	const structured = {
		version: 1 as const,
		kind: "provenance-report" as const,
		data: { confirmedFacts: [], missingEvidence: ["No validation receipt"], nextInspections: [] },
	};
	const text = JSON.stringify(structured.data);
	const receipt = withReceiptIntegrity(
		{
			...draft,
			quality: {
				...draft.quality,
				resultContract: {
					sourceId: "agent-result-contract:provenance-report",
					validatorDigest: "a".repeat(64),
					conformance: "pass",
					quality: "unmeasured",
				},
			},
			output: { state: "final", text, bytes: Buffer.byteLength(text), truncated: false, structured },
		},
		envelope,
	);
	const integrity = verifyReceiptIntegrity(receipt, envelope);
	deepStrictEqual(receiptHelperResult(receipt, integrity), structured);
	const lines = compactHelperResultLines(receipt, integrity, 1024);
	ok(lines);
	ok(receipt.output);
	match(lines.join("\n"), /quality=unmeasured/);
	match(lines.join("\n"), /No validation receipt/);
	match(lines.join("\n"), /factual accuracy is unmeasured/);
	strictEqual(lines.length, 4);
	const altered = {
		...receipt,
		output: { ...receipt.output, structured: { ...structured, data: { confirmedFacts: ["invented"] } } },
	};
	strictEqual(receiptHelperResult(altered, verifyReceiptIntegrity(altered, envelope)), null);
	for (const patch of [
		{ exitCode: 1 },
		{ outcome: "failed" as const },
		{ output: { ...receipt.output, state: "partial" as const } },
		{ output: { ...receipt.output, truncated: true } },
	]) {
		const failed = withReceiptIntegrity({ ...receipt, ...patch }, envelope);
		strictEqual(receiptHelperResult(failed, verifyReceiptIntegrity(failed, envelope)), null);
	}
	const legacy = withReceiptIntegrity(draft, envelope);
	strictEqual(receiptHelperResult(legacy, verifyReceiptIntegrity(legacy, envelope)), null);
});

test("host check labels distinguish actual execution from reused evidence and worker claims", () => {
	const envelope = fixtureEnvelope("host-check-labels");
	for (const memo of [false, true]) {
		const receipt = withReceiptIntegrity(
			{
				...fixtureReceiptDraft(envelope),
				hostVerification: {
					status: "verified",
					checks: [
						{ check: "test", argv: ["npm", "test"], cwd: "/fixture", exitCode: 0, durationMs: 1, memo, outputTail: "pass" },
					],
				},
			},
			envelope,
		);
		const labels = receiptEvidenceLabels(
			receipt,
			{ state: "verified", basis: "validation-tool" },
			verifyReceiptIntegrity(receipt, envelope),
		).join("\n");
		match(labels, /Host check evidence is separate from the worker report/);
		match(labels, memo ? /reused prior host result; exit 0/ : /executed after the worker; exit 0/);
	}
});
