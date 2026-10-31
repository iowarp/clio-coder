import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";

import {
	compactHelperResultLines,
	finishedRun,
	PRODUCER_INTEGRITY,
	runEvidenceLabels,
	runHelperResult,
} from "../../src/tools/worker-evidence.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

test("compact helper consumption preserves unmeasured quality and withholds failed or unauthenticated handoffs", () => {
	const envelope = fixtureEnvelope("helper-consumption");
	const draft = fixtureReceiptDraft(envelope);
	ok(draft.quality);
	const structured = {
		version: 1 as const,
		kind: "provenance-report" as const,
		data: { confirmedFacts: [], missingEvidence: ["No validation receipt"], nextInspections: [] },
	};
	const text = JSON.stringify(structured.data);
	const receipt = finishRunResult(
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
		{ terminal: { terminalReason: "completed" }, processExitCode: envelope.exitCode, frameType: null, usage: undefined },
	).result;
	deepStrictEqual(runHelperResult(finishedRun(receipt), PRODUCER_INTEGRITY), structured);
	const lines = compactHelperResultLines(finishedRun(receipt), PRODUCER_INTEGRITY, 1024);
	ok(lines);
	ok(receipt.output);
	match(lines.join("\n"), /quality=unmeasured/);
	match(lines.join("\n"), /No validation receipt/);
	match(lines.join("\n"), /factual accuracy is unmeasured/);
	strictEqual(lines.length, 4);
	strictEqual(runHelperResult(finishedRun(receipt), { state: "failed", reason: "run seal failed" }), null);
	for (const patch of [
		{ exitCode: 1 },
		{ outcome: "failed" as const },
		{ output: { ...receipt.output, state: "partial" as const } },
		{ output: { ...receipt.output, truncated: true } },
	]) {
		strictEqual(runHelperResult(finishedRun({ ...receipt, ...patch }), PRODUCER_INTEGRITY), null);
	}
	strictEqual(runHelperResult(finishedRun(draft), PRODUCER_INTEGRITY), null);
});

test("host check labels distinguish actual execution from reused evidence and worker claims", () => {
	const envelope = fixtureEnvelope("host-check-labels");
	for (const memo of [false, true]) {
		const receipt = finishRunResult(
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
			{ terminal: { terminalReason: "completed" }, processExitCode: envelope.exitCode, frameType: null, usage: undefined },
		).result;
		const labels = runEvidenceLabels(
			finishedRun({ ...receipt, verification: { state: "verified", basis: "validation-tool" } }),
			PRODUCER_INTEGRITY,
		).join("\n");
		match(labels, /Host check evidence is separate from the worker report/);
		match(labels, memo ? /reused prior host result; exit 0/ : /executed after the worker; exit 0/);
	}
});
