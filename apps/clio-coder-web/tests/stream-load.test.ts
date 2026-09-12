import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import type { Event } from "../contracts/events.js";
import { SessionBuffer } from "../contracts/session-projection.js";
import { type SessionDelta, SessionDeltas } from "../contracts/sessions.js";
import { harness } from "./harness/app.js";

async function stream(response: Response) {
	const reader = response.body?.getReader();
	assert.ok(reader);
	let pending = "";
	const queue: Event[] = [],
		decoder = new TextDecoder();
	return {
		close: () => reader.cancel(),
		next: async (): Promise<Event> => {
			while (!queue.length) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("SSE ended before the terminal event.");
				pending += decoder.decode(chunk.value, { stream: true });
				let end = pending.indexOf("\n\n");
				while (end >= 0) {
					const frame = pending.slice(0, end);
					pending = pending.slice(end + 2);
					const data = frame.split("\n").find((line) => line.startsWith("data: "));
					if (data) queue.push(JSON.parse(data.slice(6)) as Event);
					end = pending.indexOf("\n\n");
				}
			}
			return queue.shift() as Event;
		},
	};
}
test("E2/E4: 1400-event turn reconnects over HTTP without lost/reordered text and keeps memory bounded", {
	timeout: 30000,
}, async (t) => {
	const h = await harness({}, { scenario: "loop", env: { NODE_ENV: "test" } });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path),
		session = await h.supervisor.open(workspace.id);
	// Worker construction starts asynchronous module loading. Establish readiness
	// before measuring turn growth so CPU speed cannot move startup into the sample.
	await Promise.all([h.reads.call("runtime.info", {}), h.ops.call("runtime.info", {})]);
	const buffer = new SessionBuffer();
	buffer.snapshot(session);
	const before = process.memoryUsage();
	let peakRss = before.rss,
		peakHeap = before.heapUsed;
	const sample = globalThis.setInterval(() => {
		const current = process.memoryUsage();
		peakRss = Math.max(peakRss, current.rss);
		peakHeap = Math.max(peakHeap, current.heapUsed);
	}, 20);
	t.after(() => clearInterval(sample));
	const sequences: number[] = [],
		text: string[] = [];
	let connection = await stream(await h.request("/api/events"));
	t.after(() => connection.close());
	assert.equal((await connection.next()).type, "hello");
	h.supervisor.startTurn(session.id, "Stream 1400 chunks");
	let reconnected = false;
	while (true) {
		const event = await connection.next();
		if (event.type === "hello") continue;
		assert.notEqual(event.type, "resync", "The mid-turn cursor must remain replayable.");
		sequences.push(event.seq);
		if (Object.hasOwn(SessionDeltas, event.type)) buffer.event(event as SessionDelta);
		if (event.type === "turn.text") text.push(event.payload.text);
		if (!reconnected && text.length === 350) {
			reconnected = true;
			await connection.close();
			await setTimeout(500);
			connection = await stream(
				await h.request("/api/events", { headers: { "Last-Event-ID": `${event.epoch}:${event.seq}` } }),
			);
		}
		if (event.type === "turn.finished") break;
	}
	assert.equal(text.length, 1400);
	assert.deepEqual(
		text,
		Array.from({ length: 1400 }, (_, index) => `${index} `),
	);
	assert.deepEqual(
		sequences,
		Array.from({ length: 1402 }, (_, index) => session.revision + index + 1),
	);
	assert.deepEqual(buffer.value, h.supervisor.get(session.id));
	assert.equal(buffer.hasGap, false);
	assert.equal(h.hub.size, 1403);
	assert.ok(h.hub.byteSize < 8 * 1024 * 1024);
	const final = process.memoryUsage();
	peakRss = Math.max(peakRss, final.rss);
	peakHeap = Math.max(peakHeap, final.heapUsed);
	// Budgets are fixed before measurement: 128 MiB RSS growth / 64 MiB heap growth,
	// including resident workers, reader, and client projection after startup.
	t.diagnostic(
		`E2/E4 ${JSON.stringify({ eventCount: sequences.length, turnTextReplayable: true, ringEntries: h.hub.size, ringBytes: h.hub.byteSize, beforeRss: before.rss, peakRss, beforeHeap: before.heapUsed, peakHeap, snapshotBytes: Buffer.byteLength(JSON.stringify(buffer.value)) })}`,
	);
	assert.ok(peakRss - before.rss < 128 * 1024 * 1024, `Streaming RSS grew by ${peakRss - before.rss} bytes.`);
	assert.ok(
		peakHeap - before.heapUsed < 64 * 1024 * 1024,
		`Streaming heap grew by ${peakHeap - before.heapUsed} bytes.`,
	);
});
