import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchNodePlacement } from "../../src/domains/dispatch/extension.js";
import {
	classifyFailure,
	decideRetry,
	isInfrastructureFailure,
} from "../../src/domains/dispatch/failure-classification.js";
import type { RunTerminationEvidence } from "../../src/domains/dispatch/outcome.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import { WORKER_EXIT_PERMISSION_REQUIRED } from "../../src/worker/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const BASE_EVIDENCE: RunTerminationEvidence = {
	exitCode: 1,
	abortedByOperator: false,
	abortDetail: null,
	stallKilled: false,
	timedOut: false,
	permissionFailure: false,
	policyDenied: null,
	stopReason: null,
};

function events(text?: string): AsyncIterableIterator<unknown> {
	return (async function* () {
		if (text !== undefined) {
			yield { type: "message_end", message: { role: "assistant", content: text, usage: { input: 1, output: 1 } } };
		}
	})();
}

function worker(result: SpawnedWorkerResult, text?: string): SpawnedWorker {
	return {
		pid: 9000,
		promise: Promise.resolve(result),
		events: events(text),
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

describe("dispatch failure classification", () => {
	beforeEach(() => isolateDispatchState());
	after(() => restoreDispatchState());

	it("classifies structured termination evidence", () => {
		const cases = [
			[{ ...BASE_EVIDENCE, abortedByOperator: true }, null, "canceled", null, "operator-cancel"],
			[{ ...BASE_EVIDENCE, policyDenied: "scope denied" }, null, "denied_by_policy", null, "policy"],
			[{ ...BASE_EVIDENCE, permissionFailure: true }, null, "failed", null, "permission"],
			[BASE_EVIDENCE, { exitCode: 255, signal: null }, "failed", null, "node-channel"],
			[
				BASE_EVIDENCE,
				{ exitCode: 1, signal: null, stderrTail: "HTTP 429 rate limit" },
				"failed",
				null,
				"target-rate-limit",
			],
			[{ ...BASE_EVIDENCE, timedOut: true }, null, "timed_out", null, "target-transient"],
			[BASE_EVIDENCE, null, "failed", "vram_capacity_fit_failure", "deterministic-task"],
			[BASE_EVIDENCE, { exitCode: 1, signal: null, stderrTail: "out of memory" }, "failed", null, "capacity"],
			[BASE_EVIDENCE, null, "failed", "worker_tool_call_cap_exhausted", "deterministic-task"],
			[BASE_EVIDENCE, { exitCode: 1, signal: null }, "failed", null, "worker-runtime"],
		] as const;
		for (const [evidence, result, outcome, code, expected] of cases) {
			strictEqual(classifyFailure(evidence, result, outcome, code), expected);
		}
		strictEqual(decideRetry("operator-cancel", 0, 2).retry, false);
		strictEqual(decideRetry("policy", 0, 2).retry, false);
		strictEqual(decideRetry("permission", 0, 2).retry, false);
		strictEqual(isInfrastructureFailure("operator-cancel"), false);
		strictEqual(isInfrastructureFailure("policy"), false);
		strictEqual(isInfrastructureFailure("permission"), false);
		deepStrictEqual(decideRetry("node-channel", 0, 2).excludedRouteParts, ["node"]);
		deepStrictEqual(decideRetry("target-rate-limit", 0, 2).excludedRouteParts, ["target"]);
		strictEqual(decideRetry("target-rate-limit", 0, 2).retryAfterMs, 1_000);
	});

	it("keeps cancellation and permission neutral to target cooldown and retry", async () => {
		for (const kind of ["cancel", "permission"] as const) {
			const settings = structuredClone(DEFAULT_SETTINGS);
			settings.workers.maxRetries = 1;
			let finish!: (result: SpawnedWorkerResult) => void;
			const pending = new Promise<SpawnedWorkerResult>((resolve) => {
				finish = resolve;
			});
			let spawns = 0;
			const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
				resilienceCooldownMs: 5_000,
				spawnWorker: () => {
					spawns += 1;
					if (spawns > 1) return worker({ exitCode: 0, signal: null }, "next admitted");
					if (kind === "permission") {
						return worker({ exitCode: WORKER_EXIT_PERMISSION_REQUIRED, signal: null });
					}
					return {
						pid: 9001,
						promise: pending,
						events: events(),
						abort: () => finish({ exitCode: 1, signal: "SIGTERM" }),
						heartbeatAt: { current: Date.now() },
					};
				},
			});
			await bundle.extension.start();
			try {
				const first = await bundle.contract.dispatch({ agentId: "coder", task: kind });
				if (kind === "cancel") bundle.contract.abort(first.runId);
				const firstReceipt = await first.finalPromise;
				strictEqual(firstReceipt.outcome, kind === "cancel" ? "canceled" : "failed");
				strictEqual(bundle.contract.snapshot().retrying.length, 0);
				const next = await bundle.contract.dispatch({ agentId: "coder", task: `after ${kind}` });
				strictEqual((await next.finalPromise).outcome, "succeeded");
				strictEqual(spawns, 2);
			} finally {
				await bundle.extension.stop?.();
			}
		}
	});

	it("moves only the node after a channel failure and retains target/model", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		const context = dispatchStubContext({ settings });
		const targetId = settings.targets[0]?.id;
		ok(targetId);
		const placements: Array<{ node?: string; target?: string; model?: string }> = [];
		let placementCalls = 0;
		const resolveNode = (req: { node?: string; target?: string; model?: string }): DispatchNodePlacement => {
			placements.push({
				...(req.node !== undefined ? { node: req.node } : {}),
				...(req.target !== undefined ? { target: req.target } : {}),
				...(req.model !== undefined ? { model: req.model } : {}),
			});
			placementCalls += 1;
			if (placementCalls === 1) {
				return {
					node: { id: "blade", kind: "ssh", host: "blade.lan" },
					spawn: () => worker({ exitCode: 255, signal: null, stderrTail: "ssh channel failed" }),
				};
			}
			return { node: { id: "local", kind: "local" } };
		};
		const bundle = makeDispatchBundle(context, {
			resolveNode,
			resilienceCooldownMs: 0,
			spawnWorker: () => worker({ exitCode: 0, signal: null }, "local recovery"),
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				task: "channel failure",
				node: "blade",
				failover: "automatic",
				target: targetId,
				model: "test-model",
			});
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "succeeded");
			strictEqual(terminal.node?.id, "local");
			// The retry drops the node pin (only the node was excluded) so placement
			// re-selects; target and model are preserved.
			deepStrictEqual(placements, [
				{ node: "blade", target: targetId, model: "test-model" },
				{ target: targetId, model: "test-model" },
			]);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("changes target after rate limiting while retaining agent/model and delaying retry", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		settings.targets = [
			{ id: "primary", runtime: "openai", defaultModel: "shared-model" },
			{ id: "secondary", runtime: "openai", defaultModel: "shared-model" },
		];
		settings.workers.default.target = "primary";
		settings.workers.default.model = "shared-model";
		const routes: Array<{ agentId: string; targetId: string; model: string }> = [];
		let spawns = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: (spec) => {
				routes.push({ agentId: spec.agentId, targetId: spec.target.id, model: spec.wireModelId });
				spawns += 1;
				return spawns === 1
					? worker({ exitCode: 1, signal: null, stderrTail: "HTTP 429 Too Many Requests" })
					: worker({ exitCode: 0, signal: null }, "secondary recovered");
			},
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				task: "rate limited",
				failover: "automatic",
				target: "primary",
				model: "shared-model",
			});
			strictEqual((await handle.finalPromise).outcome, "succeeded");
			deepStrictEqual(routes, [
				{ agentId: "coder", targetId: "primary", model: "shared-model" },
				{ agentId: "coder", targetId: "secondary", model: "shared-model" },
			]);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
