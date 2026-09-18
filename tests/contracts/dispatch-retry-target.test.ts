import { deepStrictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const REQUEST: DispatchRequest = {
	agentId: "scout",
	executionRole: "researcher",
	task: "Inspect isolated fixture evidence.",
	requestOrigin: "internal",
	resultContractOverride: { kind: "provenance-report" },
};

/**
 * A bundle whose workers finish at once: a 503 on any target in `failing`,
 * success elsewhere. `spawned` lists the target each worker ran on.
 */
async function retryFleet(targetIds: ReadonlyArray<string>, failing: ReadonlySet<string>, vision: ReadonlySet<string>) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = targetIds.map((id) => ({ id, runtime: "openai", defaultModel: "gpt-4o" }));
	settings.fleet.default.target = "default";
	settings.fleet.default.model = "gpt-4o";
	settings.fleet.retry.maxRetries = 1;
	const context = dispatchStubContext({ settings });
	const providers = context.getContract<ProvidersContract>("providers");
	for (const status of providers?.list() ?? []) status.capabilities.vision = vision.has(status.target.id);
	const spawned: string[] = [];
	const bundle = makeDispatchBundle(context, {
		heartbeatIntervalMs: 3_600_000,
		spawnWorker: (spec) => {
			spawned.push(spec.target.id);
			const result: SpawnedWorkerResult = failing.has(spec.target.id)
				? { exitCode: 1, signal: null, stderrTail: "HTTP 503 Service Unavailable" }
				: { exitCode: 0, signal: null };
			const worker: SpawnedWorker = {
				pid: null,
				promise: Promise.resolve(result),
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort: () => {},
				send: () => true,
				events: (async function* () {
					if (result.exitCode === 0)
						yield {
							type: "message_end",
							message: {
								role: "assistant",
								stopReason: "stop",
								content: JSON.stringify({ confirmedFacts: [], missingEvidence: [], nextInspections: [] }),
							},
						};
				})(),
			};
			return worker;
		},
	});
	await bundle.extension.start();
	const waitForSpawns = async (count: number): Promise<void> => {
		for (let i = 0; i < 200 && spawned.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 25));
		// Let the last attempt settle before the bundle stops.
		await new Promise((resolve) => setTimeout(resolve, 50));
	};
	return { bundle, spawned, waitForSpawns };
}

describe("retry target selection", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-retry-target-");
	});
	afterEach(() => scratch.restore());

	it("skips an alternate target that lacks a required capability", async () => {
		const fleet = await retryFleet(["default", "plain", "seeing"], new Set(["default"]), new Set(["default", "seeing"]));
		try {
			const first = await fleet.bundle.contract.dispatch({
				...REQUEST,
				cwd: scratch.dir,
				requiredCapabilities: ["vision"],
			});
			await first.finalPromise;
			await fleet.waitForSpawns(2);
			deepStrictEqual(fleet.spawned, ["default", "seeing"]);
		} finally {
			await fleet.bundle.extension.stop?.();
		}
	});

	it("skips an alternate target whose breaker is open", async () => {
		const fleet = await retryFleet(["default", "sick", "good"], new Set(["default", "sick"]), new Set());
		try {
			// A pinned run trips the breaker on sick; its exact retry stays on sick.
			const pinned = await fleet.bundle.contract.dispatch({ ...REQUEST, cwd: scratch.dir, target: "sick" });
			await pinned.finalPromise;
			await fleet.waitForSpawns(2);
			const first = await fleet.bundle.contract.dispatch({ ...REQUEST, cwd: scratch.dir });
			await first.finalPromise;
			await fleet.waitForSpawns(4);
			deepStrictEqual(fleet.spawned, ["sick", "sick", "default", "good"]);
		} finally {
			await fleet.bundle.extension.stop?.();
		}
	});
});
