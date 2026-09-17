import assert from "node:assert/strict";
import { test } from "node:test";
import { BusChannels, type DispatchCompletedPayload } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { inspectRunReceiptTrustStatus } from "../../src/domains/evidence/trust-status.js";
import type { ObservabilityRunReaders } from "../../src/domains/observability/contract.js";
import { emptyCostAggregate } from "../../src/domains/observability/cost.js";
import { createObservabilityProjection } from "../../src/domains/observability/projection.js";
import { createDispatchBoardStore } from "../../src/interactive/dispatch-board.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

test("only integrity-admitted receipt contract facts reach the board and lifecycle reset clears them", () => {
	const envelope = fixtureEnvelope("aa-run");
	const receipt = withReceiptIntegrity(fixtureReceiptDraft(envelope), envelope);
	const verified = inspectRunReceiptTrustStatus(receipt, envelope).status;
	const rejected = inspectRunReceiptTrustStatus({ ...receipt, task: "tampered" }, envelope).status;
	let facts: ReturnType<NonNullable<ObservabilityRunReaders["readReceipt"]>> = {
		text: '{"diagnosis":"Verified bytes","reproduction":"unknown","evidence":[]}',
		trust: verified,
		contract: "pass",
		contractKind: "debugger-report",
	};
	const bus = createSafeEventBus();
	const projection = createObservabilityProjection(bus, {
		readReceipt: () => facts,
		metrics: () => ({
			dispatchesCompleted: 0,
			dispatchesFailed: 0,
			safetyClassifications: 0,
			totalTokens: 0,
			histograms: {},
		}),
		sessionCost: () => 0,
		sessionCostSummary: emptyCostAggregate,
		sessionTokens: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, totalTokens: 0 }),
		latestThroughput: () => null,
		readAccountability: () => ({
			totalRuns: 0,
			firstPassRuns: 0,
			firstPassRate: 0,
			unverifiedSuccesses: 0,
			ungroundedClaims: 0,
			failureCauses: [],
		}),
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
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		costUsd: 0,
		durationMs: 1,
		exitCode: 0,
		toolActivity: null,
		outcome: "succeeded",
		outcomeCode: null,
		outcomeDetail: null,
	};
	try {
		bus.emit(BusChannels.DispatchCompleted, event);
		assert.deepEqual(projection.snapshot().runs[0]?.resultContract, { kind: "debugger-report", conformance: "pass" });
		store.reconcile();
		assert.deepEqual(store.rows()[0]?.resultContract, { kind: "debugger-report", conformance: "pass" });
		const prior = projection.snapshot();
		bus.emit(BusChannels.DispatchStarted, { ...event, pid: null, assignmentId: "aa-run", attempt: 1 });
		assert.equal(projection.snapshot().runs[0]?.resultContract, undefined);
		assert.deepEqual(prior.runs[0]?.resultContract, { kind: "debugger-report", conformance: "pass" });
		facts = { text: "tampered answer", trust: rejected, contract: "pass", contractKind: "debugger-report" };
		bus.emit(BusChannels.DispatchCompleted, event);
		assert.equal(projection.snapshot().runs[0]?.resultContract, undefined);
		assert.doesNotMatch(projection.snapshot().runs[0]?.progress?.tailText ?? "", /tampered answer/);
		facts = {
			text: "trusted bytes, failed contract",
			trust: verified,
			contract: "fail",
			contractKind: "debugger-report",
		};
		bus.emit(BusChannels.DispatchCompleted, event);
		assert.deepEqual(projection.snapshot().runs[0]?.resultContract, { kind: "debugger-report", conformance: "fail" });
		facts = null;
		bus.emit(BusChannels.DispatchCompleted, event);
		assert.equal(projection.snapshot().runs[0]?.resultContract, undefined);
	} finally {
		store.unsubscribe();
		projection.stop();
	}
});
