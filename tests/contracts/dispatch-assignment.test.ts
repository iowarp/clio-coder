import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
	throw new Error(message);
}

function worker(exitCode: number, text?: string): SpawnedWorker {
	const events = (async function* () {
		if (text !== undefined) {
			yield { type: "message_end", message: { role: "assistant", content: text, usage: { input: 1, output: 1 } } };
		}
	})();
	return {
		pid: 8000 + exitCode,
		promise: Promise.resolve({ exitCode, signal: null }),
		events,
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

describe("dispatch assignments", () => {
	beforeEach(() => isolateDispatchState());
	after(() => restoreDispatchState());

	it("resolves attached dispatch with the successful terminal retry while retaining attempt one", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		let spawns = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => (++spawns === 1 ? worker(1) : worker(0, "recovered")),
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "recover once" });
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "succeeded");
			ok(terminal.lineage);
			strictEqual(terminal.lineage.rootRunId, handle.runId);
			strictEqual(terminal.lineage.attempt, 1);
			strictEqual(spawns, 2);

			const first = bundle.contract.getRun(handle.runId);
			strictEqual(first?.outcome, "failed");
			ok(first?.receiptPath);
			if (first?.receiptPath) {
				const receipt = JSON.parse(readFileSync(first.receiptPath, "utf8")) as RunReceipt;
				deepStrictEqual(verifyReceiptIntegrity(receipt, first), { ok: true });
			}
			const assignment = bundle.contract.assignments?.get(handle.runId);
			strictEqual(assignment?.status, "succeeded");
			deepStrictEqual(
				assignment?.attempts.map((attempt) => attempt.runId),
				[handle.runId, terminal.runId],
			);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("settles exhausted retries with the last failure and complete history", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => worker(1),
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "always fail" });
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "failed");
			ok(terminal.lineage);
			strictEqual(terminal.lineage.attempt, 1);
			const assignment = bundle.contract.assignments?.get(handle.runId);
			strictEqual(assignment?.status, "failed");
			strictEqual(assignment?.terminalReceipt?.runId, terminal.runId);
			strictEqual(assignment?.attempts.length, 2);
			ok(assignment?.attempts.every((attempt) => attempt.receiptDigest.length === 64));
			ok(assignment?.attempts.every((attempt) => bundle.contract.getRun(attempt.runId) !== null));
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("settles a queued retry deterministically when the extension stops", async () => {
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
		const handle = await bundle.contract.dispatch({ agentId: "coder", task: "queue then stop" });
		// The first attempt fails and its retry is queued behind a backoff timer.
		await waitFor(() => bundle.contract.snapshot().retrying.length === 1, "retry queued");
		await bundle.extension.stop?.();
		// finalPromise resolves (never hangs) to the last immutable attempt receipt,
		// and the durable record is terminal rather than stuck running.
		const terminal = await handle.finalPromise;
		strictEqual(terminal.outcome, "failed");
		strictEqual(bundle.contract.assignments?.getStored(handle.runId)?.status, "canceled");
		strictEqual(spawns, 1, "the queued retry never spawned after shutdown");
	});

	it("reconciles an orphaned running assignment against ledger state on restart", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 0;
		const bundleA = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => worker(0, "done"),
		});
		await bundleA.extension.start();
		const handle = await bundleA.contract.dispatch({ agentId: "coder", task: "orphan me" });
		const terminal = await handle.finalPromise;
		strictEqual(terminal.outcome, "succeeded");
		await bundleA.extension.stop?.();

		// Simulate a crash that persisted the attempt ledger/receipt but not the
		// assignment settle: flip the durable record back to running.
		const storePath = join(clioStateDir(), "assignments.json");
		const store = JSON.parse(readFileSync(storePath, "utf8")) as {
			assignments: Array<{ status: string; terminalRunId: string | null }>;
		};
		for (const record of store.assignments) {
			record.status = "running";
			record.terminalRunId = null;
		}
		writeFileSync(storePath, JSON.stringify(store));

		// A fresh bundle over the same state dir reconciles the orphan on start.
		const bundleB = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => worker(0),
		});
		await bundleB.extension.start();
		try {
			const stored = bundleB.contract.assignments?.getStored(handle.runId);
			strictEqual(stored?.status, "succeeded");
			strictEqual(stored?.terminalRunId, terminal.runId);
		} finally {
			await bundleB.extension.stop?.();
		}
	});

	it("canceling the root attempt starts no retry", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		let resolveExit!: (result: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
		const exit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			resolveExit = resolve;
		});
		let spawns = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: () => {
				spawns += 1;
				return {
					pid: 8100,
					promise: exit,
					events: (async function* (): AsyncIterableIterator<unknown> {})(),
					abort: () => resolveExit({ exitCode: 1, signal: "SIGTERM" }),
					heartbeatAt: { current: Date.now() },
				};
			},
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "cancel assignment" });
			bundle.contract.abort(handle.runId);
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "canceled");
			strictEqual(bundle.contract.assignments?.get(handle.runId)?.status, "canceled");
			await new Promise((resolve) => setTimeout(resolve, 600));
			strictEqual(spawns, 1);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
