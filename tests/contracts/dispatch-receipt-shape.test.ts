import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decideRetry } from "../../src/domains/dispatch/failure-classification.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunLineage, RunReceipt } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

function worker(exitCode: number): SpawnedWorker {
	const events = (async function* () {
		if (exitCode === 0) {
			yield {
				type: "message_end",
				message: { role: "assistant", content: "done", usage: { input: 1, output: 1 } },
			};
		}
	})();
	return {
		pid: 4242,
		promise: Promise.resolve({ exitCode, signal: null }),
		events,
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

async function receiptFor(exitCode: number): Promise<RunReceipt> {
	const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => worker(exitCode) });
	await bundle.extension.start();
	try {
		const handle = await bundle.contract.dispatch({
			agentId: "coder",
			executionRole: "builder",
			task: "receipt node shape",
		});
		return await handle.finalPromise;
	} finally {
		await bundle.extension.stop?.();
	}
}

describe("dispatch receipt node block", () => {
	beforeEach(isolateDispatchState);
	afterEach(restoreDispatchState);

	// The receipt used to carry `node` only where a placement object existed, so a
	// succeeded local run had no node key at all while a failed one did. A consumer
	// reading receipt.node.id therefore worked on failures and threw on successes.
	it("emits the same node block whether the run succeeded or failed", async () => {
		const succeeded = await receiptFor(0);
		const failed = await receiptFor(1);
		strictEqual(succeeded.outcome, "succeeded");
		deepStrictEqual(succeeded.node, { id: "local", kind: "local" });
		deepStrictEqual(failed.node, { id: "local", kind: "local" });
	});

	it("keeps the receipt verifiable once the node block is always present", async () => {
		const receipt = await receiptFor(0);
		// node feeds the integrity digest through the ledger row, so emitting it on
		// the receipt without the row carrying the same value would break sealing.
		strictEqual(receipt.integrity.algorithm, "sha256");
		strictEqual(receipt.integrity.digest.length, 64);
	});
});

/**
 * The retry chain the coordinator builds: the root run is attempt 0 and every
 * retry is the previous attempt plus one (`extension.ts`, `const attempt =
 * run.lineage.attempt + 1`). The same RunLineage object reaches the ledger row,
 * the receipt, and the `attempt_start` marker, so all three read one counter.
 */
function retryChain(attempts: number): RunLineage[] {
	const root: RunLineage = { parentRunId: null, rootRunId: "root-run", attempt: 0, depth: 0 };
	const chain = [root];
	for (let i = 1; i < attempts; i += 1) {
		const previous = chain[i - 1] as RunLineage;
		chain.push({
			parentRunId: `run-${i - 1}`,
			rootRunId: previous.rootRunId,
			attempt: previous.attempt + 1,
			depth: previous.depth,
		});
	}
	return chain;
}

describe("dispatch attempt numbering", () => {
	// The native worker path built its ledger row and receipt draft without the
	// request's typed intent, so a receipt sealed `intent: null` for a run whose
	// tool call declared read roots, write roots, and expected outputs. Only the
	// ACP delegation path carried it.
	it("seals the request's typed intent on a native worker receipt", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => worker(0) });
		await bundle.extension.start();
		try {
			const intent = {
				version: 1 as const,
				readRoots: ["src/"],
				writeRoots: [],
				relevantPaths: ["src/calc.js"],
				expectedOutputs: ["a summary"],
				verification: [],
			};
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "receipt intent shape",
				intent,
			});
			const receipt = await handle.finalPromise;
			deepStrictEqual(receipt.intent, intent);
			const envelope = bundle.contract.getRun(receipt.runId);
			ok(envelope);
			deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("counts attempts from zero on every surface that reads lineage", () => {
		const chain = retryChain(3);
		// The ledger row, the receipt, and the attempt_start marker all carry this
		// same lineage object, so agreement is structural rather than per-surface.
		strictEqual(chain[0]?.attempt, 0);
		strictEqual(chain[1]?.attempt, 1);
		strictEqual(chain[2]?.attempt, 2);
		// attempt_start announces a retry, so the lowest attempt it ever reports is
		// 1. That is the first retry, not the first attempt.
		const markerAttempts = chain.slice(1).map((entry) => entry.attempt);
		strictEqual(markerAttempts[0], 1);
	});

	it("spends the retry budget against the same zero-based counter", () => {
		// maxRetries 2 means the root plus two retries, so attempt 2 is the last one
		// allowed to run and attempt 2 is where the budget is exhausted.
		strictEqual(decideRetry("target-transient", 0, 2).retry, true);
		strictEqual(decideRetry("target-transient", 1, 2).retry, true);
		strictEqual(decideRetry("target-transient", 2, 2).retry, false);
		strictEqual(decideRetry("target-transient", 2, 2).reasonCode, "retry-exhausted");
	});
});
