/**
 * Receipt evidence that a writer produced and the dispatch domain then lost on
 * the way to the sealed receipt or the adopted ledger row: tool frames dropped
 * under bulk-lane backpressure, a spawn failure's own error text, a call the
 * engine refused before it reached a CLIO tool, and an orphan's council and
 * cost provenance.
 */
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import {
	createBoundedEventQueue,
	WORKER_BULK_FRAME_MAX_BYTES,
	WORKER_EVENT_QUEUE_HARD_BYTES,
} from "../../src/domains/dispatch/worker-protocol.js";
import { type SpawnedWorker, spawnWorkerProcess } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

describe("bulk-lane backpressure", () => {
	it("keeps the tool frames the receipt fold reads above the queue bound", () => {
		const queue = createBoundedEventQueue(2);
		const evidence = [
			{ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} },
			{ type: "clio_coder_tool_start", payload: { tool: "read", toolCallId: "call-1", posture: "operating" } },
			{
				type: "clio_coder_tool_finish",
				payload: { tool: "read", toolCallId: "call-1", posture: "operating", durationMs: 4, outcome: "ok" },
			},
		];
		queue.push({ type: "message_update", delta: "a" });
		queue.push({ type: "message_update", delta: "b" });
		for (const frame of evidence) {
			queue.push(frame);
			for (let index = 0; index < 4; index += 1) queue.push({ type: "message_update", delta: `${index}` });
		}
		const kept: unknown[] = [];
		while (queue.size > 0) kept.push(queue.shift());
		deepStrictEqual(
			kept.filter((frame) => (frame as { type: string }).type !== "message_update"),
			evidence,
		);
		ok(queue.stats().droppedDisplayFrames > 0, "the bound must still drop display frames");
	});

	it("bounds retained evidence by frames and bytes and asks for pressure before refusing", () => {
		const frame = (index: number) => ({ type: "tool_execution_end", toolCallId: `call-${index}` });
		const byFrames = createBoundedEventQueue(4);
		const results = Array.from({ length: 100 }, (_, index) => byFrames.push(frame(index), 100));
		equal(byFrames.size, 8);
		equal(results.indexOf("overflow"), 8);
		equal(results.filter((result) => result === "overflow").length, 92);
		const bySize = createBoundedEventQueue();
		equal(bySize.push(frame(0), WORKER_BULK_FRAME_MAX_BYTES), "queued");
		equal(bySize.pressured, false);
		equal(bySize.push(frame(1), WORKER_BULK_FRAME_MAX_BYTES), "queued");
		equal(bySize.pressured, true);
		bySize.push(frame(2), WORKER_BULK_FRAME_MAX_BYTES);
		bySize.push(frame(3), WORKER_BULK_FRAME_MAX_BYTES);
		equal(bySize.push(frame(4), 1), "overflow");
		equal(bySize.bytes, WORKER_EVENT_QUEUE_HARD_BYTES);
		const kept: unknown[] = [];
		while (bySize.size > 0) kept.push(bySize.shift());
		deepStrictEqual(kept, [0, 1, 2, 3].map(frame));
		equal(bySize.bytes, 0);
	});
});

describe("spawn failure diagnostics", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("seal the spawn error's own text in the receipt", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		const missing = join(tmpdir(), "clio-coder-no-such-worker-binary");
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			heartbeatIntervalMs: 3_600_000,
			spawnWorker: (spec, options) => spawnWorkerProcess(missing, [], spec, options),
		});
		await bundle.extension.start();
		try {
			const run = await bundle.contract.dispatch({
				agentId: "scout",
				executionRole: "researcher",
				task: "Inspect isolated fixture evidence.",
				requestOrigin: "internal",
				resultContractOverride: { kind: "provenance-report" },
			});
			const receipt = await run.finalPromise;
			equal(receipt.outcome, "spawn_failed");
			match(receipt.outcomeDetail ?? "", /ENOENT/u);
			match(receipt.failureMessage ?? "", /ENOENT/u);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});

describe("a call refused before it reached a tool", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("counts a schema-rejected call in the receipt's tool stats as an error (bt-23 #5)", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			heartbeatIntervalMs: 3_600_000,
			spawnWorker: () => {
				const worker: SpawnedWorker = {
					pid: null,
					promise: Promise.resolve({ exitCode: 0, signal: null }),
					heartbeatAt: { current: Date.now(), monotonic: performance.now() },
					abort: () => {},
					send: () => true,
					events: (async function* () {
						yield { type: "tool_execution_start", toolCallId: "bad-edit", toolName: "edit", args: { path: 1 } };
						yield {
							type: "tool_execution_end",
							toolCallId: "bad-edit",
							toolName: "edit",
							isError: true,
							result: { content: [{ type: "text", text: 'Validation failed for tool "edit"' }], details: {} },
						};
						yield { type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "a" } };
						yield {
							type: "clio_coder_tool_start",
							payload: { tool: "read", toolCallId: "read-1", posture: "operating", startedAt: Date.now() },
						};
						yield {
							type: "clio_coder_tool_finish",
							payload: { tool: "read", toolCallId: "read-1", posture: "operating", durationMs: 1, outcome: "ok" },
						};
						yield { type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false, result: {} };
						yield {
							type: "message_end",
							message: { role: "assistant", stopReason: "stop", content: "Read a." },
						};
					})(),
				};
				return worker;
			},
		});
		await bundle.extension.start();
		try {
			const run = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "Fix the typo in a.",
				requestOrigin: "internal",
			});
			const receipt = await run.finalPromise;
			const edit = receipt.toolStats.find((stat) => stat.tool === "edit");
			equal(edit?.count, 1);
			equal(edit?.errors, 1);
			equal(receipt.toolStats.find((stat) => stat.tool === "read")?.count, 1);
			equal(receipt.toolCalls, 2);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
