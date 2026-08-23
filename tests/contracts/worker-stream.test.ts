/**
 * The worker transcript fold: event sequences in, entry state out. Everything
 * a worker block shows is decided here, so the sequences that used to reach
 * nobody (failover, abort, an ACP peer that sends no deltas) are asserted as
 * state rather than as pixels.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
	DispatchCompletedPayload,
	DispatchFailedPayload,
	DispatchStartedPayload,
} from "../../src/core/bus-events.js";
import { readWorkerReceiptFacts, workerReceiptFacts } from "../../src/interactive/worker-receipts.js";
import {
	createWorkerStream,
	WORKER_LIVE_TAIL_LINES,
	WORKER_TOOL_NAME_LIMIT,
	type WorkerReceiptFacts,
	type WorkerStreamOptions,
	workerReceiptSummary,
	workerRuntimeKind,
	workerTargetLabel,
} from "../../src/interactive/worker-stream.js";

function started(overrides: Partial<DispatchStartedPayload> = {}): DispatchStartedPayload {
	return {
		runId: "run-1",
		agentId: "coder",
		requestOrigin: "user",
		targetId: "mini",
		wireModelId: "Nemo-3.5-Lightning",
		runtimeId: "lmstudio",
		runtimeKind: "http",
		pid: 100,
		assignmentId: "run-1",
		attempt: 0,
		...overrides,
	};
}

function completed(overrides: Partial<DispatchCompletedPayload> = {}): DispatchCompletedPayload {
	return {
		runId: "run-1",
		agentId: "coder",
		requestOrigin: "user",
		targetId: "mini",
		wireModelId: "Nemo-3.5-Lightning",
		runtimeId: "lmstudio",
		runtimeKind: "http",
		outcome: "succeeded",
		outcomeCode: null,
		outcomeDetail: null,
		lineage: { rootRunId: "run-1", parentRunId: null, attempt: 0, depth: 0 },
		tokenCount: 4800,
		inputTokenCount: 4000,
		outputTokenCount: 800,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		costUsd: 0,
		durationMs: 9600,
		exitCode: 0,
		toolActivity: { calls: 3, succeeded: 3, failed: 0, blocked: 0, mutatingSucceeded: false },
		...overrides,
	};
}

function failed(overrides: Partial<DispatchFailedPayload> = {}): DispatchFailedPayload {
	return {
		runId: "run-1",
		agentId: "scout",
		requestOrigin: "agent",
		targetId: "mini",
		wireModelId: "Nemo-3.5",
		runtimeId: "lmstudio",
		runtimeKind: "http",
		outcome: "failed",
		outcomeCode: "result_contract_exhausted",
		outcomeDetail: "contract never reached\nsecond line",
		reason: "failed",
		exitCode: 1,
		durationMs: 4100,
		...overrides,
	};
}

function textDeltaEvent(delta: string): unknown {
	return { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } };
}

function messageEndEvent(text: string): unknown {
	return { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } };
}

function stream(options: WorkerStreamOptions = {}) {
	return createWorkerStream(options);
}

describe("worker stream fold", () => {
	it("opens a user-origin entry and streams text into it", () => {
		const worker = stream();
		const created = worker.started(started());
		strictEqual(created?.kind, "created");
		strictEqual(created?.entry.origin, "user");
		strictEqual(created?.entry.pending, true);
		deepStrictEqual(created?.entry.runtime, {
			kind: "clio",
			targetId: "mini",
			wireModelId: "Nemo-3.5-Lightning",
		});
		worker.progress({ runId: "run-1", agentId: "coder", event: textDeltaEvent("Hello! ") });
		worker.progress({ runId: "run-1", agentId: "coder", event: textDeltaEvent("I'm the coder worker.") });
		strictEqual(worker.get("run-1")?.text, "Hello! I'm the coder worker.");
	});

	it("moves nothing for a run it never opened, whichever event arrives first", () => {
		const worker = stream({ readReceipt: () => null });
		strictEqual(worker.progress({ runId: "run-1", agentId: "coder", event: textDeltaEvent("early") }), null);
		strictEqual(worker.completed(completed()), null);
		strictEqual(worker.failed(failed({ runId: "run-1" })), null);
		strictEqual(
			worker.aborted({ source: "dispatch_abort", runId: "run-1", startedAt: null, elapsedMs: 5, reason: "x" }),
			null,
		);
		// DispatchStarted is what opens the block; nothing before it left a trace.
		strictEqual(worker.started(started())?.entry.text, "");
	});

	it("never reaches the transcript for an internal-origin run", () => {
		const worker = stream();
		strictEqual(worker.started(started({ requestOrigin: "internal" })), null);
		strictEqual(worker.get("run-1"), undefined);
	});

	it("keeps tool names and never records tool arguments", () => {
		const worker = stream();
		worker.started(started());
		worker.progress({
			runId: "run-1",
			agentId: "coder",
			event: { type: "clio_tool_start", payload: { tool: "read", posture: "operating" } },
		});
		worker.progress({
			runId: "run-1",
			agentId: "coder",
			// The pi-level event is the one carrying literal arguments. It is not a
			// source of tool names here, so `/etc/shadow` can never reach an entry.
			event: { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "/etc/shadow" } },
		});
		worker.progress({
			runId: "run-1",
			agentId: "coder",
			event: { type: "clio_tool_finish", payload: { tool: "read", outcome: "ok", decision: "allowed" } },
		});
		worker.progress({
			runId: "run-1",
			agentId: "coder",
			event: { type: "clio_tool_start", payload: { tool: "artifact" } },
		});
		const entry = worker.get("run-1");
		deepStrictEqual(entry?.tools, ["read", "artifact"]);
		ok(!JSON.stringify(entry).includes("/etc/shadow"));
	});

	it("attributes concurrent calls of one tool independently in transcript state", () => {
		const worker = stream();
		worker.started(started());
		for (const [toolCallId, object] of [
			["read-1", "src/one.ts"],
			["read-2", "src/two.ts"],
		] as const) {
			worker.progress({
				runId: "run-1",
				agentId: "coder",
				event: {
					type: "clio_tool_start",
					payload: { tool: "read", toolCallId, action: { verb: "reading", object } },
				},
			});
		}
		worker.progress({
			runId: "run-1",
			agentId: "coder",
			event: { type: "clio_tool_finish", payload: { tool: "read", toolCallId: "read-1", outcome: "ok" } },
		});
		let progress = worker.get("run-1")?.progress;
		strictEqual(progress?.recentActions[0]?.toolCallId, "read-1");
		strictEqual(progress?.recentActions[0]?.descriptor?.object, "src/one.ts");
		strictEqual(progress?.currentAction?.toolCallId, "read-2");
		strictEqual(progress?.currentAction?.descriptor?.object, "src/two.ts");

		worker.progress({
			runId: "run-1",
			agentId: "coder",
			event: { type: "clio_tool_finish", payload: { tool: "read", toolCallId: "read-2", outcome: "ok" } },
		});
		progress = worker.get("run-1")?.progress;
		deepStrictEqual(
			progress?.recentActions.map((action) => action.toolCallId),
			["read-2", "read-1"],
		);
		strictEqual(progress?.currentAction, null);
	});

	it("bounds the tool-name list", () => {
		const worker = stream();
		worker.started(started());
		for (let index = 0; index < WORKER_TOOL_NAME_LIMIT + 5; index += 1) {
			worker.progress({
				runId: "run-1",
				agentId: "coder",
				event: { type: "clio_tool_start", payload: { tool: `tool-${index}` } },
			});
		}
		strictEqual(worker.get("run-1")?.tools.length, WORKER_TOOL_NAME_LIMIT);
	});

	it("keeps the live tail bounded and counts what it dropped", () => {
		const worker = stream();
		worker.started(started());
		const lines = WORKER_LIVE_TAIL_LINES + 10;
		for (let index = 0; index < lines; index += 1) {
			worker.progress({ runId: "run-1", agentId: "coder", event: textDeltaEvent(`line ${index}\n`) });
		}
		const entry = worker.get("run-1");
		// The trailing newline opens an empty final line, so the kept window ends
		// on it exactly as the stream produced it.
		strictEqual(entry?.text.split("\n").length, WORKER_LIVE_TAIL_LINES);
		ok((entry?.droppedLines ?? 0) > 0);
		ok(entry?.text.includes(`line ${lines - 1}`));
		ok(!entry?.text.includes("line 0\n"));
	});

	it("takes the settled answer from the sealed receipt, not the live tail", () => {
		const receipt: WorkerReceiptFacts = {
			outcome: "succeeded",
			tokenCount: 4800,
			durationMs: 9600,
			contract: "pass",
			text: "the sealed answer",
		};
		const worker = stream({ readReceipt: () => receipt });
		worker.started(started());
		worker.progress({ runId: "run-1", agentId: "coder", event: textDeltaEvent("partial narration") });
		const change = worker.completed(completed());
		strictEqual(change?.entry.text, "the sealed answer");
		strictEqual(change?.entry.pending, false);
		// The same projection replay uses: the receipt's facts minus its text.
		deepStrictEqual(change?.entry.receipt, {
			outcome: "succeeded",
			tokenCount: 4800,
			durationMs: 9600,
			contract: "pass",
		});
	});

	it("falls back to the terminal event and says the receipt was unreadable", () => {
		const worker = stream({ readReceipt: () => null });
		worker.started(started());
		worker.progress({ runId: "run-1", agentId: "coder", event: messageEndEvent("streamed answer") });
		const change = worker.completed(completed());
		strictEqual(change?.entry.receipt?.receiptUnavailable, true);
		strictEqual(change?.entry.receipt?.tokenCount, 4800);
		strictEqual(change?.entry.receipt?.toolCalls, 3);
		// No receipt to seal, so the durable message the run did produce stands.
		strictEqual(change?.entry.text, "streamed answer");
	});

	it("renders an ACP peer that sends a final message and no deltas", () => {
		const worker = stream({ readReceipt: () => null });
		const created = worker.started(
			started({ agentId: "codex", runtimeKind: "acp-delegation", runtimeId: "acp", targetId: "", wireModelId: "" }),
		);
		deepStrictEqual(created?.entry.runtime, { kind: "acp", peerId: "codex" });
		strictEqual(workerTargetLabel(created?.entry.runtime ?? { kind: "acp" }), "codex");
		worker.progress({ runId: "run-1", agentId: "codex", event: messageEndEvent("done, boss") });
		strictEqual(worker.get("run-1")?.text, "done, boss");
	});

	it("folds a failover into one entry with an attempt trail", () => {
		const worker = stream({ readReceipt: () => null });
		worker.started(started());
		worker.progress({ runId: "run-1", agentId: "coder", event: textDeltaEvent("first try") });
		const second = worker.started(
			started({ runId: "run-2", attempt: 1, assignmentId: "run-1", targetId: "dynamo", wireModelId: "qwen3" }),
		);
		strictEqual(second?.kind, "updated");
		strictEqual(second?.entry.runId, "run-2");
		strictEqual(second?.entry.pending, true);
		deepStrictEqual(
			second?.entry.attempts.map((attempt) => attempt.targetLabel),
			["mini/Nemo-3.5-Lightning", "dynamo/qwen3"],
		);
		// The block the operator is reading keeps streaming; the first attempt's
		// text is not thrown away by the retry.
		worker.progress({ runId: "run-2", agentId: "coder", event: textDeltaEvent(" then second") });
		strictEqual(worker.get("run-1")?.text, "first try then second");
		strictEqual(worker.get("run-2"), undefined);
	});

	it("ignores progress addressed to a superseded attempt", () => {
		const worker = stream();
		worker.started(started());
		worker.started(started({ runId: "run-2", attempt: 1, assignmentId: "run-1" }));
		strictEqual(worker.progress({ runId: "run-1", agentId: "coder", event: textDeltaEvent("late") }), null);
		strictEqual(worker.get("run-1")?.text, "");
	});

	it("lets no duplicate or late DispatchStarted move the block backwards or reopen it", () => {
		const worker = stream({ readReceipt: () => null });
		worker.started(started());
		worker.started(started({ runId: "run-2", attempt: 1, assignmentId: "run-1" }));
		// The first attempt's DispatchStarted, replayed late: the current attempt stays.
		strictEqual(worker.started(started()), null);
		strictEqual(worker.get("run-1")?.runId, "run-2");
		strictEqual(worker.get("run-1")?.attempts.length, 2);
		worker.completed(completed({ runId: "run-2" }));
		// A duplicate of the current attempt's start cannot un-settle a finished block.
		strictEqual(worker.started(started({ runId: "run-2", attempt: 1, assignmentId: "run-1" })), null);
		strictEqual(worker.get("run-1")?.pending, false);
		strictEqual(worker.get("run-1")?.receipt?.outcome, "succeeded");
		// The next attempt still folds in.
		strictEqual(worker.started(started({ runId: "run-3", attempt: 2, assignmentId: "run-1" }))?.entry.pending, true);
	});

	it("lets no late terminal or abort from a superseded attempt settle the current one", () => {
		const worker = stream({ readReceipt: () => null });
		worker.started(started());
		worker.started(started({ runId: "run-2", attempt: 1, assignmentId: "run-1" }));
		strictEqual(worker.completed(completed()), null);
		strictEqual(worker.failed(failed({ runId: "run-1" })), null);
		strictEqual(
			worker.aborted({ source: "dispatch_abort", runId: "run-1", startedAt: null, elapsedMs: 100, reason: "late" }),
			null,
		);
		const entry = worker.get("run-1");
		strictEqual(entry?.pending, true, "the second attempt is still running");
		strictEqual(entry?.receipt, undefined);
		strictEqual(entry?.attempts[1]?.outcome, undefined);
		// The attempt that is current settles it, and reads its own receipt.
		const reads: string[] = [];
		const sealed = createWorkerStream({
			readReceipt: (runId) => {
				reads.push(runId);
				return null;
			},
		});
		sealed.started(started());
		sealed.started(started({ runId: "run-2", attempt: 1, assignmentId: "run-1" }));
		strictEqual(sealed.completed(completed({ runId: "run-2" }))?.entry.pending, false);
		deepStrictEqual(reads, ["run-2"]);
	});

	it("folds the real failover sequence, whose retry is admitted as internal origin", () => {
		// What the dispatch domain actually publishes: the first attempt fails and
		// seals, then the retry starts under the same assignment with the origin
		// the admission path gives a retry, which is internal.
		const worker = stream({ readReceipt: () => null });
		worker.started(started());
		strictEqual(worker.failed(failed({ runId: "run-1", agentId: "coder", requestOrigin: "user" }))?.entry.pending, false);
		const retry = worker.started(
			started({ runId: "run-2", attempt: 1, assignmentId: "run-1", requestOrigin: "internal", targetId: "dynamo" }),
		);
		strictEqual(retry?.kind, "updated");
		strictEqual(retry?.entry.pending, true);
		strictEqual(retry?.entry.origin, "user", "the block keeps the assignment's origin");
		strictEqual(retry?.entry.receipt, undefined);
		worker.progress({ runId: "run-2", agentId: "coder", event: messageEndEvent("recovered") });
		const done = worker.completed(completed({ runId: "run-2", requestOrigin: "internal" }));
		strictEqual(done?.entry.receipt?.outcome, "succeeded");
		strictEqual(done?.entry.text, "recovered");
		deepStrictEqual(
			done?.entry.attempts.map((attempt) => `${attempt.runId}:${attempt.outcome ?? "?"}`),
			["run-1:failed", "run-2:succeeded"],
		);
		// A retry of work the fold never opened is still nobody's block.
		strictEqual(
			worker.started(started({ runId: "x-2", attempt: 1, assignmentId: "x-1", requestOrigin: "internal" })),
			null,
		);
	});

	it("takes no progress once the block has settled", () => {
		const worker = stream({ readReceipt: () => ({ outcome: "succeeded", text: "sealed" }) });
		worker.started(started());
		worker.completed(completed());
		strictEqual(worker.progress({ runId: "run-1", agentId: "coder", event: textDeltaEvent("straggler") }), null);
		strictEqual(worker.get("run-1")?.text, "sealed");
	});

	it("seals a failure with its outcome code and first detail line", () => {
		const worker = stream({ readReceipt: () => null });
		worker.started(started({ requestOrigin: "agent", agentId: "scout", parentToolCallId: "call_7" }));
		const change = worker.failed(failed());
		strictEqual(change?.entry.origin, "agent");
		strictEqual(change?.entry.parentToolCallId, "call_7");
		strictEqual(change?.entry.receipt?.outcomeCode, "result_contract_exhausted");
		strictEqual(change?.entry.receipt?.exitCode, 1);
		strictEqual(change?.entry.receipt?.failureMessage, "contract never reached\nsecond line");
		strictEqual(change?.entry.attempts[0]?.outcome, "failed");
	});

	it("settles an aborted run provisionally and lets the terminal event replace it", () => {
		const worker = stream({ readReceipt: () => null });
		worker.started(started());
		const abort = worker.aborted({
			source: "dispatch_abort",
			runId: "run-1",
			startedAt: null,
			elapsedMs: 2500,
			reason: "operator abort",
		});
		strictEqual(abort?.entry.pending, false);
		strictEqual(abort?.entry.receipt?.provisional, true);
		strictEqual(abort?.entry.receipt?.durationMs, 2500);
		const sealed = worker.failed(failed({ outcome: "canceled", outcomeDetail: "operator abort", exitCode: 130 }));
		strictEqual(sealed?.entry.receipt?.provisional, undefined);
		strictEqual(sealed?.entry.receipt?.exitCode, 130);
	});

	it("ignores an abort that names no worker of ours", () => {
		const worker = stream();
		worker.started(started());
		strictEqual(
			worker.aborted({ source: "stream_cancel", runId: null, startedAt: null, elapsedMs: null }),
			null,
			"a cancelled chat stream settles no worker",
		);
		strictEqual(worker.get("run-1")?.pending, true);
	});

	it("names the runtime family from the runtime id", () => {
		strictEqual(workerRuntimeKind("http", "lmstudio"), "clio");
		strictEqual(workerRuntimeKind("sdk", "claude-sdk"), "claude-sdk");
		strictEqual(workerRuntimeKind("subprocess", "claude-code"), "claude-code");
		strictEqual(workerRuntimeKind("acp-delegation", "acp"), "acp");
	});

	it("forgets every assignment on reset, so a late event of the old session moves nothing", () => {
		const worker = stream({ readReceipt: () => null });
		worker.started(started({ runId: "a", assignmentId: "a" }));
		worker.completed(completed({ runId: "a" }));
		worker.started(started({ runId: "b", assignmentId: "b" }));
		worker.reset();
		strictEqual(worker.get("a"), undefined);
		strictEqual(worker.get("b"), undefined);
		strictEqual(worker.progress({ runId: "b", agentId: "coder", event: textDeltaEvent("late") }), null);
		strictEqual(worker.completed(completed({ runId: "b" })), null);
		strictEqual(
			worker.started(started({ runId: "b-2", attempt: 1, assignmentId: "b", requestOrigin: "internal" })),
			null,
		);
		// The fold is usable again afterwards.
		strictEqual(worker.started(started({ runId: "c", assignmentId: "c" }))?.kind, "created");
	});
});

describe("worker receipt projection", () => {
	it("keeps unknown units unknown and strips the sealed text from the footer facts", () => {
		deepStrictEqual(workerReceiptSummary({ outcome: "succeeded", text: "the answer" }), { outcome: "succeeded" });
		deepStrictEqual(workerReceiptSummary(null), { outcome: "unknown", receiptUnavailable: true });
	});

	it("reads the sealed answer, the elapsed span, and the contract verdict", () => {
		const facts = workerReceiptFacts({
			outcome: "succeeded",
			exitCode: 0,
			tokenCount: 4800,
			toolCalls: 3,
			startedAt: "2026-08-16T00:00:00.000Z",
			endedAt: "2026-08-16T00:00:09.600Z",
			output: { state: "final", text: "hello", bytes: 5, truncated: false },
			quality: { version: 1, typedValidations: [], responseSchema: {}, resultContract: { conformance: "pass" } },
		});
		deepStrictEqual(facts, {
			outcome: "succeeded",
			exitCode: 0,
			tokenCount: 4800,
			durationMs: 9600,
			toolCalls: 3,
			contract: "pass",
			text: "hello",
		});
	});

	it("reports a run that had no typed contract as unmeasured, not as a pass", () => {
		const facts = workerReceiptFacts({
			outcome: "succeeded",
			quality: { version: 1, typedValidations: [], responseSchema: {}, resultContract: null },
		});
		strictEqual(facts?.contract, "unmeasured");
	});

	it("refuses a payload that seals no outcome", () => {
		strictEqual(workerReceiptFacts({ runId: "x" }), null);
	});

	it("returns null for a receipt file that is not there", () => {
		strictEqual(readWorkerReceiptFacts("run-that-never-was", mkdtempSync(join(tmpdir(), "clio-receipts-"))), null);
	});
});
