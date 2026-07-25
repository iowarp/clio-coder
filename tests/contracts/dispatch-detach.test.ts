import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, beforeEach, describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import {
	createDetachedDispatchNudgeRegistration,
	DETACHED_DISPATCH_NUDGE_REGISTRATION_ID,
	openDetachedBatchViews,
} from "../../src/domains/middleware/dispatch-nudge.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { createDispatchRunEventRegistry, createDispatchTool } from "../../src/tools/dispatch.js";
import { createMonitorTool } from "../../src/tools/monitor.js";
import { createSteerTool } from "../../src/tools/steer.js";
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

function steerableGatedWorker(): {
	worker: SpawnedWorker;
	finish: () => void;
	sent: unknown[];
} {
	let settle!: (result: SpawnedWorkerResult) => void;
	const promise = new Promise<SpawnedWorkerResult>((resolve) => {
		settle = resolve;
	});
	const queued: unknown[] = [];
	const readers: Array<(event: unknown) => void> = [];
	let ended = false;
	const emit = (event: unknown): void => {
		const reader = readers.shift();
		if (reader) reader(event);
		else queued.push(event);
	};
	const events = (async function* (): AsyncIterableIterator<unknown> {
		while (!ended || queued.length > 0) {
			const event = queued.shift() ?? (await new Promise<unknown>((resolve) => readers.push(resolve)));
			yield event;
		}
	})();
	const sent: unknown[] = [];
	return {
		worker: {
			pid: 102,
			promise,
			events,
			abort: () => {
				ended = true;
				emit({ type: "clio_worker_aborted" });
				settle({ exitCode: null, signal: "SIGTERM" });
			},
			heartbeatAt: { current: Date.now() },
			send: (value: unknown) => {
				sent.push(value);
				emit({ type: "clio_steer_received", payload: { text: "focus on tests" } });
				return true;
			},
		},
		finish: () => {
			emit({
				type: "message_end",
				message: { role: "assistant", content: "steered sync done", usage: { input: 1, output: 1 } },
			});
			ended = true;
			emit({ type: "clio_worker_complete" });
			settle({ exitCode: 0, signal: null });
		},
		sent,
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
			const runEvents = createDispatchRunEventRegistry();
			const tool = createDispatchTool({ dispatch: bundle.contract, runEvents });
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
			const runEvents = createDispatchRunEventRegistry();
			const tool = createDispatchTool({ dispatch: bundle.contract, runEvents });
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
				() => runIds.every((runId) => (runEvents.eventTail(runId)?.entries.length ?? 0) >= 1),
				"run tails buffered in the background",
			);
			const monitor = createMonitorTool({ dispatch: bundle.contract, runEvents });
			const firstRunId = runIds[0];
			ok(firstRunId !== undefined);
			const peek = (await monitor.run({ mode: "peek", run_id: firstRunId }, {})) as ToolRunResult;
			strictEqual(peek.kind, "ok");
			ok(peek.kind === "ok" && (peek.details?.eventCount as number) >= 1, "run tail buffered for peek");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("classifies the same missing-final event stream identically for synchronous and detached dispatch", async () => {
		const missingFinalWorker = (): SpawnedWorker => ({
			pid: 103,
			promise: Promise.resolve({ exitCode: 0, signal: null }),
			events: (async function* () {
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: "toolUse",
						content: [
							{ type: "text", text: "I will inspect one more file." },
							{ type: "toolCall", name: "read", arguments: { path: "README.md" } },
						],
					},
				};
			})(),
			abort: () => {},
			heartbeatAt: { current: Date.now() },
		});
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: missingFinalWorker,
			resilienceCooldownMs: 0,
		});
		await bundle.extension.start();
		try {
			const runEvents = createDispatchRunEventRegistry();
			const dispatch = createDispatchTool({ dispatch: bundle.contract, runEvents });
			const synchronous = (await dispatch.run({ task: "synchronous missing final" }, approvedDispatch)) as ToolRunResult;
			strictEqual(synchronous.kind, "error");
			ok(synchronous.kind === "error");
			const synchronousRunId = (synchronous.details?.runIds as string[] | undefined)?.[0];
			ok(synchronousRunId);
			const synchronousRow = bundle.contract.getRun(synchronousRunId);
			strictEqual(synchronousRow?.outcome, "failed");
			strictEqual(synchronousRow?.outcomeCode, "worker_final_output_missing");
			ok(!synchronous.message.includes("I will inspect one more file."), "transient preamble is not a successful answer");

			const detached = (await dispatch.run(
				{ tasks: ["detached missing final"], detach: true },
				{ sessionId: "session-missing-final", ...approvedDispatch },
			)) as ToolRunResult;
			ok(detached.kind === "ok", detached.kind === "error" ? detached.message : "detached dispatch failed");
			const batchId = detached.details?.batchId as string;
			const detachedRunId = (detached.details?.runIds as string[])[0];
			ok(detachedRunId);
			await waitFor(() => bundle.contract.getRun(detachedRunId)?.status === "failed", "detached run classified");
			await waitFor(
				() => bundle.contract.assignments?.getStored(detachedRunId)?.status !== "running",
				"detached assignment settled",
			);
			const detachedRow = bundle.contract.getRun(detachedRunId);
			strictEqual(detachedRow?.outcome, synchronousRow?.outcome);
			strictEqual(detachedRow?.outcomeCode, synchronousRow?.outcomeCode);

			const monitor = createMonitorTool({ dispatch: bundle.contract, runEvents });
			const collected = (await monitor.run({ mode: "collect", batch_id: batchId }, {})) as ToolRunResult;
			strictEqual(collected.kind, "ok");
			ok(collected.kind === "ok");
			match(collected.output, /collect complete .*failed=1/);
			ok(!collected.output.includes("I will inspect one more file."), "collect exposes no transient preamble");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("the dispatch contract lets an interactive operator monitor and steer an in-flight synchronous native run", async () => {
		const gated = steerableGatedWorker();
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => gated.worker });
		await bundle.extension.start();
		try {
			const runEvents = createDispatchRunEventRegistry();
			const tool = createDispatchTool({ dispatch: bundle.contract, runEvents });
			const monitor = createMonitorTool({ dispatch: bundle.contract, runEvents });
			const steer = createSteerTool({ dispatch: bundle.contract });
			// Direct concurrent ToolSpec calls emulate operator/TUI contract access;
			// they do not imply that the sequential parent-model tool scheduler can
			// interleave monitor or steer while synchronous dispatch is pending.
			const syncResult = tool.run({ task: "stay active for guidance", agent_id: "coder" }, approvedDispatch);
			await waitFor(() => bundle.contract.listRuns().some((run) => run.status === "running"), "sync run admitted");
			const active = bundle.contract.listRuns().find((run) => run.status === "running");
			ok(active, "the synchronous run is operator-addressable through the dispatch contract");

			const status = (await monitor.run({ mode: "status", run_id: active.id }, {})) as ToolRunResult;
			strictEqual(status.kind, "ok");
			strictEqual(status.details?.running, true);
			const guided = (await steer.run(
				{ action: "guide", run_id: active.id, message: "focus on tests" },
				approvedDispatch,
			)) as ToolRunResult;
			strictEqual(guided.kind, "ok");
			const guidedAgain = (await steer.run(
				{ action: "guide", run_id: active.id, message: "  verify café  " },
				approvedDispatch,
			)) as ToolRunResult;
			strictEqual(guidedAgain.kind, "ok");
			deepStrictEqual(gated.sent, [
				{ type: "steer", text: "focus on tests" },
				{ type: "steer", text: "verify café" },
			]);
			await waitFor(
				() => runEvents.eventTail(active.id)?.entries.some((entry) => entry.type === "clio_steer_received") === true,
				"steer acknowledgement reached the registered sync tail",
			);
			const peek = (await monitor.run({ mode: "peek", run_id: active.id }, {})) as ToolRunResult;
			strictEqual(peek.kind, "ok");
			ok(peek.kind === "ok" && peek.output.includes("clio_steer_received"));

			gated.finish();
			const completed = (await syncResult) as ToolRunResult;
			strictEqual(completed.kind, "ok");
			ok(completed.kind === "ok" && completed.output.includes("steered sync done"));
			const terminal = bundle.contract.getRun(active.id);
			ok(terminal?.receiptPath);
			const receipt = JSON.parse(readFileSync(terminal.receiptPath, "utf8")) as RunReceipt;
			deepStrictEqual(
				receipt.steering?.map(({ sequence, bytes, contentHash, acknowledged }) => ({
					sequence,
					bytes,
					contentHash,
					acknowledged,
				})),
				[
					{
						sequence: 1,
						bytes: Buffer.byteLength("focus on tests", "utf8"),
						contentHash: createHash("sha256").update("focus on tests", "utf8").digest("hex"),
						acknowledged: true,
					},
					{
						sequence: 2,
						bytes: Buffer.byteLength("verify café", "utf8"),
						contentHash: createHash("sha256").update("verify café", "utf8").digest("hex"),
						acknowledged: true,
					},
				],
			);
			ok(receipt.steering?.every((entry) => entry.sentAt.length > 0 && entry.acknowledgedAt !== undefined));
			deepStrictEqual(terminal.steering, receipt.steering);
			deepStrictEqual(verifyReceiptIntegrity(receipt, terminal), { ok: true });
			strictEqual(JSON.stringify(receipt).includes("focus on tests"), false);
			strictEqual(JSON.stringify(receipt).includes("verify café"), false);
			strictEqual(JSON.stringify(terminal).includes("focus on tests"), false);
			strictEqual(JSON.stringify(terminal).includes("verify café"), false);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("reports detached registration failure honestly while the registered live drain continues", async () => {
		const gated = gatedWorker();
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => gated.worker });
		await bundle.extension.start();
		try {
			const detached = bundle.contract.detached;
			ok(detached);
			const failingContract = {
				...bundle.contract,
				detached: {
					...detached,
					register: async () => {
						throw new Error("batch store unavailable");
					},
				},
			};
			const runEvents = createDispatchRunEventRegistry();
			const tool = createDispatchTool({ dispatch: failingContract, runEvents });
			const result = (await tool.run({ tasks: ["already live"], detach: true }, approvedDispatch)) as ToolRunResult;
			strictEqual(result.kind, "error");
			ok(result.kind === "error" && result.message.includes("detached runs started"));
			ok(result.kind === "error" && result.message.includes("batch store unavailable"));
			const runId = (result.details?.runIds as string[])[0];
			ok(runId);
			strictEqual(bundle.contract.getRun(runId)?.status, "running");

			gated.finish(0);
			await waitFor(
				() => bundle.contract.getRun(runId)?.status === "completed",
				"live run completed after register failure",
			);
			await waitFor(
				() => runEvents.eventTail(runId)?.entries.some((entry) => entry.type === "message_end") === true,
				"registered drain retained the terminal event after register failure",
			);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("folds one advertised run_ids entry into every single-run monitor mode and preserves run_id precedence", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => okWorker("alias answer") });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const monitor = createMonitorTool({ dispatch: bundle.contract });
			const dispatched = (await tool.run({ tasks: ["monitor alias"], detach: true }, approvedDispatch)) as ToolRunResult;
			strictEqual(dispatched.kind, "ok");
			const runId = (dispatched.details?.runIds as string[])[0];
			ok(runId !== undefined);
			await waitFor(() => bundle.contract.getRun(runId)?.status === "completed", "aliased monitor run finalized");

			for (const mode of ["status", "peek", "receipt", "wait"] as const) {
				const observed = (await monitor.run({ mode, run_ids: [runId] }, {})) as ToolRunResult;
				strictEqual(observed.kind, "ok", `singleton run_ids works for mode=${mode}`);
				ok(observed.kind === "ok");
				strictEqual(observed.details?.runId, runId);
			}

			const defaultStatus = (await monitor.run({ run_ids: [runId] }, {})) as ToolRunResult;
			strictEqual(defaultStatus.kind, "ok");
			ok(defaultStatus.kind === "ok");
			strictEqual(defaultStatus.details?.mode, "status");

			const explicitWins = (await monitor.run(
				{ mode: "status", run_id: runId, run_ids: ["wrong-one", "wrong-two"] },
				{},
			)) as ToolRunResult;
			strictEqual(explicitWins.kind, "ok");
			ok(explicitWins.kind === "ok");
			strictEqual(explicitWins.details?.runId, runId);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("diagnoses empty and multi-entry run_ids on every single-run monitor mode", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => okWorker() });
		await bundle.extension.start();
		try {
			const monitor = createMonitorTool({ dispatch: bundle.contract });
			for (const mode of ["status", "peek", "receipt", "wait"] as const) {
				for (const runIds of [[], ["run-one", "run-two"]]) {
					const diagnosed = (await monitor.run({ mode, run_ids: runIds }, {})) as ToolRunResult;
					strictEqual(diagnosed.kind, "error");
					ok(diagnosed.kind === "error");
					strictEqual(
						diagnosed.message,
						`monitor: mode=${mode} observes one run; got run_ids with ${runIds.length} entries — pass run_id=<one id>, or use mode=collect run_ids=[...] for a batch`,
					);
					ok(!diagnosed.message.includes("requires run_id"), "run_ids mismatch never falls back to the bare error");
				}
			}
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("collect is an assignment barrier: pending snapshot in flight, then terminal retry results", async () => {
		const gated = gatedWorker();
		const workers: Array<() => SpawnedWorker> = [() => okWorker("first answer"), () => gated.worker];
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: () => (workers.shift() ?? okWorker)(),
			resilienceCooldownMs: 0,
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

			const pending = (await monitor.run(
				{ mode: "collect", batch_id: batchId, timeout_ms: 120_000 },
				{},
			)) as ToolRunResult;
			strictEqual(pending.kind, "ok");
			ok(pending.kind === "ok");
			strictEqual(pending.details?.complete, false);
			strictEqual(pending.details?.pendingCount, 1);
			match(pending.output, /collect pending/);
			match(pending.output, /collect never blocks; timeout_ms is ignored — block on one run with mode="wait"\./);
			// An incomplete collect must not close the batch.
			strictEqual(bundle.contract.detached?.get(batchId)?.collectedAt, null);

			gated.finish(1);
			const slowRunId = runIds[1];
			ok(slowRunId !== undefined);
			await waitFor(
				() => bundle.contract.getRun(slowRunId)?.status === "failed",
				"slow first attempt finalized as failed",
			);
			await waitFor(
				() => bundle.contract.assignments?.getStored(slowRunId)?.status !== "running",
				"slow assignment did not settle after retry processing",
			);

			const collected = (await monitor.run(
				{ mode: "collect", batch_id: batchId, timeout_ms: 120_000 },
				{},
			)) as ToolRunResult;
			strictEqual(collected.kind, "ok");
			ok(collected.kind === "ok");
			strictEqual(collected.details?.complete, true);
			strictEqual(collected.details?.failedCount, 0);
			match(collected.output, /collect complete/);
			match(collected.output, /first answer/);
			match(collected.output, /cost=~\$0\.0000 est/, "catalog fallback cost is labeled estimated");
			for (const assignmentId of runIds) {
				const terminalRunId = bundle.contract.assignments?.getStored(assignmentId)?.terminalRunId;
				ok(terminalRunId);
				ok((bundle.contract.getRun(terminalRunId)?.costUsd ?? 0) > 0, "catalog fallback records a nonzero estimate");
			}
			match(collected.output, /collect never blocks; timeout_ms is ignored — block on one run with mode="wait"\./);
			ok(bundle.contract.detached?.get(batchId)?.collectedAt !== null, "batch marked collected");

			// Explicit run-id collect works without a batch record.
			const byIds = (await monitor.run({ mode: "collect", run_ids: runIds }, {})) as ToolRunResult;
			strictEqual(byIds.kind, "ok");
			ok(byIds.kind === "ok" && byIds.details?.complete === true);
			ok(!byIds.output.includes("timeout_ms is ignored"), "collect notice appears only when timeout_ms was passed");
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
			await waitFor(
				() => bundle.contract.assignments?.getStored(runId)?.status !== "running",
				"detached assignment settled",
			);

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
			strictEqual(
				timedOut.output,
				`wait timed out after 300ms: assignment ${runId} is still running and keeps running normally. Wait again or collect later. Only steer(action="cancel") if the result is no longer needed — cancelling discards its work.`,
			);
			ok(timedOut.output.indexOf("Wait again or collect later.") < timedOut.output.indexOf('steer(action="cancel")'));

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

	it("collect returns the durable output after a resume, with its final/partial classification", async () => {
		// First bundle: dispatch without ever consuming the event stream, so the
		// in-process tail never sees the answer and durable state is the only
		// possible source. Finalize, then stop (session exit).
		const context = dispatchStubContext();
		const first = makeDispatchBundle(context, { spawnWorker: () => okWorker("resumed answer") });
		await first.extension.start();
		let runId = "";
		try {
			const handle = await first.contract.dispatch({ agentId: "coder", executionRole: "builder", task: "durable answer" });
			runId = handle.runId;
			await handle.finalPromise;
		} finally {
			await first.extension.stop?.();
		}

		// Second bundle over the same state dir: collect must return the stored
		// output from the verified receipt.
		const second = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => okWorker() });
		await second.extension.start();
		try {
			const monitor = createMonitorTool({ dispatch: second.contract });
			const collected = (await monitor.run({ mode: "collect", run_ids: [runId] }, {})) as ToolRunResult;
			strictEqual(collected.kind, "ok");
			ok(collected.kind === "ok");
			strictEqual(collected.details?.complete, true);
			match(collected.output, /resumed answer/);
			match(collected.output, /agent output:/, "the established collect output subheader is preserved");
			const runsDetail = collected.details?.runs as Array<{
				runId: string;
				output?: { state: string; bytes: number; truncated: boolean };
			}>;
			deepStrictEqual(runsDetail[0]?.output, { state: "final", bytes: 14, truncated: false });
		} finally {
			await second.extension.stop?.();
		}
	});

	it("publishes the inner worker event on DispatchProgress for detached batches", async () => {
		const bus = createSafeEventBus();
		const progress: Array<{ runId: string; event: unknown }> = [];
		bus.on(BusChannels.DispatchProgress, (payload) => {
			progress.push({ runId: payload.runId, event: payload.event });
		});
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: () => ({
				pid: 300,
				promise: Promise.resolve({ exitCode: 0, signal: null }),
				events: (async function* () {
					yield {
						type: "message_update",
						assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "str" },
					};
					yield { type: "clio_tool_finish", payload: { tool: "grep", outcome: "ok" } };
					yield {
						type: "message_end",
						message: { role: "assistant", content: "detached done", usage: { input: 1, output: 1 } },
					};
				})(),
				abort: () => {},
				heartbeatAt: { current: Date.now() },
			}),
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, bus });
			const result = (await tool.run({ tasks: ["board visibility"], detach: true }, {})) as ToolRunResult;
			strictEqual(result.kind, "ok");
			await waitFor(
				() => progress.some((entry) => (entry.event as { type?: string }).type === "message_end"),
				"detached progress reached the bus",
			);
			const types = progress.map((entry) => (entry.event as { type?: string }).type);
			ok(types.includes("message_update"), `board receives direct message_update, got ${types.join(",")}`);
			ok(types.includes("clio_tool_finish"), `board receives direct clio_tool_finish, got ${types.join(",")}`);
			ok(!types.includes("batch_run_event"), "the batch wrapper must not reach the board");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("does not report collected:true when the durable collection mark fails to persist", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => okWorker("collect me") });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const result = (await tool.run({ tasks: ["mark failure"], detach: true }, {})) as ToolRunResult;
			strictEqual(result.kind, "ok");
			const batchId = result.details?.batchId as string;
			const runIds = result.details?.runIds as string[];
			const runId = runIds[0];
			ok(runId !== undefined);
			await waitFor(() => bundle.contract.getRun(runId)?.status === "completed", "detached run finalized");
			await waitFor(
				() => bundle.contract.assignments?.getStored(runId)?.status !== "running",
				"detached assignment settled",
			);

			const detached = bundle.contract.detached;
			ok(detached);
			const failingContract = {
				...bundle.contract,
				detached: {
					...detached,
					markCollected: async () => {
						throw new Error("disk full");
					},
				},
			};
			const monitor = createMonitorTool({ dispatch: failingContract });
			const collected = (await monitor.run({ mode: "collect", batch_id: batchId }, {})) as ToolRunResult;
			strictEqual(collected.kind, "ok");
			ok(collected.kind === "ok");
			strictEqual(collected.details?.complete, true);
			strictEqual(collected.details?.collected, false, "a failed persistence write must not report collected");
			match(collected.output, /could not be marked collected/);
			// The batch record genuinely stayed open.
			strictEqual(bundle.contract.detached?.get(batchId)?.collectedAt, null);
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
			deepStrictEqual(views, [{ id: batchId, total: 1, terminal: 1, terminalOutcomes: { succeeded: 1 } }]);

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
