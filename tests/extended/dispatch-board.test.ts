import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { DispatchCompletedPayload, DispatchEnqueuedPayload } from "../../src/core/telemetry/live-events.js";
import { sumFacts, sumPricing } from "../../src/core/telemetry/pricing.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { resolveToolBudgetEnvelope } from "../../src/domains/dispatch/budget-envelope.js";
import type { DispatchContract, DispatchSnapshot } from "../../src/domains/dispatch/contract.js";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";
import { composeTrustStatus, inspectRunEvidence } from "../../src/domains/evidence/index.js";
import { summarizeTrustStatus } from "../../src/domains/evidence/trust-projection.js";
import type { TelemetryRunReaders, TelemetryRunSummary } from "../../src/domains/telemetry/contract.js";
import { readVerifiedRun } from "../../src/domains/telemetry/index.js";
import {
	createTelemetryProjection,
	MAX_PROJECTION_RUNS,
	type TelemetryProjection,
} from "../../src/domains/telemetry/projection.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { councilGroupBody, councilIslandLines } from "../../src/interactive/council-grid.js";
import {
	createDispatchBoardStore,
	createDispatchBoardView,
	type DispatchBoardRow,
	dispatchStatusPresentation,
	formatFleetDockRows,
	formatTaskIslandLines,
} from "../../src/interactive/dispatch-board.js";
import { dispatchSegment } from "../../src/interactive/footer-panel.js";
import { renderToolSubline } from "../../src/interactive/renderers/tool-execution.js";
import { renderWorkerEntryLines } from "../../src/interactive/renderers/worker-entry.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";
import { createWorkerStream } from "../../src/session-control/worker-stream.js";
import { createMonitorTool } from "../../src/tools/monitor.js";
import { fixtureEnvelope, fixtureReceiptDraft, measuredSpend } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";
import { settledRunTrust, writeSettledRun } from "../harness/settled-run.js";
import { runUsageOf } from "../harness/telemetry-view.js";

it("gives running Fleet work the dispatch tone with an activity glyph and leaves queued work in body text", () => {
	const running = dispatchStatusPresentation("running");
	strictEqual(running.token, "dispatchAction");
	strictEqual(running.glyphToken, "activity");
	const queued = dispatchStatusPresentation("enqueued");
	strictEqual(queued.token, "body");
	strictEqual(queued.glyphToken, undefined);
});

it("keeps the council status word neutral while a running glyph carries action", () => {
	const theme = clioTheme();
	const status = { glyph: GLYPH.running, label: "running", glyphToken: "action" as const, token: "muted" as const };
	const member = {
		runId: "council-run",
		label: "Reviewer",
		round: 1,
		route: "blade/model",
		status,
		tailText: "",
		droppedLines: 0,
	};
	const group = { group: "review", members: [member], synthesis: null, status, round: 1, elapsed: "3s" };
	for (const rows of [councilIslandLines(theme, group, 80), councilGroupBody(theme, group, 80)]) {
		const rendered = rows.join("\n");
		ok(rendered.includes(theme.fg("action", GLYPH.running)));
		ok(rendered.includes(theme.fg("muted", "running")));
	}
});

it("previews a council member's first real line on the compact body, past a code fence", () => {
	const theme = clioTheme();
	const status = { glyph: GLYPH.ok, label: "done", token: "success" as const };
	const member = (runId: string, tailText: string) => ({
		runId,
		label: runId,
		round: 1,
		route: "blade/model",
		status,
		tailText,
		droppedLines: 0,
	});
	const members = [member("a", '```json\n\n{"verdict": "ship"}\n```'), member("b", "Looks fine.")];
	const group = { group: "review", members, synthesis: null, status, round: 1, elapsed: "3s" };
	const rows = councilGroupBody(theme, group, 80, 2).map(stripTerminalSequences);
	strictEqual(rows.length, 2, rows.join("\n"));
	// The compact row shows the gist the chat card shows: a ballot reads as its verdict, never as its fence or brace.
	ok(rows[0]?.includes("ship"), rows[0]);
	ok(!rows[0]?.includes("```") && !rows[0]?.includes("{"), rows[0]);
});

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
		policy: { toolCalls: 12, synthesis: true },
		hardCap: 20,
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
	spend: measuredSpend(
		{ input: 80, output: 30, cacheRead: 10, cacheWrite: 3, reasoning: 7, total: 123 },
		0.25,
		"catalog",
	),
	durationMs: 1500,
	exitCode: 0,
	toolActivity: null,
	outcome: "succeeded",
	outcomeCode: null,
	outcomeDetail: "canonical completion detail",
	hostVerification: "verified",
};

const projections: TelemetryProjection[] = [];
afterEach(() => {
	for (const projection of projections.splice(0)) projection.stop();
});

function setup(readers: TelemetryRunReaders = {}) {
	const bus = createTelemetryHub();
	const projection = createTelemetryProjection(bus, {
		...readers,
	});
	projections.push(projection);
	const board = createDispatchBoardStore(projection);
	const progress = (event: unknown) =>
		bus.emit("run.progressed", { runId: IDENTITY.runId, agentId: IDENTITY.agentId, event });
	const start = () => bus.emit("run.started", { ...IDENTITY, pid: null, assignmentId: IDENTITY.runId, attempt: 0 });
	return { bus, projection, board, progress, start };
}

/** Wait for the projection's next coalesced publication, with no board reconciliation shortcut. */
function nextPublication(projection: TelemetryProjection): Promise<void> {
	return new Promise((resolve, reject) => {
		let unsubscribe = () => {};
		let immediate = true;
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error("projection did not publish"));
		}, 1000);
		unsubscribe = projection.subscribe(() => {
			// subscribe publishes the current snapshot at once; wait for the next one.
			if (immediate) {
				immediate = false;
				return;
			}
			// Let the unsubscribe assignment finish before detaching.
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
		detail: row.outcomeDetail,
		phase: row.phase,
		progress: row.progress,
	};
}
function commonSummary(row: TelemetryRunSummary) {
	return {
		runId: row.runId,
		agentId: row.agentId,
		status: row.status,
		detail: row.outcomeDetail,
		phase: row.phase,
		progress: row.progress,
	};
}

describe("dispatch board uses the telemetry projection", () => {
	it("publishes all five dispatch events and evidenceReady through one fold", async () => {
		const { bus, projection, board, progress, start } = setup();
		for (const channel of [
			"run.enqueued",
			"run.started",
			"run.progressed",
			"run.completed",
			"run.failed",
			"evidence.assessed",
		] as const) {
			strictEqual(bus.listeners(channel).length, 1, `${channel} must have only the projection fold`);
		}
		const events = [
			() => bus.emit("run.enqueued", IDENTITY),
			start,
			() =>
				progress({
					type: "message_end",
					message: { role: "assistant", usage: { input: 4, cacheRead: 2, output: 3, cacheWrite: 1 } },
				}),
			() => bus.emit("run.completed", COMPLETED),
			() =>
				bus.emit("run.failed", {
					...COMPLETED,
					runId: "failed-run",
					council: undefined,
					outcome: "failed" as const,
					reason: "failed" as const,
					outcomeDetail: "check failed",
				}),
			() =>
				bus.emit("evidence.assessed", {
					runId: IDENTITY.runId,
					version: 1,
					attempt: 0,
					firstPassSuccess: true,
					failureCause: null,
					trust: JSON.parse(JSON.stringify(composeTrustStatus())),
					findings: [
						{ id: "finding-001", severity: "info", tag: "independent-review" },
						{ id: "finding-002", severity: "warn", tag: "no-validation" },
					],
					verdicts: [],
					provenance: null,
					text: {
						label: "resolvable",
						function: "sha256",
						canonicalization: "json-sorted-v1",
						subject: "evidence-findings",
						id: `obj_${"0".repeat(64)}`,
					},
				}),
		];
		for (const publish of events) {
			const flushed = nextPublication(projection);
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
		// The wall rate divides the read model's measured output (30 tokens) by the run's 1.5 s.
		const usage = runUsageOf(IDENTITY.runId, [{ usage: { input: 80, output: 30, cacheRead: 10 } }]);
		const view = createDispatchBoardView(
			() => board.rows().map((row) => ({ ...row, usage })),
			() => projection.snapshot(),
		);
		const rendered = view.render(180).join("\n");
		match(rendered, /coder/);
		match(rendered, /check failed/);
		match(stripTerminalSequences(rendered), /prompt 90 · out 30/);
		deepStrictEqual(projection.snapshot().runs.find((row) => row.runId === IDENTITY.runId)?.evidence, {
			firstPassSuccess: true,
			findingCount: 2,
		});
		board.unsubscribe();
		strictEqual(bus.listeners("run.completed").length, 1);
	});

	it("preserves every board field through the projection and keeps snapshots immutable", () => {
		const envelope = fixtureEnvelope(IDENTITY.runId);
		const receipt = finishRunResult(fixtureReceiptDraft(envelope), envelope, {
			terminal: { terminalReason: "completed" },
			processExitCode: envelope.exitCode,
			frameType: null,
			usage: undefined,
		}).result;
		const trust = settledRunTrust(receipt);
		let receiptAvailable = true;
		const { bus, projection, board, progress, start } = setup({
			readRunResult: () => (receiptAvailable ? { text: "sealed answer", trust } : null),
		});
		board.setFleetPhase(IDENTITY.runId, { wave: 3, stepId: "parser" });
		bus.emit("run.enqueued", IDENTITY);
		start();
		progress({ type: "attempt_start" });
		progress({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "working" } });
		progress({ type: "clio_coder_tool_start", payload: { tool: "read", toolCallId: "call-1" } });
		progress({ type: "clio_coder_tool_finish", payload: { tool: "read", toolCallId: "call-1" } });
		progress({ type: "clio_coder_tool_start", payload: { tool: "grep", toolCallId: "call-2" } });
		progress({ type: "clio_coder_steer_received", payload: { chars: 24 } });
		progress({
			type: "clio_coder_write_record_partial",
			payload: { reason: "opaque_tool_succeeded", tool: "bash", toolCallId: "call-3" },
		});
		progress({ type: "message_end", message: { role: "assistant", usage: { input: 4, cacheRead: 2, output: 3 } } });
		board.reconcile();
		strictEqual(board.rows()[0]?.currentTool, "grep");
		deepStrictEqual(board.rows()[0]?.recentTools, ["read"]);
		const prior = projection.snapshot();
		bus.emit("run.completed", COMPLETED);
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
				receipt: row.runRecordId,
				host: row.hostVerification,
				hops: row.failoverHops,
				elapsed: row.elapsedMs,
				usage: row.usage,
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
				// Tokens and cost are the telemetry read model's; without one the board says so (#434 §11.3).
				usage: { kind: "unavailable" },
				detail: COMPLETED.outcomeDetail,
			},
		);
		deepStrictEqual(row.budget, IDENTITY.budget);
		ok(row.taskSummary?.includes("parser"));
		ok(!row.taskSummary?.includes("\u001b"));
		// Without a read model the board has no journaled TTFT to show (#434).
		strictEqual(row.ttft, null);
		strictEqual(row.progress?.tailText, "sealed answer");
		deepStrictEqual(row.trust, projection.snapshot().runs[0]?.trust);
		strictEqual(row.steerAcknowledgement?.chars, 24);
		deepStrictEqual(row.writeRecordDowngrade, { reason: "opaque_tool_succeeded", tool: "bash", toolCallId: "call-3" });
		// The expanded card names the call by its tool, never by the provider's call id (bt-11 i22-toolu).
		const { council: _council, ...alone } = row;
		const record = stripTerminalSequences(
			createDispatchBoardView(
				() => [alone],
				() => undefined,
				() => "detailed",
			)
				.render(200)
				.join("\n"),
		);
		match(record, /record\s+open: a successful 'bash' call can write paths its arguments do not name/u);
		doesNotMatch(record, /call-3/u);
		strictEqual(prior.runs[0]?.status, "running");
		// A reply's usage does not accrue into the run's spend; the call fold reaches it through the snapshot (#434).
		strictEqual(prior.runs[0]?.spend.totalTokens.kind, "unknown");
		strictEqual(prior.runs[0]?.progress?.currentAction?.tool, "grep");
		const action = row.progress?.recentActions[0];
		if (action) action.tool = "mutated snapshot";
		ok(!projection.snapshot().runs[0]?.progress?.recentActions.some((action) => action.tool === "mutated snapshot"));
		receiptAvailable = false;
		bus.emit("run.completed", COMPLETED);
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
		bus.emit("run.failed", {
			...COMPLETED,
			outcome: "failed",
			reason: "failed",
			outcomeDetail: null,
			spend: { totalTokens: Number.NaN } as unknown as DispatchCompletedPayload["spend"],
		});
		board.reconcile();
		strictEqual(board.rows()[0]?.status, "failed");
		strictEqual(board.rows()[0]?.outcomeDetail, null);
		// A malformed terminal spend never replaces the run's facts.
		strictEqual(projection.snapshot().runs[0]?.spend.totalTokens.kind, "unknown");
		deepStrictEqual(board.rows().map(commonRow), projection.snapshot().runs.map(commonSummary));
	});

	it("folds live counters, retry timers, and cancellation in the projection", () => {
		const live: DispatchSnapshot = {
			generatedAt: "2026-09-05T00:00:00Z",
			running: [],
			retrying: [],
			totals: { tokens: sumFacts([]), cost: sumPricing([]), runtimeSeconds: 0 },
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
			spend: measuredSpend({ input: 12, output: 3 }, 0.12, "catalog"),
			node: null,
		});
		board.reconcile();
		deepStrictEqual(projection.snapshot().runs[0]?.spend.totalTokens, {
			kind: "measured",
			value: 15,
			source: "provider",
		});
		live.running = [];
		bus.emit("run.failed", { ...COMPLETED, outcome: "failed", reason: "failed" });
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
		bus.emit("run.aborted", {
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
		const published = nextPublication(projection);
		bus.emit("run.enqueued", IDENTITY);
		await published;
		strictEqual(board.rows().length, 0);
		strictEqual(projection.snapshot().runs.length, 1);
		strictEqual(bus.listeners("run.enqueued").length, 1);
	});

	it("does not settle worker progress on a rejected receipt's answer", () => {
		const envelope = fixtureEnvelope(IDENTITY.runId);
		const receipt = finishRunResult(fixtureReceiptDraft(envelope), envelope, {
			terminal: { terminalReason: "completed" },
			processExitCode: envelope.exitCode,
			frameType: null,
			usage: undefined,
		}).result;
		const trust = settledRunTrust(receipt, { state: "failed", reason: "run seal failed" });
		const { bus, board, progress, start } = setup({ readRunResult: () => ({ text: "untrusted receipt answer", trust }) });
		start();
		progress({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "observed live tail" } });
		bus.emit("run.completed", COMPLETED);
		board.reconcile();
		strictEqual(board.rows()[0]?.trust?.verdict, "compromised");
		ok(!board.rows()[0]?.progress?.tailText.includes("untrusted receipt answer"));
	});

	it("retains active dispatches beyond the terminal history limit and preserves their settlement", async () => {
		const { bus, projection, board, progress, start } = setup();
		board.setFleetPhase(IDENTITY.runId, { wave: 1, stepId: "long-task" });
		start();
		progress({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "still working" } });
		const published = nextPublication(projection);
		for (let i = 0; i < MAX_PROJECTION_RUNS + 10; i += 1) {
			bus.emit("run.enqueued", { ...IDENTITY, runId: `run-${i}` });
			bus.emit("run.completed", { ...COMPLETED, runId: `run-${i}` });
		}
		await published;
		const active = projection.snapshot().runs.find((run) => run.runId === IDENTITY.runId);
		strictEqual(active?.status, "running");
		strictEqual(active?.finishedAtMs, null);
		strictEqual(board.rows().length, MAX_PROJECTION_RUNS + 1);
		strictEqual(board.activeRows()[0]?.runId, IDENTITY.runId);
		strictEqual(board.activeRows()[0]?.progress?.tailText, "still working");
		deepStrictEqual(board.activeRows()[0]?.phase, { wave: 1, stepId: "long-task" });
		ok(!board.rows().some((row) => row.runId === "run-0"));

		const settled = nextPublication(projection);
		bus.emit("run.completed", COMPLETED);
		await settled;
		strictEqual(board.activeRows().length, 0);
		strictEqual(board.rows().length, MAX_PROJECTION_RUNS);
		const terminal = board.rows().find((row) => row.runId === IDENTITY.runId);
		ok(terminal, "the newest settlement must survive despite its old enqueue position");
		strictEqual(terminal.status, "completed");
		strictEqual(terminal.runRecordId, IDENTITY.runId);
		strictEqual(terminal.elapsedMs, COMPLETED.durationMs);
		strictEqual(terminal.outcomeDetail, COMPLETED.outcomeDetail);
		const canonical = projection.snapshot().runs.find((run) => run.runId === IDENTITY.runId);
		ok(canonical);
		ok(canonical.finishedAtMs !== null);
		deepStrictEqual(canonical.spend, COMPLETED.spend);
		deepStrictEqual(commonRow(terminal), commonSummary(canonical));

		for (let i = 0; i < MAX_PROJECTION_RUNS; i += 1) bus.emit("run.completed", { ...COMPLETED, runId: `later-${i}` });
		board.reconcile();
		strictEqual(board.rows().length, MAX_PROJECTION_RUNS);
		ok(!board.rows().some((row) => row.runId === IDENTITY.runId), "settled runs eventually age out");
	});

	it("retains pending retries beyond history capacity and bounds their canceled settlement", () => {
		const live: DispatchSnapshot = {
			generatedAt: "2026-09-05T00:00:00Z",
			running: [],
			retrying: [],
			totals: { tokens: sumFacts([]), cost: sumPricing([]), runtimeSeconds: 0 },
		};
		const { bus, projection, board, start } = setup({ dispatchSnapshot: () => live });
		start();
		bus.emit("run.failed", { ...COMPLETED, outcome: "failed", reason: "failed" });
		live.retrying.push({ runId: IDENTITY.runId, agentId: "coder", attempt: 1, dueAt: live.generatedAt, reason: "retry" });
		board.reconcile();
		for (let i = 0; i < MAX_PROJECTION_RUNS + 10; i += 1)
			bus.emit("run.failed", { ...COMPLETED, runId: `failed-${i}`, outcome: "failed", reason: "failed" });
		board.reconcile();
		strictEqual(board.rows().length, MAX_PROJECTION_RUNS + 1);
		strictEqual(board.activeRows()[0]?.status, "retrying");
		bus.emit("run.aborted", {
			source: "dispatch_abort",
			runId: IDENTITY.runId,
			startedAt: null,
			elapsedMs: null,
			reason: "canceled retry",
		});
		live.retrying = [];
		board.reconcile();
		strictEqual(board.activeRows().length, 0);
		strictEqual(projection.snapshot().runs.length, MAX_PROJECTION_RUNS);
		strictEqual(board.rows().find((row) => row.runId === IDENTITY.runId)?.status, "aborted");
	});

	for (const delayedReconcile of [true, false]) {
		it(`bounds the failed retry parent after ${delayedReconcile ? "delayed reconciliation" : "a relayed child start"}`, () => {
			// Retained independent probes: verify-peer-339-retry{-root}-probe.json.
			const live: DispatchSnapshot = {
				generatedAt: "2026-09-06T00:00:00Z",
				running: [],
				retrying: [],
				totals: { tokens: sumFacts([]), cost: sumPricing([]), runtimeSeconds: 0 },
			};
			const { bus, projection, board } = setup({ dispatchSnapshot: () => live });
			const identity = { ...IDENTITY, runId: "retry-parent" };
			bus.emit("run.started", { ...identity, pid: null, assignmentId: identity.runId, attempt: 0 });
			bus.emit("run.failed", { ...COMPLETED, ...identity, outcome: "failed", reason: "failed" });
			live.retrying.push({
				runId: identity.runId,
				agentId: identity.agentId,
				attempt: 1,
				dueAt: live.generatedAt,
				reason: "transient failure",
			});
			bus.emit("run.progressed", {
				...identity,
				event: { type: "retry_scheduled", attempt: 1, dueAt: live.generatedAt, reason: "transient failure" },
			});
			if (delayedReconcile) {
				// Other runs settle before the UI's reconciliation tick.
				for (let i = 0; i < MAX_PROJECTION_RUNS + 10; i += 1)
					bus.emit("run.completed", { ...COMPLETED, runId: `burst-${i}` });
				ok(!projection.snapshot().runs.some((run) => run.runId === identity.runId));
			}
			board.reconcile();
			const restored = projection.snapshot().runs.find((run) => run.runId === identity.runId);
			strictEqual(restored?.status, "retrying");
			if (delayedReconcile) strictEqual(restored?.finishedAtMs, null, "do not fabricate an evicted finish time");
			strictEqual(board.activeRows().length, 1);

			live.retrying = [];
			bus.emit("run.started", {
				...IDENTITY,
				runId: "retry-child",
				pid: null,
				assignmentId: identity.runId,
				attempt: 1,
			});
			if (!delayedReconcile) {
				bus.emit("run.progressed", {
					...identity,
					event: {
						type: "attempt_start",
						attempt: 1,
						runId: "retry-child",
						previousRunId: identity.runId,
						reason: "transient failure",
					},
				});
			}
			board.reconcile();
			const parent = projection.snapshot().runs.find((run) => run.runId === identity.runId);
			strictEqual(parent?.status, "failed");
			strictEqual(parent?.finishedAtMs, restored?.finishedAtMs, "retain the known or unknown parent finish time");
			deepStrictEqual(
				board.activeRows().map((run) => run.runId),
				["retry-child"],
			);
			bus.emit("run.completed", { ...COMPLETED, runId: "retry-child" });
			for (let i = 0; i < MAX_PROJECTION_RUNS + 10; i += 1)
				bus.emit("run.completed", { ...COMPLETED, runId: `later-${i}` });
			board.reconcile();
			strictEqual(board.rows().length, MAX_PROJECTION_RUNS);
			strictEqual(board.activeRows().length, 0);
			ok(!projection.snapshot().runs.some((run) => run.runId === identity.runId));
		});
	}

	it("keeps every queued dispatch even when active work alone exceeds the history limit", () => {
		const { bus, projection, board } = setup();
		for (let i = 0; i <= MAX_PROJECTION_RUNS; i += 1) bus.emit("run.enqueued", { ...IDENTITY, runId: `queued-${i}` });
		board.reconcile();
		strictEqual(board.activeRows().length, MAX_PROJECTION_RUNS + 1);
		strictEqual(projection.snapshot().runs.length, MAX_PROJECTION_RUNS + 1);
	});
});

describe("dispatch quality presentation", () => {
	it("counts mixed quality separately and labels missing historical quality unknown", () => {
		const trusts = (["pass", "fail"] as const).map((quality) => {
			const envelope = fixtureEnvelope(quality);
			const draft = fixtureReceiptDraft(envelope);
			draft.quality.resultContract = {
				sourceId: "agent-result-contract:mutation-report:fixture",
				validatorDigest: "a".repeat(64),
				conformance: "pass",
				quality,
			};
			return summarizeTrustStatus(
				settledRunTrust(
					finishRunResult(draft, envelope, {
						terminal: { terminalReason: draft.terminalReason ?? "completed" },
						processExitCode: envelope.exitCode,
						frameType: null,
						usage: undefined,
					}).result,
				),
			);
		});
		const finished = {
			toolCallId: "dispatch",
			toolName: "dispatch",
			isError: false,
			result: { details: { runCount: 3, failedCount: 0, runs: [{ trust: trusts[0] }, { trust: trusts[1] }, {}] } },
		};
		const plain = renderToolSubline(finished, 44).map(stripTerminalSequences).join(" ").replace(/\s+/gu, " ");
		// With no card under it, the dispatch row counts its runs by state, worst first: a validation failure is a
		// failure, a run whose record is not verified is unverified, and no `✓` sits beside the tally.
		match(plain, /delegated · 1 failed · 1 unverified · 1 ok$/u);
		doesNotMatch(plain, /quality|✓/u);
		// Cards state each run's quality; a fan-out keeps the same tally, and a single dispatch's card is its whole outcome.
		const fanOut = renderToolSubline({ ...finished, cardAttached: true }, 76)
			.map(stripTerminalSequences)
			.join(" ");
		match(fanOut, /delegated · 1 failed · 1 unverified · 1 ok/u);
		doesNotMatch(fanOut, /ok ✓/u);
		doesNotMatch(fanOut, /quality|grounded|validation/u);
		const single = renderToolSubline(
			{
				...finished,
				args: { agent: "scout", task: "map callers" },
				result: { details: { runCount: 1, failedCount: 0, runs: [{ trust: trusts[0] }] } },
				cardAttached: true,
			},
			76,
		).map(stripTerminalSequences);
		doesNotMatch(single.join(" "), /\bok\b|quality/u);
		// The card shows only the recovery's success, so the row keeps the failed attempt before it (cf1h-D3).
		const recovered = renderToolSubline(
			{
				...finished,
				args: { agent: "scout", task: "map callers" },
				result: { details: { runCount: 1, failedCount: 0, recoveredCount: 1, runs: [{ trust: trusts[0] }] } },
				cardAttached: true,
			},
			76,
		)
			.map(stripTerminalSequences)
			.join(" ")
			.replace(/\s+/gu, " ");
		match(recovered, /1 ok · 1 recovered after a failed attempt/u);
		// Wrapped action rows hang in the content column, so rows join on any run of whitespace.
		const historical = renderToolSubline({ ...finished, result: { details: { runCount: 3, failedCount: 1 } } }, 76)
			.map(stripTerminalSequences)
			.join(" ")
			.replace(/\s+/gu, " ");
		match(historical, /1 failed · 2 ok/u);
		doesNotMatch(historical, /validation/u);
	});

	for (const [quality, state, wording] of [
		["pass", "validated", "grounded"],
		["fail", "failed", "validation failed"],
		["unknown", "unknown", "validation unknown"],
		["ungrounded", "ungrounded", "inferred: validation claimed, none observed"],
	] as const) {
		it(`keeps execution success separate from ${quality} quality across summaries`, async () => {
			const env = await isolateClioEnv("dispatch-quality-");
			try {
				const envelope = fixtureEnvelope(IDENTITY.runId);
				// Monitor reads only runs from this project; the shared receipt fixture
				// defaults to /workspace, which is unrelated to this isolated test.
				envelope.cwd = process.cwd();
				const draft = fixtureReceiptDraft(envelope);
				// Exact failed-quality fact from retained S3 receipt 26ekyn85239m:
				// conformance passes for its honest report that the output write failed.
				if (quality === "pass" || quality === "fail")
					draft.quality.resultContract = {
						sourceId:
							"agent-result-contract:mutation-report:8399543b0144dd9a56118c9e10a3cd1804faaf9861fe76643996e14ca6975766",
						validatorDigest: "aaa20077d1d9a8c50a5bfedbcfa690ec7b37609142d270703029759c4ce5abcc",
						conformance: "pass",
						quality,
					};
				if (quality === "unknown") draft.verification = { state: "unknown", basis: "acp-external-unobserved" };
				if (quality === "ungrounded")
					draft.validationGrounding = {
						claimed: 1,
						grounded: 0,
						ungrounded: ["output write"],
						basis: "no-command-executed",
					};
				const receipt = finishRunResult(draft, envelope, {
					terminal: { terminalReason: draft.terminalReason ?? "completed" },
					processExitCode: envelope.exitCode,
					frameType: null,
					usage: undefined,
				}).result;
				await writeSettledRun(clioStateDir(), receipt);
				const bytes = JSON.stringify(readVerifiedRun(clioStateDir(), envelope.id)?.settled);
				await writeFile(join(clioStateDir(), "runs.json"), JSON.stringify([envelope]));
				const inspection = { status: settledRunTrust(receipt) };
				strictEqual(inspection.status.artifactIntegrity.state, "verified");
				strictEqual(inspection.status.validationGrounding.state, state);
				const trust = summarizeTrustStatus(inspection.status);
				const { bus, board, start } = setup({ readRunResult: () => ({ trust: inspection.status }) });
				start();
				// This is an ordinary parallel dispatch, with no council grouping.
				bus.emit("run.completed", { ...COMPLETED, council: undefined });
				board.reconcile();
				const row = { ...(board.rows()[0] as DispatchBoardRow) };
				delete row.council;
				strictEqual(row.status, "completed");
				deepStrictEqual(row.trust, trust);
				const plain = (lines: string[]) =>
					lines.map(stripTerminalSequences).join("\n").replace(/│/gu, " ").replace(/\s+/gu, " ");
				const collapsed = renderToolSubline(
					{
						toolCallId: "dispatch",
						toolName: "dispatch",
						isError: false,
						result: { details: { runCount: 3, failedCount: 0, runs: [{ trust }, { trust }, { trust }] } },
					},
					76,
				);
				// The tally counts the runs by their worst input: a failed validation is a failure and an ungrounded claim
				// is adverse; the quality words stay on the cards and the board.
				const bucket = { pass: "3 ok", fail: "3 failed", unknown: "3 ok", ungrounded: "3 unverified" }[quality];
				match(plain(collapsed), new RegExp(`delegated · ${bucket}$`, "u"));
				doesNotMatch(plain(collapsed), /quality/u);
				const island = formatTaskIslandLines([{ ...row, agentAudience: "base" }]);
				ok(plain(island).replace(/\s+/gu, " ").includes(`quality ${wording}`), plain(island));
				match(plain(island), /done/u);
				const card = createDispatchBoardView(
					() => [row],
					() => undefined,
				).render(76);
				ok(plain(card).replace(/\s+/gu, " ").includes(wording), plain(card));

				const stream = createWorkerStream({
					readResult: () => ({ outcome: "succeeded", contract: "pass", trust: inspection.status }),
				});
				stream.started({ ...IDENTITY, agentAudience: "base", pid: null, assignmentId: IDENTITY.runId, attempt: 0 });
				const worker = stream.completed(COMPLETED)?.entry;
				ok(worker);
				// The card's run row leads with the run's state from outcome, validation and record together: a failed or
				// ungrounded validation is never a check mark, and detailed names the record beside the route.
				const expected: Record<typeof quality, readonly [string, string]> = {
					pass: ["✓", "record: grounded"],
					fail: ["✗", "record: not trusted"],
					unknown: ["✓", "record: "],
					ungrounded: ["✗", "record: not trusted"],
				};
				const [glyph, record] = expected[quality];
				for (const style of ["compact", "standard", "detailed"] as const) {
					const lines = renderWorkerEntryLines(worker, 76, { detail: transcriptDetail(style) });
					ok(plain(lines).includes(`${glyph} ◇ Alpha`), plain(lines));
					if (quality === "fail") ok(plain(lines).includes("validation failed"), plain(lines));
					if (style === "detailed") ok(plain(lines).includes(record), plain(lines));
					ok(lines.every((line) => visibleWidth(line) <= 76));
				}
				const monitor = createMonitorTool({
					dispatch: {
						getRun: () => envelope,
						snapshot: () => ({ running: [], retrying: [] }),
					} as unknown as DispatchContract,
				});
				const sessionId = envelope.sessionId;
				ok(sessionId);
				const status = await monitor.run({ mode: "status", run_id: envelope.id }, { sessionId });
				strictEqual(status.kind, "ok", JSON.stringify(status));
				ok(status.output.includes(wording), status.output);
				match(status.output, /outcome=succeeded/u);
				deepStrictEqual(status.details?.trust, trust);
				const collected = await monitor.run({ mode: "collect", run_ids: [envelope.id] }, { sessionId });
				strictEqual(collected.kind, "ok");
				ok(collected.output.includes(wording), collected.output);
				match(collected.output, /state=succeeded/u);
				// The run's sealed assessment projects the same trust the board shows (#434).
				const evidence = await inspectRunEvidence(clioStateDir(), envelope.id);
				ok(evidence.assessedAt !== null);
				deepStrictEqual(summarizeTrustStatus(evidence.trust), trust);
				strictEqual(JSON.stringify(readVerifiedRun(clioStateDir(), envelope.id)?.settled), bytes);
				strictEqual(readVerifiedRun(clioStateDir(), envelope.id)?.seal?.status, "verified");
				if (quality === "unknown") doesNotMatch(plain(collapsed), /validation failed/u);
			} finally {
				env.restore();
			}
		});
	}
});

it("keeps shadow runs inspectable while presenting them only as compact helper activity", () => {
	const { bus, board } = setup();
	for (let i = 0; i < 4; i++) {
		bus.emit("run.started", {
			...IDENTITY,
			agentId: "scout",
			agentAudience: "shadow",
			requestOrigin: "agent",
			runId: `helper-${i}`,
			assignmentId: `helper-${i}`,
			attempt: 0,
			pid: null,
			council: undefined,
		});
	}
	board.reconcile();
	const rows = board.activeRows();
	strictEqual(rows.length, 4);
	match(dispatchSegment(rows) ?? "", /helpers scout ×4 4 active/);
	doesNotMatch(stripTerminalSequences(formatTaskIslandLines(rows).join("\n")), /scout/);
	const first = rows[0];
	ok(first);
	const ordinary = { ...first, runId: "ordinary", agentId: "coder", agentAudience: "base" as const };
	const mixed = stripTerminalSequences(formatTaskIslandLines([...rows, ordinary]).join("\n"));
	match(mixed, /coder/);
	doesNotMatch(mixed, /scout/);
	match(dispatchSegment([...rows, ordinary]) ?? "", /helpers scout ×4 4 active · dispatch 1 active/);
});

it("keeps a council's settled member in its live card so the count is the whole council", () => {
	const { bus, board } = setup();
	const member = (runId: string, label: string): DispatchEnqueuedPayload => ({
		...IDENTITY,
		runId,
		council: { group: "g-two", label, round: 1 },
	});
	for (const [runId, label] of [
		["fast-run", "fast"],
		["slow-run", "slow"],
	] as const) {
		bus.emit("run.enqueued", member(runId, label));
		bus.emit("run.started", { ...member(runId, label), pid: null, assignmentId: runId, attempt: 0 });
	}
	bus.emit("run.completed", { ...COMPLETED, ...member("fast-run", "fast") });
	board.reconcile();
	const dock = formatFleetDockRows(board.liveRows(), 120).map(stripTerminalSequences).join("\n");
	match(dock, /council of 2 · running/u);
	doesNotMatch(dock, /council of 1/u);
	board.unsubscribe();
});

it("Fleet Runs moves off a finished run when a live one appears, unless the operator moved the cursor", () => {
	const base = (runId: string, status: DispatchBoardRow["status"]): DispatchBoardRow => ({
		runId,
		agentId: "coder",
		runtimeKind: "http",
		runtimeId: "test",
		targetId: "test",
		wireModelId: "test",
		status,
		elapsedMs: 0,
		usage: { kind: "pending" },
		lastContextTokens: null,
		ttft: null,
	});
	let rows: DispatchBoardRow[] = [base("old-cancelled", "aborted")];
	const view = createDispatchBoardView(
		() => rows,
		() => undefined,
	);
	view.resetSelection();
	strictEqual(view.selectedRow()?.runId, "old-cancelled");
	rows = [...rows, base("fresh", "running")];
	strictEqual(view.selectedRow()?.runId, "fresh", "a live run outranks the default pick of a finished one");
	view.selectNext();
	strictEqual(view.selectedRow()?.runId, "old-cancelled");
	rows = [...rows, base("fresher", "enqueued")];
	strictEqual(view.selectedRow()?.runId, "old-cancelled", "a row the operator chose stays chosen");
});
