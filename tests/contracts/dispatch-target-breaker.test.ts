import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import {
	createTargetBreaker,
	MAX_TARGET_BREAKER_COOLDOWN_MS,
	type TargetBreaker,
} from "../../src/domains/dispatch/target-breaker.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

function harness(options: { cooldownMs?: number; threshold?: number } = {}) {
	let clock = 1_000;
	const breaker: TargetBreaker = createTargetBreaker({
		monotonicNow: () => clock,
		cooldownMs: () => options.cooldownMs ?? 15_000,
		threshold: () => options.threshold ?? 1,
	});
	return {
		breaker,
		advance(ms: number) {
			clock += ms;
		},
	};
}

const ROUTE = "mini\0openai-compat\0qwen";

describe("dispatch target breaker", () => {
	it("trips on the first failure at the default threshold", () => {
		const { breaker } = harness();
		breaker.record(ROUTE, "run-1", "failure", "target-transient");
		strictEqual(breaker.blocked(ROUTE)?.kind, "open");
	});

	it("leaves the route open until the threshold of consecutive failures", () => {
		const { breaker } = harness({ threshold: 3 });
		breaker.record(ROUTE, "run-1", "failure", "target-transient");
		breaker.record(ROUTE, "run-2", "failure", "target-transient");
		strictEqual(breaker.blocked(ROUTE), null);
		strictEqual(breaker.admit(ROUTE, "run-3"), null);
		breaker.record(ROUTE, "run-3", "failure", "target-transient");
		deepStrictEqual(breaker.blocked(ROUTE), { kind: "open", remainingMs: 15_000, reason: "target-transient" });
	});

	it("resets the consecutive count on success", () => {
		const { breaker } = harness({ threshold: 2 });
		breaker.record(ROUTE, "run-1", "failure", "target-transient");
		breaker.record(ROUTE, "run-2", "success", "internal");
		breaker.record(ROUTE, "run-3", "failure", "target-transient");
		strictEqual(breaker.blocked(ROUTE), null);
	});

	it("does not count a failure that says nothing about the target", () => {
		const { breaker } = harness();
		breaker.record(ROUTE, "run-1", "neutral", "deterministic-task");
		strictEqual(breaker.blocked(ROUTE), null);
	});

	it("admits exactly one probe after the cooldown and holds the rest", () => {
		const { breaker, advance } = harness();
		breaker.record(ROUTE, "run-1", "failure", "target-transient");
		advance(14_999);
		strictEqual(breaker.admit(ROUTE, "run-2")?.kind, "open");
		advance(1);
		strictEqual(breaker.blocked(ROUTE), null, "a read-only view does not claim the probe");
		strictEqual(breaker.admit(ROUTE, "run-2"), null);
		strictEqual(breaker.admit(ROUTE, "run-3")?.kind, "probing");
		strictEqual(breaker.blocked(ROUTE)?.kind, "probing");
	});

	it("doubles the cooldown on each probe failure up to the cap", () => {
		const { breaker, advance } = harness({ cooldownMs: 60_000 });
		breaker.record(ROUTE, "run-0", "failure", "target-transient");
		const seen: number[] = [];
		let cooldown = 60_000;
		for (let probe = 1; probe <= 4; probe++) {
			advance(cooldown);
			const owner = `probe-${probe}`;
			strictEqual(breaker.admit(ROUTE, owner), null);
			breaker.record(ROUTE, owner, "failure", "target-transient");
			const block = breaker.blocked(ROUTE);
			ok(block?.kind === "open");
			cooldown = block.remainingMs;
			seen.push(cooldown);
		}
		deepStrictEqual(seen, [120_000, 240_000, MAX_TARGET_BREAKER_COOLDOWN_MS, MAX_TARGET_BREAKER_COOLDOWN_MS]);
	});

	it("closes and resets the backoff when the probe succeeds", () => {
		const { breaker, advance } = harness();
		breaker.record(ROUTE, "run-1", "failure", "target-transient");
		advance(15_000);
		breaker.admit(ROUTE, "probe-1");
		breaker.record(ROUTE, "probe-1", "failure", "target-transient");
		advance(30_000);
		breaker.admit(ROUTE, "probe-2");
		breaker.record(ROUTE, "probe-2", "success", "internal");
		strictEqual(breaker.blocked(ROUTE), null);
		breaker.record(ROUTE, "run-3", "failure", "target-transient");
		deepStrictEqual(breaker.blocked(ROUTE), { kind: "open", remainingMs: 15_000, reason: "target-transient" });
	});

	it("hands the probe to the next dispatch when the claimed one never starts", () => {
		const { breaker, advance } = harness();
		breaker.record(ROUTE, "run-1", "failure", "target-transient");
		advance(15_000);
		strictEqual(breaker.admit(ROUTE, "probe-1"), null);
		breaker.release(ROUTE, "probe-1");
		strictEqual(breaker.admit(ROUTE, "probe-2"), null);
		strictEqual(breaker.admit(ROUTE, "run-3")?.kind, "probing");
	});
});

describe("fleet.retry.breakerThreshold", () => {
	it("defaults to 1 and rejects values below 1", () => {
		strictEqual(validateSettings({ version: 2 }).settings.fleet.retry.breakerThreshold, 1);
		const accepted = validateSettings({ version: 2, fleet: { retry: { breakerThreshold: 3 } } });
		strictEqual(accepted.settings.fleet.retry.breakerThreshold, 3);
		deepStrictEqual(accepted.issues, []);
		const rejected = validateSettings({ version: 2, fleet: { retry: { breakerThreshold: 0 } } });
		ok(rejected.issues.some((issue) => issue.path === "fleet.retry.breakerThreshold"));
	});
});

describe("dispatch admission through the target breaker", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-target-breaker-");
	});
	afterEach(() => scratch.restore());

	it("admits one half-open probe and closes the route when it succeeds", async () => {
		let offset = 0;
		const clock = () => performance.now() + offset;
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		settings.fleet.retry.routeCooldownMs = 15_000;
		const finishers: Array<(result: SpawnedWorkerResult) => void> = [];
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			monotonicNow: clock,
			heartbeatIntervalMs: 3_600_000,
			spawnWorker: () => {
				let finish!: (result: SpawnedWorkerResult) => void;
				const done = new Promise<SpawnedWorkerResult>((resolve) => {
					finish = resolve;
				});
				finishers.push(finish);
				const worker: SpawnedWorker = {
					pid: null,
					promise: done,
					heartbeatAt: { current: Date.now(), monotonic: clock() },
					abort: () => finish({ exitCode: null, signal: "SIGTERM" }),
					send: () => true,
					events: (async function* () {
						const outcome = await done;
						if (outcome.exitCode === 0)
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
		const request: DispatchRequest = {
			agentId: "scout",
			executionRole: "researcher",
			task: "Inspect isolated fixture evidence.",
			cwd: scratch.dir,
			requestOrigin: "internal",
			resultContractOverride: { kind: "provenance-report" },
		};
		try {
			const first = await bundle.contract.dispatch(request);
			finishers[0]?.({ exitCode: 1, signal: null, stderrTail: "HTTP 503 Service Unavailable" });
			await first.finalPromise;
			await rejects(bundle.contract.dispatch(request), /cooling down for 15s after target-transient/);

			offset += 15_000;
			const probe = await bundle.contract.dispatch(request);
			await rejects(bundle.contract.dispatch(request), /cooling down while one probe run tests it/);
			strictEqual(finishers.length, 2, "only the probe reached a worker");
			finishers[1]?.({ exitCode: 0, signal: null });
			strictEqual((await probe.finalPromise).exitCode, 0);

			const after = await bundle.contract.dispatch(request);
			finishers[2]?.({ exitCode: 0, signal: null });
			await after.finalPromise;
		} finally {
			for (const finish of finishers) finish({ exitCode: 0, signal: null });
			await bundle.extension.stop?.();
		}
	});
});
