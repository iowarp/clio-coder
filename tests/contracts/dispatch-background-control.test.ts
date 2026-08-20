/**
 * Operator-initiated attach to detach conversion (the Alt+S / Ctrl+Alt+B seam).
 *
 * The contract pinned here is that firing the control on a running attached
 * dispatch resolves the tool call early in the honest detached shape, leaves
 * the runs alive, and writes the same durable batch record a `detach: true`
 * call would have written, so monitor collect and the completion nudge attach
 * to it unchanged. Topologies that hold gate or stage state in the awaiting
 * turn refuse instead, with the reason the keypress feedback renders.
 */

import { match, ok, strictEqual } from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import {
	createDispatchBackgroundRegistry,
	createDispatchRunEventRegistry,
	createDispatchTool,
} from "../../src/tools/dispatch.js";
import { createMonitorTool } from "../../src/tools/monitor.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

type ToolRunResult =
	| { kind: "ok"; output: string; details?: Record<string, unknown> }
	| { kind: "error"; message: string; details?: Record<string, unknown> };

const approvedDispatch = {
	approval: { requestId: "test-background-approval", requestedBy: "test-operator", actionClass: "dispatch" as const },
};

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(message);
}

/** Worker that stays in flight until the test releases it. */
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
			pid: 210,
			promise,
			events,
			abort: () => settle({ exitCode: null, signal: "SIGTERM" }),
			heartbeatAt: { current: Date.now() },
		},
		finish: (exitCode: number) => settle({ exitCode, signal: null }),
	};
}

describe("operator-initiated dispatch backgrounding", () => {
	beforeEach(async () => {
		await isolateDispatchState();
	});
	after(() => {
		restoreDispatchState();
	});

	it("no attached dispatch answers with a no-op notice instead of a silent key", () => {
		const background = createDispatchBackgroundRegistry();
		const outcome = background.backgroundNewest();
		strictEqual(outcome.ok, false);
		match(outcome.message, /no attached dispatch is running/);
		strictEqual(background.size(), 0);
	});

	it("converts a running parallel dispatch: detached-shape result, durable record, runs survive, collect works", async () => {
		const gates = [gatedWorker(), gatedWorker()];
		let spawned = 0;
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: () => {
				const gate = gates[spawned++];
				ok(gate !== undefined, "worker gate available");
				return gate.worker;
			},
		});
		await bundle.extension.start();
		try {
			const runEvents = createDispatchRunEventRegistry();
			const background = createDispatchBackgroundRegistry();
			const tool = createDispatchTool({
				getAgentSpecs: () => [],
				dispatch: bundle.contract,
				runEvents,
				background,
			});
			const call = tool.run(
				{ tasks: ["slow one", "slow two"] },
				{
					sessionId: "session-background",
					toolCallId: "call-parallel",
					...approvedDispatch,
				},
			) as Promise<ToolRunResult>;

			await waitFor(() => background.size() === 1, "attached dispatch registered a background control");
			const fired = background.backgroundNewest();
			strictEqual(fired.ok, true);
			match(fired.message, /moving to the background/);
			// The control drops itself so a second keypress reaches the next call.
			strictEqual(background.size(), 0);

			const result = await call;
			strictEqual(result.kind, "ok");
			ok(result.kind === "ok");
			match(result.output, /moved to the background by the operator/);
			match(result.output, /monitor\(mode="collect"/);
			strictEqual(result.details?.mode, "detached");
			strictEqual(result.details?.conversion, "operator-backgrounded");
			const batchId = result.details?.batchId as string;
			const runIds = result.details?.assignmentIds as string[];
			strictEqual(runIds.length, 2);

			// The same durable record a detach:true call writes.
			const record = bundle.contract.detached?.get(batchId);
			ok(record, "durable batch record written for the converted batch");
			strictEqual(record?.collectedAt, null);
			strictEqual(record?.sessionId, "session-background");
			strictEqual(record?.runs.length, 2);

			// The runs were never touched by the conversion; they finish normally.
			for (const gate of gates) gate.finish(0);
			await waitFor(
				() => runIds.every((runId) => bundle.contract.getRun(runId)?.status === "completed"),
				"converted runs finalize in the background",
			);
			// Assignment settlement is what collect reads, and it lands a tick after
			// the ledger row does.
			await waitFor(
				() => runIds.every((runId) => (bundle.contract.assignments?.get(runId)?.status ?? "running") !== "running"),
				"converted assignments settle in the background",
			);

			const monitor = createMonitorTool({ dispatch: bundle.contract, runEvents });
			const collected = (await monitor.run({ mode: "collect", batch_id: batchId }, {})) as ToolRunResult;
			strictEqual(collected.kind, "ok");
			ok(collected.kind === "ok");
			match(collected.output, /collect complete/);
			strictEqual(bundle.contract.detached?.get(batchId)?.collectedAt === null, false);
		} finally {
			for (const gate of gates) gate.finish(0);
			await bundle.extension.stop?.();
		}
	});

	it("converting mid-sequence names the steps that were never dispatched", async () => {
		const gates = [gatedWorker(), gatedWorker()];
		let spawned = 0;
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: () => {
				const gate = gates[spawned++];
				ok(gate !== undefined, "worker gate available");
				return gate.worker;
			},
		});
		await bundle.extension.start();
		try {
			const runEvents = createDispatchRunEventRegistry();
			const background = createDispatchBackgroundRegistry();
			const tool = createDispatchTool({
				getAgentSpecs: () => [],
				dispatch: bundle.contract,
				runEvents,
				background,
			});
			const call = tool.run(
				{ tasks: ["step one", "step two"], mode: "sequential" },
				{
					sessionId: "session-sequential",
					toolCallId: "call-sequential",
					...approvedDispatch,
				},
			) as Promise<ToolRunResult>;

			await waitFor(() => background.size() === 1, "sequential dispatch registered a background control");
			strictEqual(background.backgroundNewest().ok, true);

			const result = await call;
			strictEqual(result.kind, "ok");
			ok(result.kind === "ok");
			// One live step converts; the later step is honestly reported as unstarted
			// rather than folded into a batch that would never produce it.
			strictEqual((result.details?.assignmentIds as string[]).length, 1);
			strictEqual((result.details?.undispatchedAgentIds as string[]).length, 1);
			match(result.output, /were never dispatched/);
			strictEqual(spawned, 1);
		} finally {
			for (const gate of gates) gate.finish(0);
			await bundle.extension.stop?.();
		}
	});

	it("a review gate refuses the conversion with a one-line reason and keeps running", async () => {
		const gate = gatedWorker();
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => gate.worker });
		await bundle.extension.start();
		try {
			const runEvents = createDispatchRunEventRegistry();
			const background = createDispatchBackgroundRegistry();
			const tool = createDispatchTool({
				getAgentSpecs: () => [],
				dispatch: bundle.contract,
				runEvents,
				background,
			});
			const call = tool.run(
				{ task: "gated work", review: true },
				{
					sessionId: "session-review",
					toolCallId: "call-review",
					...approvedDispatch,
				},
			) as Promise<ToolRunResult>;

			await waitFor(() => background.size() === 1, "review-gated dispatch registered a background control");
			const refused = background.backgroundNewest();
			strictEqual(refused.ok, false);
			match(refused.message, /cannot be backgrounded: a review gate holds its cycle state in this turn/);
			// A refusal leaves the control in place: the call is still running.
			strictEqual(background.size(), 1);

			gate.finish(1);
			await call;
		} finally {
			gate.finish(1);
			await bundle.extension.stop?.();
		}
	});

	it("a timeout_ms deadline refuses the conversion rather than dropping the deadline", async () => {
		const gate = gatedWorker();
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => gate.worker });
		await bundle.extension.start();
		try {
			const runEvents = createDispatchRunEventRegistry();
			const background = createDispatchBackgroundRegistry();
			const tool = createDispatchTool({
				getAgentSpecs: () => [],
				dispatch: bundle.contract,
				runEvents,
				background,
			});
			const call = tool.run(
				{ task: "timed work", timeout_ms: 60_000 },
				{
					toolCallId: "call-timed",
					...approvedDispatch,
				},
			) as Promise<ToolRunResult>;

			await waitFor(() => background.size() === 1, "timed dispatch registered a background control");
			const refused = background.backgroundNewest();
			strictEqual(refused.ok, false);
			match(refused.message, /timeout_ms=60000/);

			gate.finish(0);
			await call;
		} finally {
			gate.finish(0);
			await bundle.extension.stop?.();
		}
	});

	it("without a registry wired, attached dispatch behaves exactly as before", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: () => {
				const gate = gatedWorker();
				gate.finish(0);
				return gate.worker;
			},
		});
		await bundle.extension.start();
		try {
			const runEvents = createDispatchRunEventRegistry();
			const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: bundle.contract, runEvents });
			const result = (await tool.run(
				{ task: "plain work" },
				{
					toolCallId: "call-unwired",
					...approvedDispatch,
				},
			)) as ToolRunResult;
			strictEqual(result.kind, "ok");
			ok(result.kind === "ok");
			strictEqual(result.details?.conversion, undefined);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
