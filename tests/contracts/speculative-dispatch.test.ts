/**
 * Speculative dispatch: held worker processes and what adopting one may change.
 *
 * A dispatch that matches the forecast adopts the held process, and the spec it
 * writes is the one a cold spawn would have received. Anything else spawns cold
 * and the held process is killed when the turn settles. With the leaf off, or
 * the site unbound, nothing is held and the forecast request is unchanged.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import {
	createHeldWorkerPool,
	type HeldWorkerKey,
	scheduleSpeculativeHold,
} from "../../src/domains/dispatch/held-workers.js";
import {
	type HeldWorkerProcess,
	type SpawnedWorker,
	spawnHeldWorkerProcess,
	type WorkerSpec,
} from "../../src/domains/dispatch/worker-spawn.js";
import {
	createDispatchForecastSite,
	dispatchForecastSite,
} from "../../src/domains/providers/sites/dispatch-forecast.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const REQUEST: DispatchRequest = {
	agentId: "scout",
	executionRole: "researcher",
	task: "Map how the footer renders dispatch notices.",
	requestOrigin: "internal",
	resultContractOverride: { kind: "provenance-report" },
};

function fakeWorker(): SpawnedWorker {
	return {
		pid: null,
		promise: Promise.resolve({ exitCode: 0, signal: null }),
		heartbeatAt: { current: Date.now(), monotonic: performance.now() },
		abort: () => {},
		send: () => true,
		events: (async function* () {
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
}

interface Harness {
	held: HeldWorkerKey[];
	adopted: WorkerSpec[];
	discarded: number;
	cold: WorkerSpec[];
	bundle: ReturnType<typeof makeDispatchBundle>;
}

function harness(speculativeDispatch: boolean): Harness {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	settings.fleet.speculativeDispatch = speculativeDispatch;
	const state = { held: [], adopted: [], discarded: 0, cold: [] } as unknown as Harness;
	state.bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
		heartbeatIntervalMs: 3_600_000,
		spawnWorker: (spec) => {
			state.cold.push(spec);
			return fakeWorker();
		},
		spawnHeldWorker: (key) => {
			state.held.push(key);
			let status: "held" | "adopted" | "discarded" = "held";
			const held: HeldWorkerProcess = {
				pid: null,
				alive: () => status === "held",
				adopt: (spec) => {
					if (status !== "held") return null;
					status = "adopted";
					state.adopted.push(spec);
					return fakeWorker();
				},
				discard: () => {
					if (status !== "held") return;
					status = "discarded";
					state.discarded += 1;
				},
			};
			return held;
		},
	});
	return state;
}

async function dispatchOnce(h: Harness, request: DispatchRequest = REQUEST) {
	const run = await h.bundle.contract.dispatch(request);
	await run.finalPromise;
	return h.bundle.contract.getRun(run.runId);
}

describe("contracts/speculative dispatch", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("starts a forecast hold before the resumed turn and suppresses one after settle", async () => {
		const started: string[] = [];
		async function refresh() {
			scheduleSpeculativeHold(() => started.push("first"));
		}
		await refresh();
		deepStrictEqual(started, ["first"], "the main turn resumed before its forecast hold started");

		const cancel = scheduleSpeculativeHold(() => started.push("settled"));
		cancel();
		await Promise.resolve();
		deepStrictEqual(started, ["first"], "a queued hold started after turn settlement");
	});

	it("adopts a held process for a matching dispatch and writes it the spec a cold spawn gets", async () => {
		const h = harness(true);
		await h.bundle.extension.start();
		try {
			strictEqual(h.bundle.contract.speculate?.({ agentId: "scout", count: 1 }), 1);
			strictEqual(h.held.length, 1);
			strictEqual(h.held[0]?.agentId, "scout");
			const adoptedRun = await dispatchOnce(h);
			strictEqual(h.adopted.length, 1, "the matching dispatch adopted the held process");
			strictEqual(h.cold.length, 0, "no cold spawn ran");
			ok(adoptedRun?.timing?.heldWorkerAdoptedAt, "the run records that it adopted a held process");
			strictEqual(adoptedRun?.timing?.heldWorkerAdoptedAt, adoptedRun?.timing?.workerSpawnedAt);

			const coldRun = await dispatchOnce(h);
			strictEqual(h.cold.length, 1, "with nothing held the next dispatch spawns cold");
			strictEqual(coldRun?.timing?.heldWorkerAdoptedAt, undefined);
			deepStrictEqual(h.adopted[0], h.cold[0], "adoption changed the spec");
			deepStrictEqual(h.bundle.contract.speculativeStats?.(), { held: 1, adopted: 1, discarded: 0, live: 0 });
		} finally {
			await h.bundle.extension.stop?.();
		}
	});

	it("spawns cold for any other dispatch and discards the held process when the turn settles", async () => {
		const h = harness(true);
		await h.bundle.extension.start();
		try {
			strictEqual(h.bundle.contract.speculate?.({ agentId: "coder", count: 1 }), 1);
			const run = await dispatchOnce(h);
			strictEqual(h.adopted.length, 0);
			strictEqual(h.cold.length, 1);
			strictEqual(run?.timing?.heldWorkerAdoptedAt, undefined);
			strictEqual(h.bundle.contract.releaseSpeculative?.("turn settled"), 1);
			strictEqual(h.discarded, 1);
			deepStrictEqual(h.bundle.contract.speculativeStats?.(), { held: 1, adopted: 0, discarded: 1, live: 0 });
		} finally {
			await h.bundle.extension.stop?.();
		}
	});

	it("holds at most two processes and kills what is left at session end", async () => {
		const h = harness(true);
		await h.bundle.extension.start();
		strictEqual(h.bundle.contract.speculate?.({ agentId: "scout", count: 2 }), 2);
		strictEqual(h.bundle.contract.speculate?.({ agentId: "coder", count: 1 }), 0, "the cap is shared");
		await h.bundle.extension.stop?.();
		strictEqual(h.discarded, 2);
	});

	it("holds nothing with the leaf off", async () => {
		const h = harness(false);
		await h.bundle.extension.start();
		try {
			strictEqual(h.bundle.contract.speculate?.({ agentId: "scout", count: 2 }), 0);
			await dispatchOnce(h);
			strictEqual(h.held.length, 0);
			strictEqual(h.cold.length, 1);
		} finally {
			await h.bundle.extension.stop?.();
		}
	});

	it("asks the forecast exactly what it asked before unless recipes are supplied", () => {
		const evidence = { task: "explore this repo fully", previous: "" };
		const plain = dispatchForecastSite.prepare(evidence);
		deepStrictEqual(createDispatchForecastSite({ recipes: () => null }).prepare(evidence), plain);
		deepStrictEqual(Object.keys(plain?.questions ?? {}), ["dispatch", "shape"]);
		const asked = createDispatchForecastSite({
			recipes: () => [
				{ id: "scout", description: "Read-only reconnaissance" },
				{ id: "coder", description: "Makes code changes" },
			],
		}).prepare(evidence);
		deepStrictEqual(Object.keys(asked?.questions ?? {}), ["dispatch", "shape", "recipe"]);
		deepStrictEqual(asked?.questions.dispatch, plain?.questions.dispatch);
		deepStrictEqual(asked?.questions.shape, plain?.questions.shape);
	});

	it("reads the recipe only when asked, and never puts it in the hint", () => {
		const site = createDispatchForecastSite({
			recipes: () => [
				{ id: "scout", description: "Read-only reconnaissance" },
				{ id: "coder", description: "Makes code changes" },
			],
		});
		const ask = site.prepare({ task: "t", previous: "" });
		ok(ask);
		const answers = {
			dispatch: { type: "noul" as const, noul: 0.9 },
			shape: { type: "choice" as const, choice: "single", confidence: 1, probabilities: { single: 1 } },
			recipe: { type: "choice" as const, choice: "scout", confidence: 0.9, probabilities: { scout: 0.95, coder: 0.05 } },
		};
		const value = site.read(answers, ask);
		strictEqual(value?.recipe, "scout");
		ok(!site.hint?.(value as NonNullable<typeof value>)?.includes("scout"));
		strictEqual(
			site.read(
				{ ...answers, recipe: { ...answers.recipe, confidence: 0.4, probabilities: { scout: 0.7, coder: 0.3 } } },
				ask,
			)?.recipe,
			null,
			"below the 0.6 bar the recipe abstains",
		);
		const plainAsk = dispatchForecastSite.prepare({ task: "t", previous: "" });
		ok(plainAsk);
		strictEqual("recipe" in (dispatchForecastSite.read(answers, plainAsk) ?? {}), false);
		deepStrictEqual(dispatchForecastSite.summarize?.({ dispatch: 0.9, shape: "single" }), {
			dispatch: 0.9,
			shape: "single",
		});
	});
});

/** True while any process of the group led by `pid` is alive. */
function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return check();
}

describe("contracts/speculative dispatch processes", { skip: process.platform === "win32" }, () => {
	const HOLDER = ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(3));"];

	it("leaves no process behind when a turn settles or is cancelled", async () => {
		const spawned: HeldWorkerProcess[] = [];
		const pool = createHeldWorkerPool({
			spawnHeld: (key) => {
				const held = spawnHeldWorkerProcess(process.execPath, HOLDER, { cwd: key.cwd });
				spawned.push(held);
				return held;
			},
		});
		const key: HeldWorkerKey = {
			agentId: "scout",
			targetId: "t",
			wireModelId: "m",
			runtimeId: "openai",
			cwd: process.cwd(),
		};
		// Settle: an unused prediction.
		strictEqual(pool.hold(key, 2), 2);
		const pids = spawned.map((held) => held.pid).filter((pid): pid is number => pid !== null);
		strictEqual(pids.length, 2);
		ok(pids.every(groupAlive));
		strictEqual(pool.releaseAll("turn settled"), 2);
		ok(await waitFor(() => !pids.some(groupAlive), 5_000), "a held process outlived the settled turn");

		// Cancel: a prediction taken by a dispatch that was cancelled before it wrote a spec.
		strictEqual(pool.hold(key, 1), 1);
		const taken = pool.take(key);
		ok(taken?.pid);
		taken.discard();
		ok(await waitFor(() => !groupAlive(taken.pid as number), 5_000), "a cancelled adoption left its process");
		deepStrictEqual(pool.stats().live, 0);
	});

	it("a held worker whose parent dies exits on its own", { timeout: 30_000 }, async (context) => {
		const entry = join(resolvePackageRoot(), "dist/worker/entry.js");
		if (!existsSync(entry)) {
			context.skip("dist/worker/entry.js is not built");
			return;
		}
		// A parent that holds a native worker, prints its pid and dies by SIGKILL,
		// so no exit hook of its own can run.
		const script = `
			import { spawnHeldNativeWorker } from ${JSON.stringify(join(resolvePackageRoot(), "src/domains/dispatch/worker-spawn.ts"))};
			const held = spawnHeldNativeWorker({ cwd: ${JSON.stringify(mkdtempSync(join(tmpdir(), "clio-held-")))} });
			process.stdout.write(String(held.pid) + "\\n");
			setTimeout(() => process.kill(process.pid, "SIGKILL"), 300);
		`;
		const parent = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		let out = "";
		parent.stdout.on("data", (chunk) => {
			out += String(chunk);
		});
		await new Promise((resolve) => parent.once("exit", resolve));
		const pid = Number(out.trim());
		ok(Number.isInteger(pid) && pid > 0, `no held pid printed: ${out}`);
		ok(await waitFor(() => !groupAlive(pid), 15_000), "the held worker outlived its parent");
		// The group is gone, not merely the leader; ps exits 1 when it lists nothing.
		let listed = "";
		try {
			listed = execFileSync("ps", ["-o", "pid=", "-g", String(pid)], { encoding: "utf8" }).trim();
		} catch {
			listed = "";
		}
		strictEqual(listed, "");
	});
});
