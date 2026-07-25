import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchNodePlacement } from "../../src/domains/dispatch/extension.js";
import type { DispatchRequest } from "../../src/domains/dispatch/index.js";
import {
	ROUTE_CANDIDATE_LIMIT,
	routeCandidateOrder,
	selectRouteCandidates,
} from "../../src/domains/dispatch/route-candidates.js";
import { validateJobSpec } from "../../src/domains/dispatch/validation.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const TARGET = "route-target";
const MODEL = "route-model";

function worker(exitCode: number): SpawnedWorker {
	const events = (async function* () {
		if (exitCode === 0) {
			yield {
				type: "message_end",
				message: { role: "assistant", content: "fallback complete", usage: { input: 1, output: 1 } },
			};
		}
	})();
	return {
		pid: exitCode === 0 ? 302 : 301,
		promise: Promise.resolve({
			exitCode,
			signal: null,
			...(exitCode === 255 ? { stderrTail: "ssh: connection lost" } : {}),
		}),
		events,
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

function stalledWorker(): SpawnedWorker {
	let finish!: () => void;
	const promise = new Promise<{ exitCode: number; signal: "SIGKILL" }>((resolve) => {
		finish = () => resolve({ exitCode: 1, signal: "SIGKILL" });
	});
	return {
		pid: 303,
		promise,
		events: (async function* () {})(),
		abort: finish,
		heartbeatAt: { current: 0 },
	};
}

function route(
	node: string,
	spawns: string[],
	remoteWorker: () => SpawnedWorker = () => worker(255),
): DispatchNodePlacement {
	if (node === "blade") {
		return {
			node: { id: "blade", kind: "ssh", host: "blade.test" },
			spawn: () => {
				spawns.push("blade");
				return remoteWorker();
			},
		};
	}
	return {
		node: { id: "local", kind: "local" },
		spawn: () => {
			spawns.push("local");
			return worker(0);
		},
	};
}

function request(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
	return {
		agentId: "coder",
		task: "exercise approved failover",
		target: TARGET,
		model: MODEL,
		node: "blade",
		...overrides,
	};
}

describe("dispatch failover envelopes", () => {
	beforeEach(isolateDispatchState);
	afterEach(restoreDispatchState);

	it("validates approved envelopes as exact route identities", () => {
		const valid = validateJobSpec(
			request({
				failover: "approved",
				allowedCandidates: [{ agentId: "coder", target: TARGET, model: MODEL, node: "blade" }],
			}),
		);
		strictEqual(valid.ok, true);
		const invalid = validateJobSpec(request({ failover: "approved", allowedCandidates: [] }));
		strictEqual(invalid.ok, false);
	});

	it("rejects automatic failover on a plan-approved dispatch", () => {
		const plan = {
			hash: "a".repeat(64),
			topology: "parallel" as const,
			taskCount: 1,
			approval: "operator" as const,
		};
		const planned = validateJobSpec(request({ failover: "automatic", plan }));
		strictEqual(planned.ok, false);
		strictEqual(
			planned.ok === false && planned.errors.some((error) => error.includes("failover automatic is not allowed")),
			true,
		);
		// Unplanned dispatch keeps automatic failover.
		strictEqual(validateJobSpec(request({ failover: "automatic" })).ok, true);
	});

	it("keeps rejected probes out of the envelope", () => {
		const current = { agentId: "coder", target: TARGET, model: MODEL, node: "blade" };
		const selected = selectRouteCandidates(current, [
			{ candidate: { agentId: "coder", target: "other", model: MODEL, node: "blade" }, rejection: null },
			{ candidate: { agentId: "coder", target: TARGET, model: MODEL, node: "local" }, rejection: "node offline" },
		]);
		deepStrictEqual(selected, [current, { agentId: "coder", target: "other", model: MODEL, node: "blade" }]);
	});

	it("retries the same approved tuple when the worker runtime fails", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		settings.targets = [{ id: TARGET, runtime: "openai", defaultModel: MODEL }];
		settings.workers.default = { target: TARGET, model: MODEL, thinkingLevel: "off" };
		const spawns: string[] = [];
		let attempts = 0;
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resolveNode: () => ({
				node: { id: "blade", kind: "ssh", host: "blade.test" },
				spawn: () => {
					spawns.push("blade");
					attempts += 1;
					// exitCode 1 with no diagnostic classifies as worker-runtime.
					return attempts === 1 ? worker(1) : worker(0);
				},
			}),
			resilienceCooldownMs: 0,
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch(
				request({
					failover: "approved",
					allowedCandidates: [{ agentId: "coder", target: TARGET, model: MODEL, node: "blade" }],
				}),
			);
			strictEqual((await handle.finalPromise).outcome, "succeeded");
			// Runtime is not part of the approved route identity, so the retry stays
			// on the approved tuple rather than failing for want of a candidate.
			deepStrictEqual(spawns, ["blade", "blade"]);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("enumerates a bounded, deterministic envelope from a route universe", () => {
		const resolved = { agentId: "coder", target: TARGET, model: MODEL, node: "blade" };
		const universe = {
			agentId: "coder",
			resolved,
			targets: [
				{ id: "alt-a", model: "alt-model-a" },
				{ id: "alt-b", model: "alt-model-b" },
			],
			nodes: ["local", "mini"],
		};
		const order = routeCandidateOrder(universe);
		// Resolved route first, then alternate targets on the resolved node, then
		// alternate nodes on the resolved target.
		deepStrictEqual(order, [
			resolved,
			{ agentId: "coder", target: "alt-a", model: "alt-model-a", node: "blade" },
			{ agentId: "coder", target: "alt-b", model: "alt-model-b", node: "blade" },
			{ agentId: "coder", target: TARGET, model: MODEL, node: "local" },
			{ agentId: "coder", target: TARGET, model: MODEL, node: "mini" },
		]);
		deepStrictEqual(routeCandidateOrder(universe), order, "equal inputs give equal envelopes");
		const probes = order.slice(1).map((candidate) => ({ candidate, rejection: null }));
		strictEqual(selectRouteCandidates(resolved, probes).length, ROUTE_CANDIDATE_LIMIT);
	});

	it("keeps a manual exact pin fail-closed across retries", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		settings.targets = [{ id: TARGET, runtime: "openai", defaultModel: MODEL }];
		settings.workers.default = { target: TARGET, model: MODEL, thinkingLevel: "off" };
		const spawns: string[] = [];
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resolveNode: (req) => route(req.node ?? "local", spawns),
			resilienceCooldownMs: 0,
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch(request());
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "failed");
			deepStrictEqual(spawns, ["blade", "blade"]);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("falls back from remote to local only within an approved envelope", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		settings.targets = [{ id: TARGET, runtime: "openai", defaultModel: MODEL }];
		settings.workers.default = { target: TARGET, model: MODEL, thinkingLevel: "off" };
		const spawns: string[] = [];
		const candidates = [
			{ agentId: "coder", target: TARGET, model: MODEL, node: "blade" },
			{ agentId: "coder", target: TARGET, model: MODEL, node: "local" },
		];
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resolveNode: (req) => route(req.node ?? "local", spawns, stalledWorker),
			now: () => 1_000,
			heartbeatSpec: { windowMs: 1, graceMs: 1 },
			heartbeatIntervalMs: 5,
			resilienceCooldownMs: 0,
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch(request({ failover: "approved", allowedCandidates: candidates }));
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "succeeded");
			strictEqual(terminal.node?.id, "local");
			deepStrictEqual(spawns, ["blade", "local"]);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("settles failed instead of spawning an unlisted candidate", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		settings.targets = [{ id: TARGET, runtime: "openai", defaultModel: MODEL }];
		settings.workers.default = { target: TARGET, model: MODEL, thinkingLevel: "off" };
		const spawns: string[] = [];
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resolveNode: (req) => route(req.node ?? "local", spawns),
			resilienceCooldownMs: 0,
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch(
				request({
					failover: "approved",
					allowedCandidates: [{ agentId: "coder", target: TARGET, model: MODEL, node: "blade" }],
				}),
			);
			const terminal = await handle.finalPromise;
			strictEqual(terminal.outcome, "failed");
			deepStrictEqual(spawns, ["blade"]);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
