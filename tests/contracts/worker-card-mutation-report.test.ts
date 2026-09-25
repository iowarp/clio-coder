import assert from "node:assert/strict";
import { test } from "node:test";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { inspectRunReceiptTrustStatus } from "../../src/domains/evidence/trust-status.js";
import { WORKER_LIVE_TAIL_MAX_BYTES } from "../../src/domains/observability/worker-progress.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { renderWorkerEntryLines } from "../../src/interactive/renderers/worker-entry.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";
import { createWorkerStream, type WorkerReceiptFacts } from "../../src/interactive/worker-stream.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

/**
 * BT-011: a coder run ended with its mutation report, one JSON line of about
 * 5 KB. The live tail keeps 4 KB, so streaming it cut the head and counted the
 * cut bytes. Settling replaced the tail with the sealed answer but kept that
 * count, and the card read the stale count as a truncated answer and drew the
 * raw JSON as its three summary rows.
 */
const report = {
	mutatedPaths: ["lib/math.js", "test/math.test.js"],
	validations: [
		{ name: "npm test (before implementation, red)", passed: false, evidence: `exited 1: ${"stack ".repeat(400)}` },
		{ name: "npm test (after implementation)", passed: true, evidence: "verify check=test exited 0" },
	],
	summary: `Added clamp(value, min, max). ${"Rationale. ".repeat(200)}`,
};
const text = JSON.stringify(report);

function verifiedFacts(runId: string): WorkerReceiptFacts {
	const envelope = fixtureEnvelope(runId);
	const draft = fixtureReceiptDraft(envelope);
	draft.output = { text, truncated: false, state: "final", bytes: Buffer.byteLength(text) };
	const trust = inspectRunReceiptTrustStatus(withReceiptIntegrity(draft, envelope), envelope).status;
	return { trust, outcome: "succeeded", exitCode: 0, text };
}

test("a mutation report that outgrew the live tail settles into prose, not raw JSON (BT-011)", () => {
	assert.ok(Buffer.byteLength(text) > WORKER_LIVE_TAIL_MAX_BYTES, "the answer must be longer than the live tail");
	const stream = createWorkerStream({ readReceipt: (runId) => verifiedFacts(runId) });
	const started = stream.started({
		runId: "bt011-run",
		assignmentId: "bt011",
		attempt: 0,
		requestOrigin: "user",
		agentId: "coder",
		targetId: "local",
		wireModelId: "worker-model",
		runtimeId: "openai",
		runtimeKind: "http",
		pid: 1,
	} as never);
	assert.ok(started, "the worker opens a block");
	const streamed = stream.progress({
		runId: "bt011-run",
		agentId: "coder",
		event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
	});
	assert.ok((streamed?.entry.progress?.droppedBytes ?? 0) > 0, "the live tail cut the head of the one-line answer");
	const settled = stream.completed({
		runId: "bt011-run",
		outcome: "succeeded",
		outcomeCode: null,
		outcomeDetail: null,
		tokenCount: 1,
		durationMs: 1,
		exitCode: 0,
		toolActivity: null,
	} as never);
	assert.ok(settled, "the worker settles");
	assert.equal(settled.entry.text, text, "the sealed answer replaces the live tail");
	for (const width of [80, 144]) {
		const rows = renderWorkerEntryLines(settled.entry, width, { detail: transcriptDetail("standard") });
		const plain = rows.map(stripTerminalSequences).join("\n");
		assert.doesNotMatch(plain, /\{"mutatedPaths"|"validations"/u, `${width}: ${plain}`);
		assert.match(plain, /changed lib\/math\.js, test\/math\.test\.js/u, `${width}: ${plain}`);
		for (const row of rows) assert.ok(visibleWidth(row) <= width, `${width}: ${stripTerminalSequences(row)}`);
	}
	assert.equal(settled.entry.progress?.droppedBytes, 0, "the sealed answer lost no bytes");
});
