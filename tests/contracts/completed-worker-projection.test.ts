import assert from "node:assert/strict";
import { test } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { DispatchCompletedPayload } from "../../src/core/telemetry/live-events.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { inspectRunReceiptTrustStatus } from "../../src/domains/evidence/trust-status.js";
import type { TelemetryRunReaders } from "../../src/domains/telemetry/contract.js";
import { createTelemetryProjection } from "../../src/domains/telemetry/projection.js";
import { createDispatchBoardStore } from "../../src/interactive/dispatch-board.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

test("only integrity-admitted receipt contract facts reach the board and lifecycle reset clears them", () => {
	const envelope = fixtureEnvelope("aa-run");
	const receipt = withReceiptIntegrity(fixtureReceiptDraft(envelope), envelope);
	const verified = inspectRunReceiptTrustStatus(receipt, envelope).status;
	const rejected = inspectRunReceiptTrustStatus({ ...receipt, task: "tampered" }, envelope).status;
	let facts: ReturnType<NonNullable<TelemetryRunReaders["readReceipt"]>> = {
		text: '{"diagnosis":"Verified bytes","reproduction":"unknown","evidence":[]}',
		trust: verified,
		contract: "pass",
		contractKind: "debugger-report",
	};
	const bus = createTelemetryHub();
	const projection = createTelemetryProjection(bus, {
		readReceipt: () => facts,
		latestThroughput: () => null,
	});
	const store = createDispatchBoardStore(projection);
	const event: DispatchCompletedPayload = {
		runId: "aa-run",
		agentId: "debugger",
		targetId: "test",
		wireModelId: "test",
		runtimeId: "test",
		runtimeKind: "http",
		requestOrigin: "user",
		lineage: { rootRunId: "aa-run", parentRunId: null, attempt: 0, depth: 0 },
		tokenCount: 0,
		inputTokenCount: 0,
		outputTokenCount: 0,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: 0,
		durationMs: 1,
		exitCode: 0,
		toolActivity: null,
		outcome: "succeeded",
		outcomeCode: null,
		outcomeDetail: null,
	};
	try {
		bus.emit("run.completed", event);
		assert.deepEqual(projection.snapshot().runs[0]?.resultContract, { kind: "debugger-report", conformance: "pass" });
		store.reconcile();
		assert.deepEqual(store.rows()[0]?.resultContract, { kind: "debugger-report", conformance: "pass" });
		const prior = projection.snapshot();
		bus.emit("run.started", { ...event, pid: null, assignmentId: "aa-run", attempt: 1 });
		assert.equal(projection.snapshot().runs[0]?.resultContract, undefined);
		assert.deepEqual(prior.runs[0]?.resultContract, { kind: "debugger-report", conformance: "pass" });
		facts = { text: "tampered answer", trust: rejected, contract: "pass", contractKind: "debugger-report" };
		bus.emit("run.completed", event);
		assert.equal(projection.snapshot().runs[0]?.resultContract, undefined);
		assert.doesNotMatch(projection.snapshot().runs[0]?.progress?.tailText ?? "", /tampered answer/);
		facts = {
			text: "trusted bytes, failed contract",
			trust: verified,
			contract: "fail",
			contractKind: "debugger-report",
		};
		bus.emit("run.completed", event);
		assert.deepEqual(projection.snapshot().runs[0]?.resultContract, { kind: "debugger-report", conformance: "fail" });
		facts = null;
		bus.emit("run.completed", event);
		assert.equal(projection.snapshot().runs[0]?.resultContract, undefined);
	} finally {
		store.unsubscribe();
		projection.stop();
	}
});
