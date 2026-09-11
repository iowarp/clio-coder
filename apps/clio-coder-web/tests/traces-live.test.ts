import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { harness } from "./harness/app.js";
import { traceFixture } from "./harness/trace-fixture.js";

test("live tail delivers post-connect appends in rowid order and closes after two terminal idle polls", {
	timeout: 10000,
}, async (t) => {
	const h = await harness(),
		fixture = traceFixture(join(h.home.path, "state"));
	t.after(async () => {
		fixture.close();
		await h.close();
	});
	const response = await h.request("/api/traces/runs/run-0000/live?after=2&token=test-token", {
		headers: { Authorization: "" },
	});
	assert.equal(response.status, 200);
	const stream = response.body?.getReader();
	assert.ok(stream);
	const decoder = new TextDecoder();
	let text = decoder.decode((await stream.read()).value);
	assert.match(text, /event: ready/);
	fixture.append("event-3");
	fixture.append("event-4");
	fixture.finish();
	const started = performance.now();
	while (true) {
		const read = await stream.read();
		if (read.done) break;
		text += decoder.decode(read.value);
	}
	const elapsed = performance.now() - started;
	assert.deepEqual(
		[...text.matchAll(/^id: (\d+)/gm)].map((match) => Number(match[1])),
		[3, 4],
	);
	assert.match(text, /event: finished/);
	assert.ok(elapsed < 1800, `${elapsed}ms`);
	assert.equal((await h.request("/api/traces/runs/run-0000/live", { headers: { "Last-Event-ID": "bad" } })).status, 422);
	assert.equal(
		(await h.request("/api/traces/runs/run-0000?token=test-token", { headers: { Authorization: "" } })).status,
		401,
	);
});
