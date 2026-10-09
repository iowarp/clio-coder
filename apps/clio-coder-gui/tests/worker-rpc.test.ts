import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Problem } from "../contracts/common.js";
import { WorkerHost } from "../server/worker/host.js";
import { PINNED_TOOLS } from "./fixtures/toolchain.js";
import { harness, json } from "./harness/app.js";
import { scratchHome } from "./harness/scratch-home.js";

test("65 concurrent HTTP reads overflow the 64-call queue with a retryable problem", async (t) => {
	const h = await harness({ readDelayMs: 20 });
	t.after(h.close);
	const replies = await Promise.all(Array.from({ length: 65 }, () => h.request("/api/toolchain/tools")));
	const refused = replies.filter((response) => response.status === 503);
	assert.ok(refused.length >= 1);
	for (const response of refused) {
		assert.equal((await json(response, Problem)).code, "unavailable");
		assert.equal(response.headers.get("Retry-After"), "1");
	}
	assert.equal(replies.filter((response) => response.status === 200).length, 64);
});

test("expired synchronous read is discarded, keeps capacity until completion, and later reads work", async (t) => {
	const home = await scratchHome();
	t.after(home.close);
	const worker = new WorkerHost("reads", { fixture: true, readDelayMs: 100 }, home.env);
	t.after(() => worker.close());
	await worker.call("tools.list", {});
	await assert.rejects(worker.call("tools.list", {}, { deadlineMs: 15 }), /exceeded its deadline/);
	assert.equal(worker.pendingCount, 1);
	await setTimeout(130);
	assert.equal(worker.pendingCount, 0);
	assert.equal((await worker.call("tools.list", {})).rows.length, PINNED_TOOLS.length);
});

test("worker exit fails pending reads and the next call restarts the worker", async (t) => {
	const home = await scratchHome();
	t.after(home.close);
	const settings = { fixture: true, crashRead: true };
	const worker = new WorkerHost("reads", settings, home.env);
	t.after(() => worker.close());
	await assert.rejects(worker.call("tools.list", {}), /worker exited/);
	settings.crashRead = false;
	assert.equal((await worker.call("tools.list", {})).rows.length, PINNED_TOOLS.length);
});

test("warm read lanes overlap, so one slow adapter no longer holds the next read", async (t) => {
	const home = await scratchHome();
	t.after(home.close);
	const worker = new WorkerHost("reads", { fixture: true, readDelayMs: 120, readLanes: 2 }, home.env);
	t.after(() => worker.close());
	await Promise.all([worker.call("tools.list", {}), worker.call("tools.list", {})]);
	assert.equal(worker.laneCount, 2);
	const start = performance.now();
	await Promise.all([worker.call("tools.list", {}), worker.call("tools.list", {})]);
	const elapsed = performance.now() - start;
	assert.ok(elapsed < 240, `Two warm lanes must overlap two 120 ms reads; observed ${elapsed} ms`);
});

test("a queued read spends its deadline on its own work, not on the call ahead of it", async (t) => {
	const home = await scratchHome();
	t.after(home.close);
	const worker = new WorkerHost("reads", { fixture: true, readDelayMs: 300, readLanes: 1 }, home.env);
	t.after(() => worker.close());
	await worker.call("tools.list", {});
	const blocker = worker.call("tools.list", {});
	// 400 ms covers this call's own 300 ms of work but not the 300 ms the blocker
	// still holds the lane for. Under enqueue-time accounting it returned 503 with
	// most of its budget spent waiting rather than working.
	const queued = worker.call("tools.list", {}, { deadlineMs: 400 });
	assert.equal((await queued).rows.length, PINNED_TOOLS.length);
	await blocker;
});

test("HTTP read deadline returns an unavailable problem while the adapter completes", async (t) => {
	const h = await harness({ readDelayMs: 100, readDeadlineMs: 20 });
	t.after(h.close);
	// Warm-up only primes the worker; a cold start on a loaded 4-vCPU runner
	// exceeded 2 s in ci (22). The 20 ms read deadline is what this test checks.
	await h.reads.call("tools.list", {}, { deadlineMs: 10_000 });
	const response = await h.request("/api/toolchain/tools");
	assert.equal(response.status, 503);
	assert.equal((await json(response, Problem)).code, "unavailable");
	assert.equal(h.reads.pendingCount, 1);
	await setTimeout(140);
	assert.equal(h.reads.pendingCount, 0);
});
