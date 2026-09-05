import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BusChannels, type DispatchCompletedPayload, type DispatchEnqueuedPayload } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { resolveToolBudgetEnvelope } from "../../src/domains/dispatch/budget-envelope.js";
import type { DispatchSnapshot } from "../../src/domains/dispatch/contract.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { inspectRunReceiptTrustStatus } from "../../src/domains/evidence/trust-status.js";
import type { ObservabilityRunReaders, ObservabilityRunSummary } from "../../src/domains/observability/contract.js";
import { emptyCostAggregate } from "../../src/domains/observability/cost.js";
import {
	createObservabilityProjection,
	MAX_PROJECTION_RUNS,
	type ObservabilityProjection,
} from "../../src/domains/observability/projection.js";
import {
	createDispatchBoardStore,
	createDispatchBoardView,
	type DispatchBoardRow,
} from "../../src/interactive/dispatch-board.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

const IDENTITY: DispatchEnqueuedPayload = {
	runId: "board-run",
	agentId: "coder",
	agentAudience: "shadow",
	requestOrigin: "user",
	targetId: "local",
	wireModelId: "test-model",
	runtimeId: "native",
	runtimeKind: "http",
	budget: resolveToolBudgetEnvelope({
		recipeId: "coder",
		policy: { toolCalls: 12, readReserve: 3, synthesis: true },
		hardCap: 20,
		hasReadTool: true,
		retry: false,
		revision: false,
	}),
	task: "Inspect\n\u001b[31mthe parser\u001b[0m",
	node: "node-a",
	gate: { role: "reviewer", cycle: 2 },
	endpoint: { key: "endpoint-key", label: "local endpoint", limit: 2 },
	council: { group: "council", label: "Alpha", color: "blue", round: 2 },
	rerouteCount: 2,
	contextWindow: 8192,
};
const COMPLETED: DispatchCompletedPayload = {
	...IDENTITY,
	lineage: { rootRunId: IDENTITY.runId, parentRunId: null, attempt: 0, depth: 0 },
	tokenCount: 123,
	inputTokenCount: 80,
	outputTokenCount: 30,
	cacheReadTokenCount: 10,
	cacheWriteTokenCount: 3,
	reasoningTokenCount: 7,
	costUsd: 0.25,
	costProvenance: "estimated",
	durationMs: 1500,
	exitCode: 0,
	staticShellHash: null,
	sessionShellHash: null,
	dynamicHash: null,
	toolActivity: null,
	outcome: "succeeded",
	outcomeCode: null,
	outcomeDetail: "canonical completion detail",
	hostVerification: "verified",
};

const projections: ObservabilityProjection[] = [];
afterEach(() => {
	for (const projection of projections.splice(0)) projection.stop();
});

function setup(readers: ObservabilityRunReaders = {}) {
	const bus = createSafeEventBus();
	const projection = createObservabilityProjection(bus, {
		...readers,
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
	projections.push(projection);
	const board = createDispatchBoardStore(projection);
	const progress = (event: unknown) =>
		bus.emit(BusChannels.DispatchProgress, { runId: IDENTITY.runId, agentId: IDENTITY.agentId, event });
	const start = () =>
		bus.emit(BusChannels.DispatchStarted, { ...IDENTITY, pid: null, assignmentId: IDENTITY.runId, attempt: 0 });
	return { bus, projection, board, progress, start };
}

/** Wait for the projection's existing coalesced publication, with no board reconciliation shortcut. */
function nextRevision(projection: ObservabilityProjection, previous: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let unsubscribe = () => {};
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error("projection did not publish"));
		}, 1000);
		unsubscribe = projection.subscribe((snapshot) => {
			if (snapshot.revision <= previous) return;
			// subscribe publishes immediately; let its unsubscribe assignment finish.
			queueMicrotask(() => {
				clearTimeout(timeout);
				unsubscribe();
				resolve();
			});
		});
	});
}

function commonRow(row: DispatchBoardRow) {
	return {
		runId: row.runId,
		agentId: row.agentId,
		status: row.status,
		input: row.inputTokens,
		output: row.outputTokens,
		total: row.tokenCount,
		cost: row.costUsd,
		detail: row.outcomeDetail,
		phase: row.phase,
		progress: row.progress,
	};
}
function commonSummary(row: ObservabilityRunSummary) {
	return {
		runId: row.runId,
		agentId: row.agentId,
		status: row.status,
		input: row.tokens.input,
		output: row.tokens.output,
		total: row.tokens.total,
		cost: row.costUsd,
		detail: row.outcomeDetail,
		phase: row.phase,
		progress: row.progress,
	};
}

describe("dispatch board uses the observability projection", () => {
	it("publishes all five dispatch events and evidenceReady through one fold", async () => {
		const { bus, projection, board, progress, start } = setup();
		for (const channel of [
			BusChannels.DispatchEnqueued,
			BusChannels.DispatchStarted,
			BusChannels.DispatchProgress,
			BusChannels.DispatchCompleted,
			BusChannels.DispatchFailed,
			BusChannels.AccountabilityEvidenceReady,
		]) {
			strictEqual(bus.listeners(channel).length, 1, `${channel} must have only the projection fold`);
		}
		const events = [
			() => bus.emit(BusChannels.DispatchEnqueued, IDENTITY),
			start,
			() =>
				progress({
					type: "message_end",
					message: { role: "assistant", usage: { input: 4, cacheRead: 2, output: 3, cacheWrite: 1 } },
				}),
			() => bus.emit(BusChannels.DispatchCompleted, COMPLETED),
			() =>
				bus.emit(BusChannels.DispatchFailed, {
					...COMPLETED,
					runId: "failed-run",
					council: undefined,
					outcome: "failed" as const,
					reason: "failed" as const,
					outcomeDetail: "check failed",
				}),
			() =>
				bus.emit(BusChannels.AccountabilityEvidenceReady, {
					runId: IDENTITY.runId,
					evidenceId: "run-board-run",
					firstPassSuccess: true,
					findingCount: 2,
					tags: ["session-linked"],
				}),
		];
		for (const publish of events) {
			const previous = projection.snapshot().revision;
			const flushed = nextRevision(projection, previous);
			publish();
			await flushed;
			deepStrictEqual(
				board
					.rows()
					.map(commonRow)
					.sort((a, b) => a.runId.localeCompare(b.runId)),
				projection
					.snapshot()
					.runs.map(commonSummary)
					.sort((a, b) => a.runId.localeCompare(b.runId)),
			);
		}
		const view = createDispatchBoardView(
			() => board.rows(),
			() => projection.snapshot(),
		);
		const rendered = view.render(180).join("\n");
		match(rendered, /coder/);
		match(rendered, /check failed/);
		strictEqual(projection.snapshot().runs.find((row) => row.runId === IDENTITY.runId)?.evidence?.findingCount, 2);
		board.unsubscribe();
		strictEqual(bus.listeners(BusChannels.DispatchCompleted).length, 1);
	});

	it("preserves every board field through the projection and keeps snapshots immutable", () => {
		const envelope = fixtureEnvelope(IDENTITY.runId);
		const receipt = withReceiptIntegrity(fixtureReceiptDraft(envelope), envelope);
		const trust = inspectRunReceiptTrustStatus(receipt, envelope).status;
		let receiptAvailable = true;
		const { bus, projection, board, progress, start } = setup({
			readReceipt: () => (receiptAvailable ? { text: "sealed answer", trust } : null),
		});
		board.setFleetPhase(IDENTITY.runId, { wave: 3, stepId: "parser" });
		bus.emit(BusChannels.DispatchEnqueued, IDENTITY);
		start();
		progress({ type: "attempt_start" });
		progress({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "working" } });
		progress({ type: "clio_coder_tool_start", payload: { tool: "read", toolCallId: "call-1" } });
		progress({ type: "clio_coder_tool_finish", payload: { tool: "read", toolCallId: "call-1" } });
		progress({ type: "clio_coder_tool_start", payload: { tool: "grep", toolCallId: "call-2" } });
		progress({ type: "clio_coder_steer_received", payload: { chars: 24 } });
		progress({
			type: "clio_coder_write_record_downgraded",
			payload: { reason: "opaque_tool_succeeded", tool: "bash", toolCallId: "call-3" },
		});
		progress({ type: "message_end", message: { role: "assistant", usage: { input: 4, cacheRead: 2, output: 3 } } });
		board.reconcile();
		strictEqual(board.rows()[0]?.currentTool, "grep");
		deepStrictEqual(board.rows()[0]?.recentTools, ["read"]);
		const prior = projection.snapshot();
		bus.emit(BusChannels.DispatchCompleted, COMPLETED);
		board.reconcile();
		const row = board.rows()[0];
		ok(row);
		deepStrictEqual(
			{
				runId: row.runId,
				agentId: row.agentId,
				audience: row.agentAudience,
				origin: row.requestOrigin,
				runtimeKind: row.runtimeKind,
				runtimeId: row.runtimeId,
				target: row.targetId,
				model: row.wireModelId,
				node: row.node,
				gate: row.gate,
				council: row.council,
				endpoint: row.endpoint,
				reroutes: row.rerouteCount,
				contextWindow: row.contextWindow,
				contextTokens: row.lastContextTokens,
				phase: row.phase,
				receipt: row.receiptId,
				host: row.hostVerification,
				hops: row.failoverHops,
				elapsed: row.elapsedMs,
				input: row.inputTokens,
				output: row.outputTokens,
				tokens: row.tokenCount,
				cost: row.costUsd,
				pricing: row.costProvenance,
				detail: row.outcomeDetail,
			},
			{
				runId: IDENTITY.runId,
				agentId: "coder",
				audience: "shadow",
				origin: "user",
				runtimeKind: "http",
				runtimeId: "native",
				target: "local",
				model: "test-model",
				node: "node-a",
				gate: IDENTITY.gate,
				council: IDENTITY.council,
				endpoint: IDENTITY.endpoint,
				reroutes: 2,
				contextWindow: 8192,
				contextTokens: 9,
				phase: { wave: 3, stepId: "parser" },
				receipt: IDENTITY.runId,
				host: "verified",
				hops: 1,
				elapsed: 1500,
				input: 90,
				output: 30,
				tokens: 123,
				cost: 0.25,
				pricing: "estimated",
				detail: COMPLETED.outcomeDetail,
			},
		);
		deepStrictEqual(row.budget, IDENTITY.budget);
		ok(row.taskSummary?.includes("parser"));
		ok(!row.taskSummary?.includes("\u001b"));
		ok(row.ttftMs !== null && row.ttftMs >= 0);
		strictEqual(row.progress?.tailText, "sealed answer");
		deepStrictEqual(row.trust, projection.snapshot().runs[0]?.trust);
		strictEqual(row.steerAcknowledgement?.chars, 24);
		deepStrictEqual(row.writeRecordDowngrade, { reason: "opaque_tool_succeeded", tool: "bash", toolCallId: "call-3" });
		strictEqual(prior.runs[0]?.status, "running");
		strictEqual(prior.runs[0]?.tokens.total, 9);
		strictEqual(prior.runs[0]?.progress?.currentAction?.tool, "grep");
		const action = row.progress?.recentActions[0];
		if (action) action.tool = "mutated snapshot";
		ok(!projection.snapshot().runs[0]?.progress?.recentActions.some((action) => action.tool === "mutated snapshot"));
		receiptAvailable = false;
		bus.emit(BusChannels.DispatchCompleted, COMPLETED);
		board.reconcile();
		strictEqual(board.rows()[0]?.trust, undefined, "a missing receipt must not retain a previous trust verdict");
	});

	it("uses canonical terminal status, finite counters, and outcome detail when old folds disagreed", () => {
		const { bus, projection, board, progress, start } = setup();
		start();
		progress({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
		board.reconcile();
		strictEqual(board.rows()[0]?.status, "running");
		progress({ type: "heartbeat_status", status: "dead" });
		bus.emit(BusChannels.DispatchFailed, {
			...COMPLETED,
			outcome: "failed",
			reason: "failed",
			outcomeDetail: null,
			inputTokenCount: Number.NaN,
			outputTokenCount: Number.POSITIVE_INFINITY,
		});
		board.reconcile();
		strictEqual(board.rows()[0]?.status, "failed");
		strictEqual(board.rows()[0]?.outcomeDetail, null);
		strictEqual(board.rows()[0]?.inputTokens, 10);
		strictEqual(board.rows()[0]?.outputTokens, 0);
		deepStrictEqual(board.rows().map(commonRow), projection.snapshot().runs.map(commonSummary));
	});

	it("folds live counters, retry timers, and cancellation in the projection", () => {
		const live: DispatchSnapshot = {
			generatedAt: "2026-09-05T00:00:00Z",
			running: [],
			retrying: [],
			totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
		};
		const { bus, projection, board, start } = setup({ dispatchSnapshot: () => live });
		start();
		live.running.push({
			runId: IDENTITY.runId,
			agentId: "coder",
			runtimeKind: "http",
			outcomePhase: "running",
			heartbeat: "alive",
			lineage: COMPLETED.lineage,
			startedAt: live.generatedAt,
			elapsedMs: 50,
			tokens: { input: 12, output: 3, total: 15 },
			costUsd: 0.12,
			costProvenance: "estimated",
			node: null,
		});
		board.reconcile();
		strictEqual(projection.snapshot().runs[0]?.tokens.total, 15);
		strictEqual(board.rows()[0]?.tokenCount, 15);
		live.running = [];
		bus.emit(BusChannels.DispatchFailed, { ...COMPLETED, outcome: "failed", reason: "failed" });
		live.retrying.push({
			runId: IDENTITY.runId,
			agentId: "coder",
			attempt: 1,
			dueAt: "2026-09-05T00:01:00Z",
			reason: "retry",
		});
		board.reconcile();
		strictEqual(projection.snapshot().runs[0]?.status, "retrying");
		strictEqual(board.activeRows()[0]?.retry?.attempt, 1);
		bus.emit(BusChannels.RunAborted, {
			source: "dispatch_abort",
			runId: IDENTITY.runId,
			startedAt: null,
			elapsedMs: null,
			reason: "operator canceled retry",
		});
		live.retrying = [];
		board.reconcile();
		strictEqual(board.rows()[0]?.status, "aborted");
		strictEqual(board.activeRows().length, 0);
	});

	it("detaches the board subscription without stopping the shared projection", async () => {
		const { bus, projection, board } = setup();
		board.unsubscribe();
		const published = nextRevision(projection, projection.snapshot().revision);
		bus.emit(BusChannels.DispatchEnqueued, IDENTITY);
		await published;
		strictEqual(board.rows().length, 0);
		strictEqual(projection.snapshot().runs.length, 1);
		strictEqual(bus.listeners(BusChannels.DispatchEnqueued).length, 1);
	});

	it("does not settle worker progress on a rejected receipt's answer", () => {
		const envelope = fixtureEnvelope(IDENTITY.runId);
		const receipt = withReceiptIntegrity(fixtureReceiptDraft(envelope), envelope);
		receipt.task = "tampered";
		const trust = inspectRunReceiptTrustStatus(receipt, envelope).status;
		const { bus, board, progress, start } = setup({ readReceipt: () => ({ text: "untrusted receipt answer", trust }) });
		start();
		progress({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "observed live tail" } });
		bus.emit(BusChannels.DispatchCompleted, COMPLETED);
		board.reconcile();
		strictEqual(board.rows()[0]?.trust?.verdict, "compromised");
		ok(!board.rows()[0]?.progress?.tailText.includes("untrusted receipt answer"));
	});

	it("keeps the projection's bounded FIFO run window", () => {
		const { bus, projection, board } = setup();
		for (let i = 0; i <= MAX_PROJECTION_RUNS; i += 1)
			bus.emit(BusChannels.DispatchEnqueued, { ...IDENTITY, runId: `run-${i}` });
		board.reconcile();
		strictEqual(board.rows().length, MAX_PROJECTION_RUNS);
		ok(!board.rows().some((row) => row.runId === "run-0"));
		deepStrictEqual(
			board
				.rows()
				.map((row) => row.runId)
				.sort(),
			projection
				.snapshot()
				.runs.map((row) => row.runId)
				.sort(),
		);
	});
});
