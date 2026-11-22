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
import { INTERNAL_HELPER_RESULT_TOOL } from "../../src/engine/worker-tools.js";
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
				executionRole: "explorer",
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

	const readCall = [
		{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "a" } },
		{
			type: "clio_coder_tool_start",
			payload: { tool: "read", toolCallId: "read-1", posture: "operating", startedAt: Date.now() },
		},
		{
			type: "clio_coder_tool_finish",
			payload: { tool: "read", toolCallId: "read-1", posture: "operating", durationMs: 1, outcome: "ok" },
		},
		{ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false, result: {} },
		{ type: "message_end", message: { role: "assistant", stopReason: "stop", content: "Read a." } },
	];

	async function receiptFor(
		events: unknown[],
		progressed: unknown[] = [],
		override: { resultContractOverride?: { kind: "provenance-report" } } = {},
		helperRuns: boolean[] = [],
	) {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		const context = dispatchStubContext({ settings });
		const emit = context.bus.emit.bind(context.bus);
		context.bus = {
			...context.bus,
			emit: (name, payload, ...rest) => {
				if (name === "run.progressed") progressed.push((payload as { event?: unknown }).event);
				return emit(name, payload, ...rest);
			},
		};
		const bundle = makeDispatchBundle(context, {
			heartbeatIntervalMs: 3_600_000,
			spawnWorker: (spec) => {
				helperRuns.push(spec.helperResult === true);
				const worker: SpawnedWorker = {
					pid: null,
					promise: Promise.resolve({ exitCode: 0, signal: null }),
					heartbeatAt: { current: Date.now(), monotonic: performance.now() },
					abort: () => {},
					send: () => true,
					events: (async function* () {
						yield* events;
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
				...override,
			});
			return await run.finalPromise;
		} finally {
			await bundle.extension.stop?.();
		}
	}

	it("counts a schema-rejected call in the receipt's tool stats as an error (bt-23 #5)", async () => {
		const receipt = await receiptFor([
			{ type: "tool_execution_start", toolCallId: "bad-edit", toolName: "edit", args: { path: 1 } },
			{
				type: "tool_execution_end",
				toolCallId: "bad-edit",
				toolName: "edit",
				isError: true,
				result: { content: [{ type: "text", text: 'Validation failed for tool "edit"' }], details: {} },
			},
			...readCall,
		]);
		const edit = receipt.toolStats.find((stat) => stat.tool === "edit");
		equal(edit?.count, 1);
		equal(edit?.errors, 1);
		equal(receipt.toolStats.find((stat) => stat.tool === "read")?.count, 1);
		equal(receipt.toolCalls, 2);
	});

	it("keeps the result submission out of a helper run's write record, but not another run's or an unknown tool (C-14)", async () => {
		const call = (toolCallId: string, toolName: string) => [
			{ type: "tool_execution_start", toolCallId, toolName, args: { summary: "done" } },
			{ type: "tool_execution_end", toolCallId, toolName, isError: false, result: {} },
		];
		const downgradedBy = async (override: { resultContractOverride?: { kind: "provenance-report" } }) => {
			const progressed: unknown[] = [];
			const helperRuns: boolean[] = [];
			await receiptFor(
				[
					// A verify that only lists the checks runs nothing; the record stays whole until a real opaque call.
					...call("list-1", "verify"),
					...call("submit-1", INTERNAL_HELPER_RESULT_TOOL),
					...call("mcp-1", "mcp__fixture__sync"),
					...readCall,
				],
				progressed,
				override,
				helperRuns,
			);
			const tools = progressed
				.filter((event) => (event as { type?: string }).type === "clio_coder_write_record_partial")
				.map((event) => (event as { payload: { tool: string } }).payload.tool);
			return { helperRuns, tools };
		};
		// A coder run holds the helper result contract: only the unknown tool opens the record.
		deepStrictEqual(await downgradedBy({}), { helperRuns: [true], tools: ["mcp__fixture__sync"] });
		// Without that contract, a tool that happens to carry the submission's name is an ordinary opaque call.
		deepStrictEqual(await downgradedBy({ resultContractOverride: { kind: "provenance-report" } }), {
			helperRuns: [false],
			tools: [INTERNAL_HELPER_RESULT_TOOL],
		});
	});

	it("leaves a call the output token limit cut off out of the tool stats (bt-23 #5)", async () => {
		const receipt = await receiptFor([
			{
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "length",
					content: [{ type: "toolCall", id: "cut-write", name: "write", arguments: { path: "a" } }],
				},
			},
			{ type: "tool_execution_start", toolCallId: "cut-write", toolName: "write", args: { path: "a" } },
			{
				type: "tool_execution_end",
				toolCallId: "cut-write",
				toolName: "write",
				isError: true,
				result: {
					content: [
						{
							type: "text",
							text:
								'Tool call "write" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.',
						},
					],
					details: {},
				},
			},
			...readCall,
		]);
		equal(
			receipt.toolStats.find((stat) => stat.tool === "write"),
			undefined,
		);
		equal(receipt.toolCalls, 1);
	});
});
