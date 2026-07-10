import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import {
	createDetachedDispatchNudgeRegistration,
	DETACHED_DISPATCH_NUDGE_REGISTRATION_ID,
	openDetachedBatchViews,
} from "../../src/domains/middleware/dispatch-nudge.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { createDispatchTool, runEventTail } from "../../src/tools/dispatch.js";
import { createMonitorTool } from "../../src/tools/monitor.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(message);
}

function okWorker(text = "done"): SpawnedWorker {
	const events = (async function* () {
		yield { type: "message_end", message: { role: "assistant", content: text, usage: { input: 1, output: 1 } } };
	})();
	return {
		pid: 100,
		promise: Promise.resolve({ exitCode: 0, signal: null }),
		events,
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

/** Worker that stays in flight until the test releases it with an exit code. */
function gatedWorker(): { worker: SpawnedWorker; finish: (exitCode: number) => void } {
	let settle!: (result: SpawnedWorkerResult) => void;
	const promise = new Promise<SpawnedWorkerResult>((resolve) => {
		settle = resolve;
	});
	const events = (async function* (): AsyncIterableIterator<unknown> {
		const result = await promise;
		if (result.exitCode === 0) {
			yield { type: "message_end", message: { role: "assistant", content: "gated done", usage: { input: 1, output: 1 } } };
		}
	})();
	return {
		worker: {
			pid: 101,
			promise,
			events,
			abort: () => settle({ exitCode: null, signal: "SIGTERM" }),
			heartbeatAt: { current: Date.now() },
		},
		finish: (exitCode: number) => settle({ exitCode, signal: null }),
	};
}

function turnEndInput(overrides: Partial<MiddlewareHookInput> = {}): MiddlewareHookInput {
	return {
		hook: "turn_end",
		text: "All done.",
		metadata: {
			stopReason: "stop",
			turnToolCalls: 3,
			activeToolNames: "dispatch,monitor,read",
		},
		...overrides,
	};
}

type ToolRunResult =
	| { kind: "ok"; output: string; details?: Record<string, unknown> }
	| { kind: "error"; message: string; details?: Record<string, unknown> };

const approvedDispatch = {
	approval: { requestId: "test-dispatch-approval", requestedBy: "test-operator", actionClass: "dispatch" as const },
};

describe("detached dispatch + collect", () => {
	beforeEach(() => {
		isolateDispatchState();
	});
	after(() => {
		restoreDispatchState();
	});

	it("rejects detach with sequential mode and with timeout_ms", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => okWorker() });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const sequential = (await tool.run({ tasks: ["a"], detach: true, mode: "sequential" }, {})) as ToolRunResult;
			strictEqual(sequential.kind, "error");
			ok(sequential.kind === "error" && sequential.message.includes("parallel"));
			const timed = (await tool.run({ tasks: ["a"], detach: true, timeout_ms: 5000 }, {})) as ToolRunResult;
			strictEqual(timed.kind, "error");
			ok(timed.kind === "error" && timed.message.includes("timeout_ms"));
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("detach returns immediately, keeps metering in the background, and persists the batch", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => okWorker() });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const result = (await tool.run(
				{ tasks: ["task one", "task two"], detach: true },
				{ sessionId: "session-detach", ...approvedDispatch },
			)) as ToolRunResult;
			strictEqual(result.kind, "ok");
			ok(result.kind === "ok");
			match(result.output, /dispatch \(detached\) batch=/);
			const batchId = result.details?.batchId as string;
			const runIds = result.details?.runIds as string[];
			strictEqual(runIds.length, 2);

			// Durable record exists immediately and is open.
			const record = bundle.contract.detached?.get(batchId);
			ok(record, "durable batch record written");
			strictEqual(record?.collectedAt, null);
			strictEqual(record?.sessionId, "session-detach");
			deepStrictEqual(
				record?.runs.map((run) => run.runId),
				runIds,
			);

			// Background drain finalizes the runs without anyone awaiting the tool.
			await waitFor(
				() => runIds.every((runId) => bundle.contract.getRun(runId)?.status === "completed"),
				"detached runs finalized in the background",
			);
			// The drain also feeds the in-process tails (it can land a tick after
			// finalization), so peek works.
			await waitFor(
				() => runIds.every((runId) => (runEventTail(runId)?.entries.length ?? 0) >= 1),
				"run tails buffered in the background",
			);
			const monitor = createMonitorTool({ dispatch: bundle.contract });
			const firstRunId = runIds[0];
			ok(firstRunId !== undefined);
			const peek = (await monitor.run({ mode: "peek", run_id: firstRunId }, {})) as ToolRunResult;
			strictEqual(peek.kind, "ok");
			ok(peek.kind === "ok" && (peek.details?.eventCount as number) >= 1, "run tail buffered for peek");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("collect is a barrier: pending snapshot in flight, full mixed results once terminal, then marked collected", async () => {
		const gated = gatedWorker();
		const workers: Array<() => SpawnedWorker> = [() => okWorker("first answer"), () => gated.worker];
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: () => (workers.shift() ?? okWorker)(),
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const monitor = createMonitorTool({ dispatch: bundle.contract });
			const result = (await tool.run({ tasks: ["quick", "slow"], detach: true }, approvedDispatch)) as ToolRunResult;
			strictEqual(result.kind, "ok");
			const batchId = result.details?.batchId as string;
			const runIds = result.details?.runIds as string[];

			const quickRunId = runIds[0];
			ok(quickRunId !== undefined);
			await waitFor(() => bundle.contract.getRun(quickRunId)?.status === "completed", "quick run finalized");

			const pending = (await monitor.run({ mode: "collect", batch_id: batchId }, {})) as ToolRunResult;
			strictEqual(pending.kind, "ok");
			ok(pending.kind === "ok");
			strictEqual(pending.details?.complete, false);
			strictEqual(pending.details?.pendingCount, 1);
			match(pending.output, /collect pending/);
			// An incomplete collect must not close the batch.
			strictEqual(bundle.contract.detached?.get(batchId)?.collectedAt, null);

			gated.finish(1);
			const slowRunId = runIds[1];
			ok(slowRunId !== undefined);
			await waitFor(() => bundle.contract.getRun(slowRunId)?.status === "failed", "slow run finalized as failed");

			const collected = (await monitor.run({ mode: "collect", batch_id: batchId }, {})) as ToolRunResult;
			strictEqual(collected.kind, "ok");
			ok(collected.kind === "ok");
			strictEqual(collected.details?.complete, true);
			strictEqual(collected.details?.failedCount, 1);
			match(collected.output, /collect complete/);
			match(collected.output, /first answer/);
			ok(bundle.contract.detached?.get(batchId)?.collectedAt !== null, "batch marked collected");

			// Explicit run-id collect works without a batch record.
			const byIds = (await monitor.run({ mode: "collect", run_ids: runIds }, {})) as ToolRunResult;
			strictEqual(byIds.kind, "ok");
			ok(byIds.kind === "ok" && byIds.details?.complete === true);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("nudges when a batch is ready and stays silent after collect", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => okWorker() });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const monitor = createMonitorTool({ dispatch: bundle.contract });
			const registration = createDetachedDispatchNudgeRegistration({
				getOpenBatches: () => openDetachedBatchViews(bundle.contract),
			});
			strictEqual(registration.id, DETACHED_DISPATCH_NUDGE_REGISTRATION_ID);

			// No batches yet: silent.
			deepStrictEqual(registration.evaluate(turnEndInput()), []);

			const result = (await tool.run({ tasks: ["nudge me"], detach: true }, {})) as ToolRunResult;
			strictEqual(result.kind, "ok");
			const batchId = result.details?.batchId as string;
			const runIds = result.details?.runIds as string[];
			const runId = runIds[0];
			ok(runId !== undefined);
			await waitFor(() => bundle.contract.getRun(runId)?.status === "completed", "detached run finalized");

			const effects = registration.evaluate(turnEndInput());
			deepStrictEqual(
				effects.map((effect) => effect.kind),
				["request_continuation", "inject_reminder"],
			);
			const first = effects[0];
			ok(first?.kind === "request_continuation");
			ok(first.message.includes(batchId));
			match(first.message, /mode="collect"/);

			// Aborted turns and monitor-less surfaces stay silent even when ready.
			deepStrictEqual(registration.evaluate(turnEndInput({ metadata: { stopReason: "aborted" } })), []);
			deepStrictEqual(
				registration.evaluate(turnEndInput({ metadata: { stopReason: "stop", activeToolNames: "read,edit" } })),
				[],
			);

			const collected = (await monitor.run({ mode: "collect", batch_id: batchId }, {})) as ToolRunResult;
			strictEqual(collected.kind, "ok");
			// Collection suppresses the nudge from then on.
			deepStrictEqual(registration.evaluate(turnEndInput()), []);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("wait blocks to terminal state and reports an honest timeout", async () => {
		const gated = gatedWorker();
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => gated.worker });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const monitor = createMonitorTool({ dispatch: bundle.contract });
			const result = (await tool.run({ tasks: ["long haul"], detach: true }, {})) as ToolRunResult;
			strictEqual(result.kind, "ok");
			const runIds = result.details?.runIds as string[];
			const runId = runIds[0];
			ok(runId !== undefined);

			const timedOut = (await monitor.run({ mode: "wait", run_id: runId, timeout_ms: 300 }, {})) as ToolRunResult;
			strictEqual(timedOut.kind, "ok");
			ok(timedOut.kind === "ok");
			strictEqual(timedOut.details?.timedOut, true);
			match(timedOut.output, /wait timed out after 300ms/);

			gated.finish(0);
			const done = (await monitor.run({ mode: "wait", run_id: runId, timeout_ms: 8000 }, {})) as ToolRunResult;
			strictEqual(done.kind, "ok");
			ok(done.kind === "ok");
			strictEqual(done.details?.timedOut, false);
			strictEqual(done.details?.status, "completed");
			match(done.output, /wait complete after \d+ms/);

			const missing = (await monitor.run({ mode: "wait", run_id: "no-such-run", timeout_ms: 100 }, {})) as ToolRunResult;
			strictEqual(missing.kind, "error");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("collect works after a resume: a new bundle over the same state dir gathers the batch", async () => {
		const context = dispatchStubContext();
		const first = makeDispatchBundle(context, { spawnWorker: () => okWorker("resumed answer") });
		await first.extension.start();
		let batchId = "";
		let runIds: string[] = [];
		try {
			const tool = createDispatchTool({ dispatch: first.contract });
			const result = (await tool.run({ tasks: ["survive exit"], detach: true }, {})) as ToolRunResult;
			strictEqual(result.kind, "ok");
			batchId = result.details?.batchId as string;
			runIds = result.details?.runIds as string[];
			const runId = runIds[0];
			ok(runId !== undefined);
			await waitFor(() => first.contract.getRun(runId)?.status === "completed", "run finalized before exit");
		} finally {
			// Session exit: drain persists the ledger; the batch record is already durable.
			await first.extension.stop?.();
		}

		const second = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => okWorker() });
		await second.extension.start();
		try {
			// The open batch is visible to the new session's nudge surface.
			const views = openDetachedBatchViews(second.contract);
			deepStrictEqual(views, [{ id: batchId, total: 1, terminal: 1 }]);

			const monitor = createMonitorTool({ dispatch: second.contract });
			const collected = (await monitor.run({ mode: "collect", batch_id: batchId }, {})) as ToolRunResult;
			strictEqual(collected.kind, "ok");
			ok(collected.kind === "ok");
			strictEqual(collected.details?.complete, true);
			strictEqual(collected.details?.failedCount, 0);
			const runsDetail = collected.details?.runs as Array<{ runId: string; receiptPath: string | null }>;
			deepStrictEqual(
				runsDetail.map((run) => run.runId),
				runIds,
			);
			ok(
				runsDetail.every((run) => run.receiptPath !== null),
				"receipts survive the resume",
			);
			ok(second.contract.detached?.get(batchId)?.collectedAt !== null, "collection state is durable");
			deepStrictEqual(openDetachedBatchViews(second.contract), []);
		} finally {
			await second.extension.stop?.();
		}
	});
});
