import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { lastRowid, mergeTraceEvents } from "../client/pages/traces/trace-live-model.js";
import type { TraceEvent } from "../contracts/traces.js";
import { harness } from "./harness/app.js";
import { traceFixture } from "./harness/trace-fixture.js";

test("a live span finish replaces its open event and older replays cannot reopen it", () => {
	const open: TraceEvent = {
		rowid: 1,
		event_id: "tool-1",
		run_id: "run",
		phase_id: "phase",
		parent_id: null,
		type: "tool",
		name: "read",
		payload_json: null,
		tokens: null,
		started_at: "2026-10-07T10:00:00Z",
		ended_at: null,
	};
	const other = { ...open, rowid: 2, event_id: "tool-2" };
	const held = [open, other];
	const finished = { ...open, rowid: 3, ended_at: "2026-10-07T10:00:01Z", payload_json: '{"ok":true}' };
	const merged = mergeTraceEvents(held, [finished]);
	assert.deepEqual(merged, [other, finished]);
	assert.equal(lastRowid(merged), 3);
	assert.equal(merged[0], other);
	assert.equal(open.ended_at, null, "the held open object is never mutated");
	assert.equal(mergeTraceEvents(merged, [open, finished, { ...finished, payload_json: null }]), merged);
	assert.equal(mergeTraceEvents(merged, []), merged);
});

test("paged and batched trace rows keep one newest version per event in cursor order", () => {
	const open: TraceEvent = {
		rowid: 2,
		event_id: "tool",
		run_id: "run",
		phase_id: "phase",
		parent_id: null,
		type: "tool",
		name: "read",
		payload_json: null,
		tokens: null,
		started_at: "2026-10-07T10:00:00Z",
		ended_at: null,
	};
	const older = { ...open, rowid: 1, event_id: "earlier" };
	const other = { ...open, rowid: 3, event_id: "other" };
	const finished = { ...open, rowid: 4, ended_at: "2026-10-07T10:00:01Z" };
	let pages = mergeTraceEvents(undefined, [open, other]);
	pages = mergeTraceEvents(pages, [finished, open, older, finished]);
	assert.deepEqual(pages, [older, other, finished]);
	const batch = mergeTraceEvents(undefined, [open, other, finished, older, open]);
	assert.deepEqual(batch, pages);
	assert.equal(mergeTraceEvents(batch, [older, open, other]), batch);
	assert.equal(lastRowid(batch), 4);
});

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
