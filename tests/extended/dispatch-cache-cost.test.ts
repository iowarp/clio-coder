import { ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

beforeEach(() => isolateDispatchState());
afterEach(() => restoreDispatchState());

for (const priced of [true, false]) {
	test(`native dispatch retains SDK per-call cost with ${priced ? "declared" : "unknown"} flat rates`, async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		settings.targets = [
			{
				id: "fixture",
				runtime: "openai-compat",
				defaultModel: "fixture",
				...(priced ? { pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } } : {}),
			},
		];
		settings.fleet.default.target = "fixture";
		settings.fleet.default.model = "fixture";
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let observed!: () => void;
		const seen = new Promise<void>((resolve) => {
			observed = resolve;
		});
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			spawnWorker: () => ({
				pid: null,
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort: release,
				promise: gate.then(() => ({ exitCode: 1, signal: null })),
				events: (async function* () {
					// Pi-normalized exclusive buckets. 1h is inside cacheWrite.
					yield {
						type: "message_end",
						message: {
							role: "assistant",
							stopReason: "error",
							usage: {
								input: 2000,
								output: 100,
								cacheRead: 6000,
								cacheWrite: 2000,
								cacheWrite1h: 500,
								totalTokens: 10100,
								cost: { total: 0.0175 },
							},
						},
					};
					// Old peers without calculated cost still use the declared fallback.
					yield {
						type: "message_end",
						message: {
							role: "assistant",
							stopReason: "aborted",
							usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					};
					observed();
					await gate;
				})(),
			}),
		});
		await bundle.extension.start();
		try {
			const run = await bundle.contract.dispatch({
				agentId: "scout",
				task: "Inspect fixture input.",
				executionRole: "researcher",
				requestOrigin: "internal",
			});
			await seen;
			const expected = 0.0175 + (priced ? 0.001 : 0);
			strictEqual(bundle.contract.snapshot().running[0]?.costUsd, expected);
			release();
			const receipt = await run.finalPromise;
			strictEqual(receipt.costUsd, expected);
			strictEqual(receipt.cacheWrite1hTokenCount, 500);
			strictEqual(receipt.tokenCount, 11100, "do not count the one-hour subset twice");
			const envelope = bundle.contract.getRun(run.runId);
			ok(envelope);
			strictEqual(envelope.costUsd, expected);
			ok(verifyReceiptIntegrity(receipt, envelope).ok);
			ok(!verifyReceiptIntegrity({ ...receipt, cacheWrite1hTokenCount: 0 }, envelope).ok);
		} finally {
			release();
			await bundle.extension.stop?.();
		}
	});
}
