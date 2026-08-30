import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchNodePlacement } from "../../src/domains/dispatch/extension.js";
import {
	affectsNodeBreaker,
	affectsTargetBreaker,
	classifyFailure,
	decideRetry,
	isInfrastructureFailure,
} from "../../src/domains/dispatch/failure-classification.js";
import type { RunTerminationEvidence } from "../../src/domains/dispatch/outcome.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import { WORKER_EXIT_PERMISSION_REQUIRED } from "../../src/worker/spec-contract.js";
import {
	fastReproducibility,
	isolateDispatchState,
	makeDispatchBundle,
	restoreDispatchState,
} from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { mutationReport } from "../harness/gate-fabric.js";

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
			[BASE_EVIDENCE, null, "failed", "vram_capacity_fit_failure", "deterministic-task"],
			[{ ...BASE_EVIDENCE, qualityGateFailure: true }, null, "failed", null, "model-quality"],
			[BASE_EVIDENCE, { exitCode: 255, signal: null }, "failed", null, "node-channel"],
			[BASE_EVIDENCE, { exitCode: 1, signal: null, stderrTail: "HTTP 403 Forbidden" }, "failed", null, "target-auth"],
			[
				BASE_EVIDENCE,
				{ exitCode: 1, signal: null, stderrTail: "HTTP 429 rate limit" },
				"failed",
				null,
				"target-rate-limit",
			],
			[BASE_EVIDENCE, { exitCode: 1, signal: null, stderrTail: "CUDA out of memory" }, "failed", null, "node-resource"],
			[BASE_EVIDENCE, { exitCode: 1, signal: null, stderrTail: "provider queue full" }, "failed", null, "capacity"],
			[{ ...BASE_EVIDENCE, timedOut: true }, null, "timed_out", null, "target-transient"],
			[BASE_EVIDENCE, null, "failed", "worker_tool_call_cap_exhausted", "deterministic-task"],
			[BASE_EVIDENCE, { exitCode: 1, signal: null }, "failed", null, "worker-runtime"],
			[BASE_EVIDENCE, null, "succeeded", null, "internal"],
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
		strictEqual(isInfrastructureFailure("model-quality"), false);
		strictEqual(affectsTargetBreaker("capacity"), false);
		strictEqual(affectsTargetBreaker("internal"), false);
		strictEqual(affectsTargetBreaker("target-auth"), true);
		strictEqual(affectsNodeBreaker("node-resource"), true);
		deepStrictEqual(decideRetry("model-quality", 0, 2).excludedRouteParts, ["agent", "model"]);
		deepStrictEqual(decideRetry("model-quality", 0, 2).qualityEscalation, {
			kind: "model-quality",
			allowAgentChange: true,
		});
		for (const failureClass of [
			"operator-cancel",
			"policy",
			"permission",
			"deterministic-task",
			"target-auth",
			"target-rate-limit",
			"target-transient",
			"capacity",
			"node-channel",
			"node-resource",
			"worker-runtime",
			"internal",
		] as const) {
			strictEqual(decideRetry(failureClass, 0, 2).qualityEscalation, null);
		}
		deepStrictEqual(decideRetry("node-channel", 0, 2).excludedRouteParts, ["node"]);
		deepStrictEqual(decideRetry("node-resource", 0, 2).excludedRouteParts, ["node"]);
		deepStrictEqual(decideRetry("target-auth", 0, 2).excludedRouteParts, ["target"]);
		deepStrictEqual(decideRetry("target-rate-limit", 0, 2).excludedRouteParts, ["target"]);
		strictEqual(decideRetry("target-rate-limit", 0, 2).retryAfterMs, 1_000);
	});

	/**
	 * llama-server answers HTTP 400 "failed to parse grammar" when the response
	 * schema Clio attached will not compile into a sampler grammar beside the
	 * tool grammar. That is a verdict on the request, not on the endpoint, and
	 * classifying it as worker-runtime parked a healthy target behind the
	 * breaker for every other run while the caller's schema-free retry was
	 * refused admission.
	 */
	it("treats a rejected response-schema grammar as deterministic, not target health", () => {
		const rejection = {
			exitCode: 1,
			signal: null,
			stderrTail:
				'400: {"code":400,"message":"Failed to initialize samplers: failed to parse grammar","type":"invalid_request_error"}',
		} as const;
		strictEqual(classifyFailure(BASE_EVIDENCE, rejection, "failed", null), "deterministic-task");
		strictEqual(affectsTargetBreaker("deterministic-task"), false);
		strictEqual(decideRetry("deterministic-task", 0, 2).retry, false);
		// A 400 that says nothing about a grammar or a schema stays a plain
		// worker-runtime failure; the predicate is not a catch-all for 400s.
		strictEqual(
			classifyFailure(BASE_EVIDENCE, { exitCode: 1, signal: null, stderrTail: "400: bad request" }, "failed", null),
			"worker-runtime",
		);
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
					if (spawns > 1) {
						return worker({ exitCode: 0, signal: null }, mutationReport("next dispatch admitted"));
					}
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
				const first = await bundle.contract.dispatch({ agentId: "coder", executionRole: "builder", task: kind });
				if (kind === "cancel") bundle.contract.abort(first.runId);
				const firstReceipt = await first.finalPromise;
				strictEqual(firstReceipt.outcome, kind === "cancel" ? "canceled" : "failed");
				strictEqual(bundle.contract.snapshot().retrying.length, 0);
				const next = await bundle.contract.dispatch({ agentId: "coder", executionRole: "builder", task: `after ${kind}` });
				strictEqual((await next.finalPromise).outcome, "succeeded");
				strictEqual(spawns, 2);
			} finally {
				await bundle.extension.stop?.();
			}
		}
	});

	it("attributes target breaker failures without cooling for capacity or internal", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 0;
		let spawns = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 5_000,
			spawnWorker: () => {
				spawns += 1;
				return spawns === 1
					? worker({ exitCode: 1, signal: null, stderrTail: "provider queue full" })
					: worker({ exitCode: 0, signal: null }, mutationReport("same target admitted"));
			},
		});
		await bundle.extension.start();
		try {
			const first = await bundle.contract.dispatch({ agentId: "coder", executionRole: "builder", task: "capacity" });
			strictEqual((await first.finalPromise).outcome, "failed");
			const second = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "after capacity",
			});
			strictEqual((await second.finalPromise).outcome, "succeeded");
			strictEqual(affectsTargetBreaker("internal"), false);
		} finally {
			await bundle.extension.stop?.();
		}

		const internalSettings = structuredClone(DEFAULT_SETTINGS);
		internalSettings.workers.maxRetries = 0;
		let reproductionCalls = 0;
		const internalBundle = makeDispatchBundle(dispatchStubContext({ settings: internalSettings }), {
			resilienceCooldownMs: 5_000,
			collectReproducibility: (cwd, safety) => {
				reproductionCalls += 1;
				if (reproductionCalls === 1) throw new Error("synthetic finalization failure");
				return fastReproducibility(cwd, safety);
			},
			spawnWorker: () => worker({ exitCode: 0, signal: null }, mutationReport("same target after internal failure")),
		});
		await internalBundle.extension.start();
		try {
			const first = await internalBundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "internal",
			});
			await rejects(first.finalPromise, /synthetic finalization failure/);
			const second = await internalBundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "after internal",
			});
			strictEqual((await second.finalPromise).outcome, "succeeded");
		} finally {
			await internalBundle.extension.stop?.();
		}

		const authSettings = structuredClone(DEFAULT_SETTINGS);
		authSettings.workers.maxRetries = 0;
		const authBundle = makeDispatchBundle(dispatchStubContext({ settings: authSettings }), {
			resilienceCooldownMs: 5_000,
			spawnWorker: () => worker({ exitCode: 1, signal: null, stderrTail: "HTTP 401 Unauthorized" }),
		});
		await authBundle.extension.start();
		try {
			const first = await authBundle.contract.dispatch({ agentId: "coder", executionRole: "builder", task: "auth" });
			strictEqual((await first.finalPromise).outcome, "failed");
			await rejects(
				authBundle.contract.dispatch({ agentId: "coder", executionRole: "builder", task: "after auth" }),
				/cooling down/,
			);
		} finally {
			await authBundle.extension.stop?.();
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
			spawnWorker: () => worker({ exitCode: 0, signal: null }, mutationReport("local recovery")),
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
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

	it("suppresses unsafe model-quality failover after mutation but retains target-auth failover", async () => {
		const qualitySettings = structuredClone(DEFAULT_SETTINGS);
		qualitySettings.workers.maxRetries = 1;
		qualitySettings.targets[0] = {
			...qualitySettings.targets[0],
			id: "quality-target",
			runtime: "openai",
			defaultModel: "fallback-model",
		};
		qualitySettings.workers.default.target = "quality-target";
		qualitySettings.workers.default.model = "fallback-model";
		const qualityRoutes: Array<{ targetId: string; model: string }> = [];
		let qualitySpawns = 0;
		const originalRigor = process.env.CLIO_CODER_RIGOR;
		process.env.CLIO_CODER_RIGOR = "high";
		const qualityBundle = makeDispatchBundle(dispatchStubContext({ settings: qualitySettings }), {
			resilienceCooldownMs: 5_000,
			spawnWorker: (spec) => {
				qualityRoutes.push({ targetId: spec.target.id, model: spec.wireModelId });
				qualitySpawns += 1;
				if (qualitySpawns > 1) return worker({ exitCode: 0, signal: null }, "validated fallback");
				return {
					pid: 9010,
					promise: Promise.resolve({ exitCode: 0, signal: null }),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
					events: (async function* () {
						yield { type: "message_end", message: { role: "user", content: "edit src/app.ts" } };
						yield {
							type: "tool_execution_start",
							toolCallId: "edit-1",
							toolName: "edit",
							args: { path: "src/app.ts" },
						};
						yield {
							type: "tool_execution_end",
							toolCallId: "edit-1",
							toolName: "edit",
							isError: false,
							result: { details: { kind: "ok" } },
						};
						yield {
							type: "clio_tool_finish",
							payload: { tool: "edit", durationMs: 1, outcome: "ok", decision: "allowed" },
						};
						yield { type: "message_end", message: { role: "assistant", content: "Done." } };
					})(),
				};
			},
		});
		await qualityBundle.extension.start();
		try {
			const handle = await qualityBundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "quality gate",
				failover: "automatic",
				target: "quality-target",
				model: "rejected-model",
			});
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "failed");
			deepStrictEqual(qualityRoutes, [{ targetId: "quality-target", model: "rejected-model" }]);
			ok(qualityBundle.contract.assignments?.get(handle.runId)?.outcomeDetail?.includes("retry suppressed"));
		} finally {
			if (originalRigor === undefined) delete process.env.CLIO_CODER_RIGOR;
			else process.env.CLIO_CODER_RIGOR = originalRigor;
			await qualityBundle.extension.stop?.();
		}

		const authSettings = structuredClone(DEFAULT_SETTINGS);
		authSettings.workers.maxRetries = 1;
		authSettings.targets = [
			{ id: "primary", runtime: "openai", defaultModel: "shared-model" },
			{ id: "secondary", runtime: "openai", defaultModel: "shared-model" },
		];
		authSettings.workers.default.target = "primary";
		authSettings.workers.default.model = "shared-model";
		const authRoutes: Array<{ targetId: string; node?: string }> = [];
		let authSpawns = 0;
		const authBundle = makeDispatchBundle(dispatchStubContext({ settings: authSettings }), {
			resilienceCooldownMs: 0,
			resolveNode: (req) => {
				authRoutes.push({ targetId: req.target ?? "", ...(req.node !== undefined ? { node: req.node } : {}) });
				return { node: { id: "blade", kind: "ssh", host: "blade.lan" } };
			},
			spawnWorker: () => {
				authSpawns += 1;
				return authSpawns === 1
					? worker({ exitCode: 1, signal: null, stderrTail: "401 invalid API key" })
					: worker({ exitCode: 0, signal: null }, mutationReport("auth failover recovered"));
			},
		});
		await authBundle.extension.start();
		try {
			const handle = await authBundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "auth failover",
				failover: "automatic",
				target: "primary",
				model: "shared-model",
				node: "blade",
			});
			strictEqual((await handle.finalPromise).outcome, "succeeded");
			deepStrictEqual(authRoutes, [
				{ targetId: "primary", node: "blade" },
				{ targetId: "secondary", node: "blade" },
			]);
		} finally {
			await authBundle.extension.stop?.();
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
					: worker({ exitCode: 0, signal: null }, mutationReport("secondary recovered"));
			},
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
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

	it("spends the whole retry budget on a pinned failing target without waiting out its cooldown", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 2;
		const cooldownMs = 5_000;
		const routes: Array<{ agentId: string; targetId: string; model: string; atMs: number }> = [];
		const clock = (): number => Date.now();
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: cooldownMs,
			now: clock,
			spawnWorker: (spec) => {
				routes.push({
					agentId: spec.agentId,
					targetId: spec.target.id,
					model: spec.wireModelId,
					atMs: clock(),
				});
				return worker({ exitCode: 1, signal: null, stderrTail: "HTTP 503 Service Unavailable" });
			},
		});
		await bundle.extension.start();
		const targetId = settings.targets[0]?.id;
		ok(targetId);
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "pinned permanent failure",
				target: targetId,
			});
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "failed");
			// maxRetries: 2 means the initial attempt plus two retries.
			strictEqual(routes.length, 3);
			for (const route of routes) {
				strictEqual(route.targetId, targetId);
				strictEqual(route.agentId, "coder");
			}
			// Backoff alone separates the attempts. The cooldown this same failure
			// created would have pushed the third attempt past the window entirely.
			const first = routes[0];
			const last = routes[2];
			ok(first && last);
			ok(last.atMs - first.atMs < cooldownMs, `attempts spanned ${last.atMs - first.atMs}ms`);

			// The cooldown still protects new work against the same failing target.
			await rejects(
				bundle.contract.dispatch({ agentId: "coder", executionRole: "builder", task: "new work", target: targetId }),
				/cooling down/,
			);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("settles the assignment failed with the denial reason when a retry is refused at admission", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		let placements = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			resolveNode: (): DispatchNodePlacement => {
				placements += 1;
				if (placements > 1) throw new Error("fleet node 'blade' is not eligible");
				return { node: { id: "local", kind: "local" } };
			},
			spawnWorker: () => worker({ exitCode: 1, signal: null, stderrTail: "provider queue full" }),
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", executionRole: "builder", task: "retry denied" });
			strictEqual((await handle.finalPromise).outcome, "failed");
			const assignment = bundle.contract.assignments?.get(handle.runId);
			ok(assignment);
			strictEqual(assignment.status, "failed");
			ok(
				assignment.outcomeDetail?.includes("not eligible"),
				`outcomeDetail was ${JSON.stringify(assignment.outcomeDetail)}`,
			);
			ok(assignment.outcomeDetail?.startsWith("retry attempt 1 rejected:"));
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
