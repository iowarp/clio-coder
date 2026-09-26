/**
 * BT-016. `/run --read-only coder ...` enforced the restriction (both edits and
 * the verify call came back `denied: this run is read-only`), but no receipt
 * field recorded it. The restriction could only be inferred from denial
 * strings, which exist only when the worker tried to write, so a read-only run
 * that never attempted a write sealed a receipt indistinguishable from a
 * normal run's.
 *
 * The sealed receipt is the durable record of how a run was authorized, so it
 * names the restriction itself. The marker is optional and absent on runs that
 * could write, so their receipts keep the exact shape and digest they had.
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

async function sealedReceipt(request: Partial<DispatchRequest>): Promise<RunReceipt> {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
		heartbeatIntervalMs: 3_600_000,
		spawnWorker: () => {
			// The worker only reads, so no denial string ever reaches the receipt.
			const worker: SpawnedWorker = {
				pid: null,
				promise: Promise.resolve({ exitCode: 0, signal: null }),
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort: () => {},
				send: () => true,
				events: (async function* () {
					yield { type: "clio_coder_tool_finish", payload: { tool: "read", outcome: "ok", durationMs: 1 } };
					yield {
						type: "message_end",
						message: { role: "assistant", stopReason: "stop", content: "Read lib/math.js." },
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
			task: "Add a modulo(a, b) export to lib/math.js and a test for it.",
			requestOrigin: "user",
			...request,
		});
		const receipt = await run.finalPromise;
		const stored = bundle.contract.getRun(run.runId);
		ok(stored);
		deepStrictEqual(verifyReceiptIntegrity(receipt, stored), { ok: true });
		return receipt;
	} finally {
		await bundle.extension.stop?.();
	}
}

describe("a read-only run names its restriction in the receipt (BT-016)", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("seals safety.readOnly when the request made the run read-only", async () => {
		const receipt = await sealedReceipt({ readOnly: true });
		equal(receipt.safety?.blockedAttempts.length, 0);
		equal(receipt.safety?.readOnly, true);
	});

	it("seals safety.readOnly when the recipe itself is read-only", async () => {
		const receipt = await sealedReceipt({
			agentId: "scout",
			executionRole: "researcher",
			requestOrigin: "internal",
			task: "Inspect which functions lib/math.js exports.",
		});
		equal(receipt.safety?.readOnly, true);
	});

	it("leaves a run that could write without the key, so its shape is unchanged", async () => {
		const receipt = await sealedReceipt({});
		ok(receipt.safety);
		ok(!("readOnly" in receipt.safety));
	});
});
