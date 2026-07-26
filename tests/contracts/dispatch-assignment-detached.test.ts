import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { createDispatchRunEventRegistry, createDispatchTool } from "../../src/tools/dispatch.js";
import { createMonitorTool } from "../../src/tools/monitor.js";
import type { ToolResult } from "../../src/tools/registry.js";
import type { WorkerSpec } from "../../src/worker/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const approvedDispatch = {
	approval: { requestId: "assignment-detached", requestedBy: "test-operator", actionClass: "dispatch" as const },
};

function worker(exitCode: number, text?: string): SpawnedWorker {
	return {
		pid: 9_000 + exitCode,
		promise: Promise.resolve({ exitCode, signal: null }),
		events: (async function* () {
			if (text !== undefined) {
				yield { type: "message_end", message: { role: "assistant", content: text, usage: { input: 1, output: 1 } } };
			}
		})(),
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(message);
}

describe("assignment-aware detached, batch, and pipeline dispatch", () => {
	beforeEach(isolateDispatchState);
	afterEach(restoreDispatchState);

	it("collects the terminal retry with durable attempt history and keeps failed evidence visible", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		let spawns = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => (++spawns === 1 ? worker(1) : worker(0, "detached fallback succeeded")),
		});
		await bundle.extension.start();
		try {
			const dispatch = createDispatchTool({ dispatch: bundle.contract, runEvents: createDispatchRunEventRegistry() });
			const detached = (await dispatch.run({ tasks: ["recover detached"], detach: true }, approvedDispatch)) as ToolResult;
			strictEqual(detached.kind, "ok");
			if (detached.kind !== "ok") return;
			const batchId = detached.details?.batchId as string;
			const assignmentId = (detached.details?.assignmentIds as string[])[0];
			ok(assignmentId);
			strictEqual(bundle.contract.detached?.get(batchId)?.runs[0]?.assignmentId, assignmentId);
			await waitFor(
				() => bundle.contract.assignments?.getStored(assignmentId)?.status === "succeeded",
				"detached assignment did not settle",
			);

			const monitor = createMonitorTool({ dispatch: bundle.contract });
			const collected = (await monitor.run({ mode: "collect", batch_id: batchId }, {})) as ToolResult;
			strictEqual(collected.kind, "ok");
			if (collected.kind !== "ok") return;
			strictEqual(collected.details?.complete, true);
			strictEqual(collected.details?.failedCount, 0);
			match(collected.output, /detached fallback succeeded/);
			const row = (collected.details?.runs as Array<Record<string, unknown>>)[0];
			const attempts = row?.attemptRunIds as string[];
			strictEqual(attempts.length, 2);
			strictEqual(row?.assignmentId, assignmentId);
			strictEqual(row?.terminalRunId, attempts[1]);

			const first = bundle.contract.getRun(attempts[0] ?? "");
			strictEqual(first?.outcome, "failed");
			ok(first?.receiptPath);
			if (first?.receiptPath) {
				const receipt = JSON.parse(readFileSync(first.receiptPath, "utf8")) as RunReceipt;
				deepStrictEqual(verifyReceiptIntegrity(receipt, first), { ok: true });
			}
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("threads the successful retry output into the next pipeline stage", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		let spawns = 0;
		const captured: { secondStageSpec?: WorkerSpec } = {};
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: (spec) => {
				spawns += 1;
				if (spawns === 1) return worker(1);
				if (spawns === 2) return worker(0, "terminal fallback output");
				captured.secondStageSpec = spec;
				return worker(0, "pipeline complete");
			},
		});
		await bundle.extension.start();
		try {
			const dispatch = createDispatchTool({ dispatch: bundle.contract, runEvents: createDispatchRunEventRegistry() });
			const result = await dispatch.run(
				{ mode: "pipeline", tasks: ["produce fallback output", "consume fallback output"] },
				approvedDispatch,
			);
			strictEqual(result.kind, "ok");
			strictEqual(spawns, 3);
			const pipelineMessage = captured.secondStageSpec?.dynamicPromptMessages?.find(
				(message) => message.id === "dispatch-pipeline-input",
			);
			ok(pipelineMessage?.body.includes("terminal fallback output"));
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("canceling an assignment with a queued retry prevents future attempts", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		let spawns = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => {
				spawns += 1;
				return worker(1);
			},
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatchBatch([
				{ agentId: "coder", executionRole: "builder", task: "cancel queued retry" },
			]);
			const assignmentId = handle.assignmentIds[0];
			ok(assignmentId);
			deepStrictEqual(handle.assignmentIds, handle.assignmentIds);
			await waitFor(() => bundle.contract.snapshot().retrying.length === 1, "retry was not queued");
			bundle.contract.abort(assignmentId);
			const [terminal] = await handle.finalPromise;
			strictEqual(terminal?.runId, assignmentId);
			strictEqual(bundle.contract.assignments?.getStored(assignmentId)?.status, "canceled");
			await new Promise((resolve) => setTimeout(resolve, 600));
			strictEqual(spawns, 1);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
