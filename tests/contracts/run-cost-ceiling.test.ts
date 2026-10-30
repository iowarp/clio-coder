import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it, test } from "node:test";
import { parseRunCliArgs } from "../../src/cli/args.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import { createRunCostCap, runCostCeilingUsd, sessionCeilingReached } from "../../src/domains/scheduling/budget.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

test("clio-coder run --max-cost-usd bounds what the run adds, under any lower configured ceiling", () => {
	strictEqual(parseRunCliArgs(["--max-cost-usd", "1.5", "task"]).maxCostUsd, 1.5);
	deepStrictEqual(
		parseRunCliArgs(["--max-cost-usd", "0", "task"]).diagnostics.map((entry) => entry.message),
		["--max-cost-usd must be a positive number of US dollars"],
	);
	// A continued session already spent $2; the run may add $1.50 more.
	const ceiling = runCostCeilingUsd({ spentUsd: 2, runMaxUsd: 1.5, configuredUsd: 0 });
	strictEqual(ceiling, 3.5);
	strictEqual(sessionCeilingReached(3.49, ceiling), false);
	strictEqual(sessionCeilingReached(3.5, ceiling), true);
	strictEqual(runCostCeilingUsd({ spentUsd: 2, runMaxUsd: 1.5, configuredUsd: 3 }), 3);
});

describe("--max-cost-usd and parallel dispatches", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("stops running workers at the cap, so two together pass it by at most one call each", async () => {
		const capUsd = 1;
		const callUsd = 0.3;
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		settings.safety.limits.sessionCostUsd = capUsd;
		// Each worker would spend $3 over ten calls if nothing stopped it.
		const pricedWorker = (): SpawnedWorker => {
			let aborted = false;
			let settle!: (result: SpawnedWorkerResult) => void;
			const promise = new Promise<SpawnedWorkerResult>((resolve) => {
				settle = resolve;
			});
			return {
				pid: null,
				promise,
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort: () => {
					aborted = true;
				},
				send: () => true,
				events: (async function* () {
					for (let call = 0; call < 10; call++) {
						await new Promise((resolve) => setImmediate(resolve));
						if (aborted) break;
						yield {
							type: "message_end",
							message: {
								role: "assistant",
								stopReason: "toolUse",
								content: [],
								usage: { input: 1000, output: 100, totalTokens: 1100, cost: { total: callUsd } },
							},
						};
					}
					settle(aborted ? { exitCode: null, signal: "SIGTERM" } : { exitCode: 0, signal: null });
				})(),
			};
		};
		const bundle = makeDispatchBundle(
			dispatchStubContext({
				settings,
				scheduling: {
					ceilingUsd: () => capUsd,
					preflight: () => ({ verdict: "under", currentUsd: 0, ceilingUsd: capUsd }),
					runCostCap: () => createRunCostCap(0, capUsd),
				},
			}),
			{ heartbeatIntervalMs: 3_600_000, spawnWorker: pricedWorker },
		);
		await bundle.extension.start();
		try {
			const request = {
				agentId: "scout",
				executionRole: "researcher" as const,
				task: "Inspect which functions lib/math.js exports.",
				requestOrigin: "internal" as const,
			};
			const runs = await Promise.all([bundle.contract.dispatch(request), bundle.contract.dispatch(request)]);
			const receipts = await Promise.all(runs.map((run) => run.finalPromise));
			const spentUsd = receipts.reduce((sum, receipt) => sum + receipt.costUsd, 0);
			// The documented bound: the cap plus one in-flight call per running worker, to 1e-9 USD.
			ok(spentUsd <= capUsd + 2 * callUsd + 1e-9, `spent ${spentUsd}`);
			for (const receipt of receipts) {
				strictEqual(receipt.outcome, "canceled");
				match(receipt.outcomeDetail ?? "", /--max-cost-usd \$1\.00 cap/u);
			}
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
