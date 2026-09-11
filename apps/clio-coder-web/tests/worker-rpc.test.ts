import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Problem } from "../contracts/common.js";
import { WorkerHost } from "../server/worker/host.js";
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
	assert.equal((await worker.call("tools.list", {})).rows.length, 3);
});

test("worker exit fails pending reads and the next call restarts the worker", async (t) => {
	const home = await scratchHome();
	t.after(home.close);
	const settings = { fixture: true, crashRead: true };
	const worker = new WorkerHost("reads", settings, home.env);
	t.after(() => worker.close());
	await assert.rejects(worker.call("tools.list", {}), /worker exited/);
	settings.crashRead = false;
	assert.equal((await worker.call("tools.list", {})).rows.length, 3);
});

test("HTTP read deadline returns an unavailable problem while the adapter completes", async (t) => {
	const h = await harness({ readDelayMs: 100, readDeadlineMs: 20 });
	t.after(h.close);
	await h.reads.call("tools.list", {}, { deadlineMs: 2000 });
	const response = await h.request("/api/toolchain/tools");
	assert.equal(response.status, 503);
	assert.equal((await json(response, Problem)).code, "unavailable");
	assert.equal(h.reads.pendingCount, 1);
	await setTimeout(140);
	assert.equal(h.reads.pendingCount, 0);
});
