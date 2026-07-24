import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchNodePlacement } from "../../src/domains/dispatch/extension.js";
import type { DispatchRequest } from "../../src/domains/dispatch/index.js";
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
