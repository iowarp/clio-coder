import assert from "node:assert/strict";
import { test } from "node:test";
import { type FrameClock, FrameEventBuffer, MAX_FRAME_EVENT_BATCH } from "../client/api/frame-buffer.js";
import type { Event } from "../contracts/events.js";

/** Manual clocks keep the paint cadence deterministic without a browser. */
class ManualClock implements FrameClock {
	#next = 1;
	readonly callbacks = new Map<number, () => void>();
	readonly canceled: number[] = [];
	request(callback: () => void) {
		const handle = this.#next++;
		this.callbacks.set(handle, callback);
		return handle;
	}
	cancel(handle: number) {
		this.canceled.push(handle);
		this.callbacks.delete(handle);
	}
	paint() {
		const callbacks = [...this.callbacks.values()];
		this.callbacks.clear();
		for (const callback of callbacks) callback();
	}
}

const base = { v: 1 as const, epoch: "e1", at: "2026-01-01T00:00:00.000Z" };
const text = (seq: number, value: string): Event => ({
	...base,
	seq,
	type: "turn.text",
	payload: { resource: "s1", revision: seq, turnId: "t1", text: value, origin: "live" },
});
const thought = (seq: number, value: string): Event => ({
	...base,
	seq,
	type: "turn.thought",
	payload: { resource: "s1", revision: seq, turnId: "t1", text: value, origin: "live" },
});
const tool = (seq: number): Event => ({
	...base,
	seq,
	type: "turn.tool",
	payload: {
		resource: "s1",
		revision: seq,
		item: {
			id: "tool-1",
			turnId: "t1",
			sequence: seq,
			kind: "tool",
			text: "Read note",
			status: "in_progress",
			origin: "live",
		},
	},
});
const sequences = (deliveries: (readonly Event[])[]) => deliveries.map((batch) => batch.map((event) => event.seq));

test("stream deltas are delivered once on the display frame in exact wire order", () => {
	const clock = new ManualClock();
	const deliveries: (readonly Event[])[] = [];
	const buffer = new FrameEventBuffer((events) => deliveries.push(events), { paint: clock, isHidden: () => false });
	buffer.push(text(1, "alpha"));
	buffer.push(thought(2, "beta"));
	assert.equal(deliveries.length, 0);
	assert.equal(clock.callbacks.size, 1);
	clock.paint();
	assert.deepEqual(sequences(deliveries), [[1, 2]]);
});

test("a control event immediately flushes preceding stream deltas in one ordered delivery", () => {
	const clock = new ManualClock();
	const deliveries: (readonly Event[])[] = [];
	const buffer = new FrameEventBuffer((events) => deliveries.push(events), { paint: clock, isHidden: () => false });
	buffer.push(text(1, "before tool"));
	buffer.push(tool(2));
	assert.deepEqual(sequences(deliveries), [[1, 2]]);
	assert.equal(clock.callbacks.size, 0);
	assert.equal(clock.canceled.length, 1);
});

test("a burst past the default ceiling delivers in bounded chunks rather than growing", () => {
	const clock = new ManualClock();
	const deliveries: (readonly Event[])[] = [];
	const buffer = new FrameEventBuffer((events) => deliveries.push(events), { paint: clock, isHidden: () => false });
	for (let seq = 1; seq <= MAX_FRAME_EVENT_BATCH + 3; seq++) buffer.push(text(seq, `chunk ${seq}`));
	assert.equal(deliveries.length, 1);
	assert.equal(deliveries[0]?.length, MAX_FRAME_EVENT_BATCH);
	assert.equal(deliveries[0]?.at(-1)?.seq, MAX_FRAME_EVENT_BATCH);
	clock.paint();
	assert.deepEqual(sequences(deliveries).at(-1), [
		MAX_FRAME_EVENT_BATCH + 1,
		MAX_FRAME_EVENT_BATCH + 2,
		MAX_FRAME_EVENT_BATCH + 3,
	]);
});

test("the stream queue is bounded and close drops an unpainted presentation batch", () => {
	const clock = new ManualClock();
	const deliveries: (readonly Event[])[] = [];
	const buffer = new FrameEventBuffer((events) => deliveries.push(events), {
		paint: clock,
		maximumBatch: 2,
		isHidden: () => false,
	});
	buffer.push(text(1, "a"));
	buffer.push(text(2, "b"));
	assert.deepEqual(sequences(deliveries), [[1, 2]]);
	buffer.push(text(3, "discarded on close"));
	buffer.close();
	clock.paint();
	assert.equal(deliveries.length, 1);
	buffer.push(text(4, "ignored after close"));
	assert.equal(deliveries.length, 1);
});

test("a hidden tab delivers on the fallback clock and a visible flush drains it", () => {
	const paint = new ManualClock(),
		hidden = new ManualClock();
	const deliveries: (readonly Event[])[] = [];
	let isHidden = true;
	const buffer = new FrameEventBuffer((events) => deliveries.push(events), { paint, hidden, isHidden: () => isHidden });
	buffer.push(text(1, "a"));
	assert.equal(paint.callbacks.size, 0);
	assert.equal(hidden.callbacks.size, 1);
	isHidden = false;
	buffer.flush();
	assert.deepEqual(sequences(deliveries), [[1]]);
	assert.equal(hidden.canceled.length, 1);
});

test("a visibility flip while a frame is outstanding moves the pending batch to the new clock", () => {
	const paint = new ManualClock(),
		hidden = new ManualClock();
	const deliveries: (readonly Event[])[] = [];
	let isHidden = false;
	const buffer = new FrameEventBuffer((events) => deliveries.push(events), { paint, hidden, isHidden: () => isHidden });
	buffer.push(text(1, "a"));
	assert.equal(paint.callbacks.size, 1);
	isHidden = true;
	buffer.push(text(2, "b"));
	assert.equal(paint.callbacks.size, 0);
	assert.equal(paint.canceled.length, 1);
	assert.equal(hidden.callbacks.size, 1);
	hidden.paint();
	assert.deepEqual(sequences(deliveries), [[1, 2]]);
});

test("an invalid maximum frame batch is rejected at construction", () => {
	assert.throws(() => new FrameEventBuffer(() => undefined, { maximumBatch: 0 }), /positive safe integer/u);
	assert.throws(() => new FrameEventBuffer(() => undefined, { maximumBatch: 1.5 }), /positive safe integer/u);
});
