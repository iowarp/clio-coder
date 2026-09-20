import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event } from "../contracts/events.js";
import { EventHub } from "../server/services/event-hub.js";
import { harness } from "./harness/app.js";

test("ring has independent count and byte bounds, ordered replay and epoch/eviction resync", () => {
	const hub = new EventHub();
	for (let i = 0; i < 4200; i++) hub.publish({ type: "toolchain.changed", payload: { id: "herdr" } });
	assert.equal(hub.size, 4096);
	assert.ok(hub.byteSize <= 8 * 1024 * 1024);
	const missed: Event[] = [];
	hub.connect(`${hub.epoch}:4197`, (event) => missed.push(event))();
	assert.deepEqual(
		missed.filter((event) => event.type === "toolchain.changed").map((event) => event.seq),
		[4198, 4199, 4200],
	);
	const old: Event[] = [];
	hub.connect(`${hub.epoch}:1`, (event) => old.push(event))();
	assert.equal(old[0]?.type, "resync");
	assert.equal(old.length, 2);
	const restarted: Event[] = [];
	hub.connect("old-epoch:2", (event) => restarted.push(event))();
	assert.ok(restarted[0]?.type === "resync");
	assert.equal(restarted[0].payload.reason, "epoch");
	for (let i = 0; i < 1100; i++)
		hub.publish({
			type: "operation.progress",
			payload: { resource: "op", revision: i + 1, progress: { at: "now", message: "x".repeat(8192) } },
		});
	assert.ok(hub.size < 1100);
	assert.ok(hub.byteSize <= 8 * 1024 * 1024);
});

test("SSE sends resync first over HTTP and validates query and header cursors", async (t) => {
	const h = await harness();
	t.after(h.close);
	const response = await h.request("/api/events", { headers: { "Last-Event-ID": "old-epoch:1" } });
	const reader = response.body?.getReader();
	assert.ok(reader);
	const first = new TextDecoder().decode((await reader.read()).value);
	assert.match(first, /event: resync/);
	await reader.cancel();
	assert.equal((await h.request("/api/events?after=malformed")).status, 422);
	assert.equal((await h.request("/api/events?after=a:1&after=a:2")).status, 422);
	assert.equal((await h.request("/api/events", { headers: { "Last-Event-ID": "invalid" } })).status, 422);
});

test("a retained replay larger than the live burst budget drains over HTTP without dropping events", async (t) => {
	const h = await harness();
	t.after(h.close);
	for (let i = 0; i < 4000; i++)
		h.hub.publish({
			type: "operation.progress",
			payload: { resource: "op", revision: i + 1, progress: { at: "now", message: "x".repeat(2048) } },
		});
	const after = h.hub.seq - h.hub.size;
	const response = await h.request("/api/events", { headers: { "Last-Event-ID": `${h.hub.epoch}:${after}` } });
	const reader = response.body?.getReader();
	assert.ok(reader);
	const sequences: number[] = [];
	let pending = "",
		done = false;
	while (!done) {
		const chunk = await reader.read();
		if (chunk.done) break;
		pending += new TextDecoder().decode(chunk.value);
		let end = pending.indexOf("\n\n");
		while (end >= 0) {
			const frame = pending.slice(0, end);
			pending = pending.slice(end + 2);
			const data = frame.split("\n").find((line) => line.startsWith("data: "));
			if (data) {
				const event = JSON.parse(data.slice(6)) as Event;
				if (event.type === "hello") done = true;
				else sequences.push(event.seq);
			}
			end = pending.indexOf("\n\n");
		}
	}
	await reader.cancel();
	assert.deepEqual(
		sequences,
		Array.from({ length: h.hub.size }, (_, index) => after + index + 1),
	);
});
