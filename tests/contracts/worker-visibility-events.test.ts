/**
 * DispatchStarted must carry enough identity to draw a worker's transcript
 * header before any receipt exists: which logical assignment the attempt
 * belongs to, which attempt it is, and (agent origin) which tool call spawned
 * it. Without the assignment id a failover renders as two unrelated blocks;
 * without the parent call id an agent-driven fan-out cannot nest under the
 * tool segment that started it.
 */

import { ok, strictEqual } from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { BusChannels, type DispatchStartedPayload } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { routeValidationProjection } from "../../src/domains/dispatch/active-route-planner.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

function worker(exitCode: number, text?: string): SpawnedWorker {
	const events = (async function* () {
		if (text !== undefined) {
			yield { type: "message_end", message: { role: "assistant", content: text, usage: { input: 1, output: 1 } } };
		}
	})();
	return {
		pid: 9100 + exitCode,
		promise: Promise.resolve({ exitCode, signal: null }),
		events,
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

describe("dispatch started identity", () => {
	beforeEach(() => isolateDispatchState());
	after(() => restoreDispatchState());

	it("keys every attempt of a failover to one assignment and numbers the attempts", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		let spawns = 0;
		const context = dispatchStubContext({ settings });
		const started: DispatchStartedPayload[] = [];
		context.bus.on(BusChannels.DispatchStarted, (payload) => {
			started.push(payload);
		});
		const bundle = makeDispatchBundle(context, {
			resilienceCooldownMs: 0,
			spawnWorker: () => (++spawns === 1 ? worker(1) : worker(0, "recovered")),
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "recover once",
			});
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "succeeded");
			strictEqual(started.length, 2);
			strictEqual(started[0]?.assignmentId, handle.runId);
			strictEqual(started[1]?.assignmentId, handle.runId);
			strictEqual(started[0]?.attempt, 0);
			strictEqual(started[1]?.attempt, 1);
			// The second attempt is a distinct run under the same assignment; a
			// surface keyed on runId would draw two blocks for one piece of work.
			ok(started[1]?.runId !== started[0]?.runId);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("republishes the spawning tool call id and omits it when the caller had none", async () => {
		const context = dispatchStubContext();
		const started: DispatchStartedPayload[] = [];
		context.bus.on(BusChannels.DispatchStarted, (payload) => {
			started.push(payload);
		});
		const bundle = makeDispatchBundle(context, { spawnWorker: () => worker(0, "done") });
		await bundle.extension.start();
		try {
			const nested = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "nested",
				parentToolCallId: "call_42",
			});
			await nested.finalPromise;
			const bare = await bundle.contract.dispatch({ agentId: "coder", executionRole: "builder", task: "bare" });
			await bare.finalPromise;
			strictEqual(started.find((payload) => payload.runId === nested.runId)?.parentToolCallId, "call_42");
			strictEqual(started.find((payload) => payload.runId === bare.runId)?.parentToolCallId, undefined);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("keeps the parent call id out of the model-authored job spec", () => {
		const request: DispatchRequest = {
			agentId: "coder",
			executionRole: "builder",
			task: "nested",
			parentToolCallId: "call_42",
		};
		const projection = routeValidationProjection(request);
		ok(!Object.hasOwn(projection.jobSpec, "parentToolCallId"));
		strictEqual(projection.restore(projection.jobSpec).parentToolCallId, "call_42");
	});
});
