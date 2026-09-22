import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { createRegistry, type ToolResult } from "../../src/tools/registry.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * monitor and steer through the session registry against the real dispatch
 * bundle. The only stand-in is the worker process: a controlled worker that
 * records what the steer channel delivered and finishes when the test says so.
 */

function controlledWorker() {
	let resolve!: (value: SpawnedWorkerResult) => void;
	const done = new Promise<SpawnedWorkerResult>((yes) => {
		resolve = yes;
	});
	let aborts = 0;
	const messages: Array<{ type: string; text?: string }> = [];
	const worker: SpawnedWorker = {
		pid: null,
		promise: done,
		heartbeatAt: { current: Date.now(), monotonic: performance.now() },
		abort() {
			aborts += 1;
			resolve({ exitCode: null, signal: "SIGTERM" });
		},
		send(message) {
			messages.push(message as { type: string; text?: string });
			return true;
		},
		events: (async function* () {
			const outcome = await done;
			if (outcome.exitCode === 0)
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: JSON.stringify({ confirmedFacts: [], missingEvidence: [], nextInspections: [] }),
					},
				};
		})(),
	};
	return { worker, messages, aborts: () => aborts, finish: () => resolve({ exitCode: 0, signal: null }) };
}

async function fixture(scratch: IsolatedClioEnv) {
	const workers: ReturnType<typeof controlledWorker>[] = [];
	const bundle = makeDispatchBundle(dispatchStubContext(), {
		spawnWorker: () => {
			const worker = controlledWorker();
			workers.push(worker);
			return worker.worker;
		},
	});
	await bundle.extension.start();
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: scratch.dir }) });
	registerAllTools(registry, { mcpCapabilities: false, dispatch: bundle.contract });
	const request: DispatchRequest = {
		agentId: "scout",
		executionRole: "researcher",
		task: "Inspect isolated fixture evidence.",
		cwd: scratch.dir,
		requestOrigin: "internal",
		resultContractOverride: { kind: "provenance-report" },
	};
	return {
		contract: bundle.contract,
		workers,
		request,
		async call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
			const verdict = await registry.invoke({ tool, args });
			if (verdict.kind !== "ok") throw new Error(`${tool} was not admitted: ${JSON.stringify(verdict)}`);
			return verdict.result;
		},
		async stop() {
			for (const worker of workers) worker.finish();
			await bundle.extension.stop?.();
		},
	};
}

function okResult(result: ToolResult): Extract<ToolResult, { kind: "ok" }> {
	if (result.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
	return result;
}

function errorMessage(result: ToolResult): string {
	if (result.kind !== "error") throw new Error(`expected error, got ${JSON.stringify(result)}`);
	return result.message;
}

describe("steer tool", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-steer-tool-");
	});
	afterEach(() => scratch.restore());

	it("delivers guidance to the live worker and refuses malformed calls before they reach dispatch", async () => {
		const f = await fixture(scratch);
		try {
			const handle = await f.contract.dispatch(f.request);
			const guided = okResult(
				await f.call(ToolNames.Steer, { run_id: ` ${handle.runId} `, action: "guide", message: " narrow to the parser " }),
			);
			deepStrictEqual(guided.details, { action: "guide", runId: handle.runId, chars: "narrow to the parser".length });
			match(guided.output, /next turn boundary/);
			deepStrictEqual(
				f.workers[0]?.messages.filter((message) => message.type === "steer").map((message) => message.text),
				["narrow to the parser"],
			);

			match(errorMessage(await f.call(ToolNames.Steer, { action: "guide", message: "x" })), /missing run_id/);
			match(
				errorMessage(await f.call(ToolNames.Steer, { run_id: handle.runId, action: "pause" })),
				/action must be guide or cancel; got 'pause'/,
			);
			match(
				errorMessage(await f.call(ToolNames.Steer, { run_id: handle.runId, action: "guide", message: "   " })),
				/requires a non-empty message/,
			);
			match(
				errorMessage(await f.call(ToolNames.Steer, { run_id: "no-such-run", action: "guide", message: "hello" })),
				/not active/,
			);
			strictEqual(f.workers[0]?.messages.filter((message) => message.type === "steer").length, 1);
			strictEqual(f.workers[0]?.aborts(), 0);
		} finally {
			await f.stop();
		}
	});

	it("cancels a live run once and reports a finished or unknown run as nothing to cancel", async () => {
		const f = await fixture(scratch);
		try {
			const handle = await f.contract.dispatch(f.request);
			const cancelled = okResult(await f.call(ToolNames.Steer, { run_id: handle.runId, action: "cancel" }));
			strictEqual(cancelled.details?.action, "cancel");
			match(cancelled.output, /cancellation signalled/);
			strictEqual((await handle.finalPromise).outcome, "canceled");
			strictEqual(f.workers[0]?.aborts(), 1);

			match(
				errorMessage(await f.call(ToolNames.Steer, { run_id: handle.runId, action: "cancel" })),
				/already finished \(state=canceled\); nothing to cancel/,
			);
			match(
				errorMessage(await f.call(ToolNames.Steer, { run_id: "no-such-run", action: "cancel" })),
				/unknown run or assignment 'no-such-run'/,
			);
			strictEqual(f.workers[0]?.aborts(), 1);
		} finally {
			await f.stop();
		}
	});
});

describe("monitor tool", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-monitor-tool-");
	});
	afterEach(() => scratch.restore());

	it("lists, reports, waits on, and collects one run from dispatch to its sealed receipt", async () => {
		const f = await fixture(scratch);
		try {
			const empty = okResult(await f.call(ToolNames.Monitor, {}));
			strictEqual(empty.output, "No dispatched runs recorded.");

			const handle = await f.contract.dispatch(f.request);
			const listed = okResult(await f.call(ToolNames.Monitor, { mode: "list" }));
			deepStrictEqual(listed.details?.runs, [{ runId: handle.runId, agentId: "scout", state: "running" }]);

			const status = okResult(await f.call(ToolNames.Monitor, { run_id: handle.runId }));
			match(status.output, new RegExp(handle.runId));
			strictEqual(status.details?.mode, "status");

			const waited = okResult(await f.call(ToolNames.Monitor, { mode: "wait", run_id: handle.runId, timeout_ms: 20 }));
			strictEqual(waited.details?.timedOut, true);
			match(waited.output, /keeps running normally/);

			const pending = okResult(await f.call(ToolNames.Monitor, { mode: "collect", run_ids: [handle.runId] }));
			strictEqual(pending.details?.complete, false);
			deepStrictEqual(pending.details?.pendingRunIds, [handle.runId]);

			match(
				errorMessage(await f.call(ToolNames.Monitor, { mode: "receipt", run_id: handle.runId })),
				/has no stored receipt/,
			);

			f.workers[0]?.finish();
			strictEqual((await handle.finalPromise).outcome, "succeeded");

			const settled = okResult(await f.call(ToolNames.Monitor, { mode: "wait", run_id: handle.runId, timeout_ms: 20 }));
			strictEqual(settled.details?.timedOut, false);

			const collected = okResult(
				await f.call(ToolNames.Monitor, { mode: "collect", run_ids: [handle.runId], timeout_ms: 5 }),
			);
			strictEqual(collected.details?.complete, true);
			strictEqual(collected.details?.failedCount, 0);
			const [row] = collected.details?.runs as Array<{ runId: string; state: string; receiptIntegrity: { ok: boolean } }>;
			strictEqual(row?.runId, handle.runId);
			strictEqual(row?.state, "succeeded");
			strictEqual(row?.receiptIntegrity.ok, true, "collect reads the sealed receipt back through its integrity check");
			match(collected.output, /collect never blocks; timeout_ms is ignored/);

			const receipt = okResult(await f.call(ToolNames.Monitor, { mode: "receipt", run_id: handle.runId }));
			match(receipt.output, new RegExp(handle.runId));
			okResult(await f.call(ToolNames.Monitor, { mode: "tools", run_id: handle.runId }));
			okResult(await f.call(ToolNames.Monitor, { mode: "peek", run_id: handle.runId }));
		} finally {
			await f.stop();
		}
	});

	it("names the missing or malformed argument instead of guessing a run", async () => {
		const f = await fixture(scratch);
		try {
			const cases: Array<[Record<string, unknown>, RegExp]> = [
				[{ mode: "follow" }, /mode must be status, peek, receipt, list, wait, collect, or tools; got 'follow'/],
				[{ mode: "status" }, /needs run_id; call monitor\(mode="list"\) first/],
				[{ mode: "peek", run_ids: ["a", "b"] }, /observes one run; got run_ids with 2 entries/],
				[{ mode: "collect" }, /requires batch_id or a non-empty run_ids array/],
				[{ mode: "collect", batch_id: "no-such-batch" }, /unknown batch 'no-such-batch'/],
				[{ run_id: "no-such-run" }, /unknown run or assignment 'no-such-run'/],
				[{ mode: "wait", run_id: "no-such-run" }, /unknown run 'no-such-run'/],
				[{ mode: "receipt", run_id: "no-such-run" }, /unknown run 'no-such-run'/],
			];
			for (const [args, expected] of cases) {
				match(errorMessage(await f.call(ToolNames.Monitor, args)), expected, JSON.stringify(args));
			}
		} finally {
			await f.stop();
		}
	});
});
