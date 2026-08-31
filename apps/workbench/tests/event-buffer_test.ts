import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { type FrameClock, FrameEventBuffer } from "../src/event-buffer.ts";
import type { ServerEvent } from "../src/protocol.ts";
import { serverEventFixture } from "./fixtures.ts";

class ManualFrameClock implements FrameClock {
	#nextHandle = 1;
	readonly callbacks = new Map<number, FrameRequestCallback>();
	readonly canceled: number[] = [];

	request(callback: FrameRequestCallback): number {
		const handle = this.#nextHandle++;
		this.callbacks.set(handle, callback);
		return handle;
	}

	cancel(handle: number): void {
		this.canceled.push(handle);
		this.callbacks.delete(handle);
	}

	paint(): void {
		const callbacks = [...this.callbacks.values()];
		this.callbacks.clear();
		for (const callback of callbacks) callback(16.67);
	}
}

function text(sequence: number, value: string) {
	return serverEventFixture("turn.text", { text: value, agents: [], source: "observed-on-acp" }, { sequence });
}

function thought(sequence: number, value: string) {
	return serverEventFixture("turn.thought", { text: value, agents: [], source: "observed-on-acp" }, { sequence });
}

Deno.test("stream deltas are delivered once on the display frame in exact wire order", () => {
	const clock = new ManualFrameClock();
	const deliveries: Array<readonly ServerEvent[]> = [];
	const buffer = new FrameEventBuffer((events) => deliveries.push(events), clock);
	buffer.push(text(1, "alpha"));
	buffer.push(thought(2, "beta"));

	equal(deliveries.length, 0);
	equal(clock.callbacks.size, 1);
	clock.paint();
	deepStrictEqual(deliveries.map((events) => events.map((event) => event.sequence)), [[1, 2]]);
});

Deno.test("a control event immediately flushes preceding stream deltas in one ordered delivery", () => {
	const clock = new ManualFrameClock();
	const deliveries: Array<readonly ServerEvent[]> = [];
	const buffer = new FrameEventBuffer((events) => deliveries.push(events), clock);
	buffer.push(text(1, "before tool"));
	buffer.push(serverEventFixture("turn.tool", {
		toolCallId: "tool-1",
		title: "Read note",
		kind: "read",
		status: "in_progress",
		summary: "Reading the note.",
		locations: [{ segments: ["note.md"] }],
		agents: [],
		source: "observed-on-acp",
	}, { sequence: 2 }));

	deepStrictEqual(deliveries.map((events) => events.map((event) => event.sequence)), [[1, 2]]);
	equal(clock.callbacks.size, 0);
	equal(clock.canceled.length, 1);
});

Deno.test("the stream queue is bounded and close drops an unpainted presentation batch", () => {
	const clock = new ManualFrameClock();
	const deliveries: Array<readonly ServerEvent[]> = [];
	const buffer = new FrameEventBuffer((events) => deliveries.push(events), clock, 2);
	buffer.push(text(1, "a"));
	buffer.push(text(2, "b"));
	deepStrictEqual(deliveries.map((events) => events.map((event) => event.sequence)), [[1, 2]]);

	buffer.push(text(3, "discarded on close"));
	buffer.close();
	clock.paint();
	equal(deliveries.length, 1);
	buffer.push(text(4, "ignored after close"));
	equal(deliveries.length, 1);
});

Deno.test("an invalid maximum frame batch is rejected at construction", () => {
	const clock = new ManualFrameClock();
	throws(() => new FrameEventBuffer(() => undefined, clock, 0), /positive safe integer/u);
});
