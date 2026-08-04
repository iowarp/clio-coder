import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchNodePlacement } from "../../src/domains/dispatch/extension.js";
import type { DispatchRequest } from "../../src/domains/dispatch/index.js";
import { firstAvailableRouteCandidate } from "../../src/domains/dispatch/route-candidates.js";
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
		executionRole: "builder",
		task: "exercise approved failover",
		target: TARGET,
		model: MODEL,
		node: "blade",
		...overrides,
	};
}

/** No target/model/node pin, so the envelope alone decides where the work lands. */
function unpinnedRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
	return { agentId: "coder", executionRole: "builder", task: "exercise approved failover", ...overrides };
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
			source: null,
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

	it("picks the first envelope member that can accept new work", () => {
		const first = { agentId: "coder", target: TARGET, model: MODEL, node: "blade" };
		const second = { agentId: "coder", target: "alt", model: "alt-model", node: "blade" };
		deepStrictEqual(
			firstAvailableRouteCandidate([
				{ candidate: first, unavailable: "cooling down" },
				{ candidate: second, unavailable: null },
			]),
			second,
		);
		strictEqual(
			firstAvailableRouteCandidate([
				{ candidate: first, unavailable: "cooling down" },
				{ candidate: second, unavailable: "cooling down" },
			]),
			null,
		);
		strictEqual(firstAvailableRouteCandidate([]), null);
	});

	it("routes new work around a cooling target onto the approved alternate", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 0;
		settings.targets = [
			{ id: TARGET, runtime: "openai", defaultModel: MODEL },
			{ id: "alt", runtime: "openai", defaultModel: MODEL },
		];
		settings.workers.default = { target: TARGET, model: MODEL, thinkingLevel: "off" };
		const candidates = [
			{ agentId: "coder", target: TARGET, model: MODEL, node: "local" },
			{ agentId: "coder", target: "alt", model: MODEL, node: "local" },
		];
		const routes: string[] = [];
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resolveNode: () => ({ node: { id: "local", kind: "local" } }),
			resilienceCooldownMs: 60_000,
			spawnWorker: (spec) => {
				routes.push(spec.target.id);
				// 503 on the default target classifies target-transient, which cools it.
				return spec.target.id === TARGET
					? {
							pid: 401,
							promise: Promise.resolve({ exitCode: 1, signal: null, stderrTail: "503 Service Unavailable" }),
							events: (async function* () {})(),
							abort: () => {},
							heartbeatAt: { current: Date.now() },
						}
					: worker(0);
			},
		});
		await bundle.extension.start();
		try {
			const first = await bundle.contract.dispatch(
				unpinnedRequest({ failover: "approved", allowedCandidates: candidates }),
			);
			strictEqual((await first.finalPromise).outcome, "failed");
			// The cooldown the first assignment created must not sink the second: its
			// approved envelope already names a target that can take the work.
			const second = await bundle.contract.dispatch(
				unpinnedRequest({ failover: "approved", allowedCandidates: candidates }),
			);
			const terminal = await second.finalPromise;
			strictEqual(terminal.outcome, "succeeded");
			strictEqual(terminal.targetId, "alt");
			deepStrictEqual(routes, [TARGET, "alt"]);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("still refuses new work when the cooling target is the only approved route", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 0;
		settings.targets = [{ id: TARGET, runtime: "openai", defaultModel: MODEL }];
		settings.workers.default = { target: TARGET, model: MODEL, thinkingLevel: "off" };
		const candidates = [{ agentId: "coder", target: TARGET, model: MODEL, node: "local" }];
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resolveNode: () => ({ node: { id: "local", kind: "local" } }),
			resilienceCooldownMs: 60_000,
			spawnWorker: () => ({
				pid: 402,
				promise: Promise.resolve({ exitCode: 1, signal: null, stderrTail: "503 Service Unavailable" }),
				events: (async function* () {})(),
				abort: () => {},
				heartbeatAt: { current: Date.now() },
			}),
		});
		await bundle.extension.start();
		try {
			const first = await bundle.contract.dispatch(
				unpinnedRequest({ failover: "approved", allowedCandidates: candidates }),
			);
			strictEqual((await first.finalPromise).outcome, "failed");
			await rejects(
				bundle.contract.dispatch(unpinnedRequest({ failover: "approved", allowedCandidates: candidates })),
				/cooling down/,
			);
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
