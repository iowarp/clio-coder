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
	match(lines.join("\n"), /factual accuracy is not measured/);
	strictEqual(lines.length, 4);
	// FX-4: a helper result still carries the run's work counters, so an edit task that changed nothing reads so.
	const counted = compactHelperResultLines(
		finishedRun({
			...receipt,
			toolActivity: { calls: 2, succeeded: 1, failed: 0, blocked: 1, mutatingSucceeded: false },
		}),
		PRODUCER_INTEGRITY,
		1024,
	);
	match(
		counted?.join("\n") ?? "",
		/\n {2}work=calls:2 ok:1 failed:0 blocked:1 mutations:no\n {2}mutation_effect=none\n/u,
	);
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

test("a helper result past its byte budget shows whole leading findings, the count and bytes shown, and the record call (XR-62)", () => {
	const envelope = fixtureEnvelope("helper-findings-cut");
	const draft = fixtureReceiptDraft(envelope);
	ok(draft.quality);
	const findings = Array.from({ length: 40 }, (_, index) => ({
		claim: `finding ${index} ${"detail ".repeat(20)}`,
		evidence: `src/a.ts:${index + 1}`,
	}));
	const structured = { version: 1 as const, kind: "scout-report" as const, data: { findings } };
	const text = JSON.stringify(structured.data);
	const receipt = finishRunResult(
		{
			...draft,
			quality: {
				...draft.quality,
				resultContract: {
					sourceId: "agent-result-contract:scout-report",
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
	const run = finishedRun(receipt);
	ok(runHelperResult(run, PRODUCER_INTEGRITY), "the scout report is a helper result");
	const cut = compactHelperResultLines(run, PRODUCER_INTEGRITY, 2000)?.join("\n") ?? "";
	const notice = new RegExp(
		`helper result excerpt: showing (\\d+) of 40 findings, (\\d+) of ${Buffer.byteLength(text)} bytes; the whole result is in monitor\\(mode="record", run_id="${receipt.runId}"\\)`,
		"u",
	);
	const shown = notice.exec(cut);
	ok(shown, cut);
	ok(Number(shown[1]) > 0 && Number(shown[1]) < 40 && Number(shown[2]) <= 2000, cut);
	ok(cut.includes(`"finding ${Number(shown[1]) - 1} `) && !cut.includes(`"finding ${shown[1]} `), cut);
	const whole = compactHelperResultLines(run, PRODUCER_INTEGRITY, 12_000)?.join("\n") ?? "";
	ok(whole.includes("finding 39 ") && !whole.includes("excerpt"), whole);
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
						{
							check: "test",
							argv: ["npm", "test"],
							cwd: "/fixture",
							exitCode: 0,
							durationMs: 1,
							memo,
							outputTail: "pass",
							...(memo ? { evidenceRunId: "earlier" } : {}),
						},
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
		match(labels, memo ? /reused a pass from run earlier; exit 0/ : /executed after the worker; exit 0/);
	}
});
