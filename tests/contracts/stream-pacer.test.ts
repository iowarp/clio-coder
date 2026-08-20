import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	classifyStreamEvent,
	createStreamPacer,
	type StreamPacerOptions,
	type StreamPacerSlice,
} from "../../src/interactive/stream-pacer.js";

class FakeClock {
	nowMs = 0;
	private nextId = 1;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();

	readonly now = (): number => this.nowMs;

	readonly setTimer = (callback: () => void, delayMs: number): number => {
		const id = this.nextId++;
		this.timers.set(id, { at: this.nowMs + delayMs, callback });
		return id;
	};

	readonly clearTimer = (handle: unknown): void => {
		this.timers.delete(handle as number);
	};

	peekCallback(): (() => void) | null {
		return [...this.timers.values()].sort((left, right) => left.at - right.at)[0]?.callback ?? null;
	}

	takeCallback(): (() => void) | null {
		const next = [...this.timers.entries()].sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
		if (!next) return null;
		this.timers.delete(next[0]);
		return next[1].callback;
	}

	advance(ms: number): void {
		const target = this.nowMs + ms;
		for (;;) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
			if (!due) break;
			const [id, timer] = due;
			this.timers.delete(id);
			this.nowMs = timer.at;
			timer.callback();
		}
		this.nowMs = target;
	}

	get pendingTimers(): number {
		return this.timers.size;
	}
}

function harness(overrides: Partial<StreamPacerOptions> = {}): {
	clock: FakeClock;
	slices: StreamPacerSlice[];
	pacer: ReturnType<typeof createStreamPacer>;
} {
	const clock = new FakeClock();
	const slices: StreamPacerSlice[] = [];
	const pacer = createStreamPacer({
		mode: "on",
		onSlice: (slice) => slices.push(slice),
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		tickMs: 25,
		baseGraphemesPerSecond: 40,
		...overrides,
	});
	return { clock, slices, pacer };
}

function admission(sequence: number, text: string, overrides: Record<string, unknown> = {}) {
	return {
		sequence,
		generation: "turn-1",
		kind: "text" as const,
		contentIndex: 0,
		text,
		...overrides,
	};
}

describe("stream pacer semantic classifier", () => {
	it("drops only transparent raw text/thinking mirrors", () => {
		strictEqual(
			classifyStreamEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta" } }),
			"transparent-mirror",
		);
		strictEqual(
			classifyStreamEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }),
			"transparent-mirror",
		);
		strictEqual(
			classifyStreamEvent({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta" } }),
			"ordered-content-boundary",
		);
	});

	it("separates derived display content, cumulative tool state, input, and conservative boundaries", () => {
		deepStrictEqual(
			["text_delta", "thinking_delta", "tool_execution_update", "scroll", "message_end", "new_event"].map((type) =>
				classifyStreamEvent({ type }),
			),
			[
				"paced-display-content",
				"paced-display-content",
				"cumulative-live-state",
				"non-transcript-input",
				"ordered-content-boundary",
				"ordered-content-boundary",
			],
		);
	});
});

describe("stream pacer queue", () => {
	it("makes off exact and keeps auto conservative unless explicitly admitted", () => {
		const off = harness({ mode: "off" });
		off.pacer.enqueue(admission(1, "whole reply"));
		deepStrictEqual(
			off.slices.map(({ text, reason }) => [text, reason]),
			[["whole reply", "off"]],
		);
		strictEqual(off.clock.pendingTimers, 0);

		const automatic = harness({ mode: "auto" });
		automatic.pacer.enqueue(admission(1, "also whole"));
		deepStrictEqual(
			automatic.slices.map(({ text, reason }) => [text, reason]),
			[["also whole", "off"]],
		);

		const enabled = harness({ mode: "auto", isAutoPacingAllowed: () => true, firstSliceGraphemes: 1 });
		enabled.pacer.enqueue(admission(1, "paced"));
		enabled.clock.advance(0);
		deepStrictEqual(
			enabled.slices.map(({ text, reason }) => [text, reason]),
			[["p", "first"]],
		);
		strictEqual(enabled.clock.pendingTimers, 1);
	});

	it("preserves one FIFO across text, thinking, content indices, and a boundary flush", () => {
		const { pacer, slices, clock } = harness({ firstSliceGraphemes: 1 });
		pacer.enqueue(admission(10, "abc"));
		clock.advance(0);
		pacer.enqueue(admission(11, "THINK", { kind: "thinking" as const, contentIndex: 1 }));
		const result = pacer.flush("tool-boundary");

		deepStrictEqual(
			slices.map(({ sequence, kind, contentIndex, text, reason }) => ({ sequence, kind, contentIndex, text, reason })),
			[
				{ sequence: 10, kind: "text", contentIndex: 0, text: "a", reason: "first" },
				{ sequence: 10, kind: "text", contentIndex: 0, text: "bc", reason: "flush" },
				{ sequence: 11, kind: "thinking", contentIndex: 1, text: "THINK", reason: "flush" },
			],
		);
		deepStrictEqual(result, {
			reason: "tool-boundary",
			fromEpoch: 0,
			toEpoch: 1,
			items: 2,
			graphemes: 7,
			bytes: 7,
		});
	});

	it("never splits extended grapheme clusters and preserves RTL order", () => {
		const { pacer, slices } = harness({ firstSliceGraphemes: 0, maxSliceGraphemes: 1, maxSliceBytes: 4 });
		const clusters = ["e\u0301", "👩‍🔬", "🇺🇳", "שָ", "ל", "ו", "ם"];
		pacer.enqueue(admission(1, clusters.join("")));
		while (pacer.snapshot().queuedGraphemes > 0) pacer.dequeue(1);

		deepStrictEqual(
			slices.map(({ text }) => text),
			clusters,
		);
		strictEqual(slices.map(({ text }) => text).join(""), clusters.join(""));
		ok(
			slices.some(({ bytes }) => bytes > 4),
			"one indivisible ZWJ grapheme may exceed the byte slice cap",
		);
	});

	it("carries fractional arrival/time credit instead of rounding every tick", () => {
		const { pacer, slices, clock } = harness({
			firstSliceGraphemes: 0,
			baseGraphemesPerSecond: 10,
			arrivalCreditRatio: 0.25,
			catchUpWindowMs: Number.MAX_VALUE,
			maxOldestAgeMs: 1_000,
		});
		pacer.enqueue(admission(1, "abc"));
		strictEqual(pacer.snapshot().credit, 0.75);
		clock.advance(24);
		strictEqual(slices.length, 0);
		clock.advance(1);
		deepStrictEqual(
			slices.map(({ text }) => text),
			["a"],
		);
		ok(pacer.snapshot().credit < 0.01, `fractional remainder was ${pacer.snapshot().credit}`);
	});

	it("clamps elapsed credit after event-loop suspension", () => {
		const { pacer, slices, clock } = harness({
			firstSliceGraphemes: 0,
			baseGraphemesPerSecond: 10,
			arrivalCreditRatio: 0,
			catchUpWindowMs: Number.MAX_VALUE,
			maxElapsedMs: 100,
			maxOldestAgeMs: 20_000,
		});
		pacer.enqueue(admission(1, "abcdefghij"));
		const delayedTick = clock.takeCallback();
		ok(delayedTick);
		clock.nowMs = 10_000;
		delayedTick();

		deepStrictEqual(
			slices.map(({ text }) => text),
			["a"],
		);
		strictEqual(pacer.snapshot().queuedGraphemes, 9);
	});

	it("enforces the oldest-grapheme deadline even below the nominal rate", () => {
		const { pacer, slices, clock } = harness({
			firstSliceGraphemes: 0,
			baseGraphemesPerSecond: 0.01,
			arrivalCreditRatio: 0,
			catchUpWindowMs: Number.MAX_VALUE,
			maxOldestAgeMs: 50,
			maxSliceGraphemes: 2,
		});
		pacer.enqueue(admission(1, "abcdef"));
		clock.advance(49);
		strictEqual(slices.length, 0);
		clock.advance(1);
		strictEqual(slices.map(({ text }) => text).join(""), "abcdef");
		ok(slices.every(({ reason, graphemes }) => reason === "deadline" && graphemes <= 2));
		strictEqual(pacer.snapshot().queuedGraphemes, 0);
		strictEqual(clock.pendingTimers, 0);
	});

	it("self-stops while idle and restarts without banking elapsed-time credit", () => {
		const { pacer, slices, clock } = harness({
			firstSliceGraphemes: 0,
			arrivalCreditRatio: 0,
			catchUpWindowMs: Number.MAX_VALUE,
			maxOldestAgeMs: 1_000,
		});
		pacer.enqueue(admission(1, "a"));
		clock.advance(25);
		strictEqual(clock.pendingTimers, 0);
		clock.advance(10_000);
		pacer.enqueue(admission(2, "bcdef"));
		clock.advance(25);

		deepStrictEqual(
			slices.map(({ text }) => text),
			["a", "b"],
		);
		strictEqual(clock.pendingTimers, 1, "only live backlog owns a timer");
	});

	it("drains toward absolute grapheme and byte bounds without reordering", () => {
		const { pacer, slices } = harness({
			firstSliceGraphemes: 0,
			arrivalCreditRatio: 0,
			maxQueueGraphemes: 3,
			maxQueueBytes: 3,
			maxSliceGraphemes: 2,
			maxSliceBytes: 2,
		});
		pacer.enqueue(admission(1, "abcdef"));
		deepStrictEqual(
			slices.map(({ text, reason }) => [text, reason]),
			[
				["ab", "capacity"],
				["cd", "capacity"],
			],
		);
		deepStrictEqual(pacer.snapshot(), {
			mode: "on",
			epoch: 0,
			queuedItems: 1,
			queuedGraphemes: 2,
			queuedBytes: 2,
			oldestAgeMs: 0,
			credit: 0,
			timerPending: true,
			disposed: false,
		});
		pacer.flush("finish");
		strictEqual(slices.map(({ text }) => text).join(""), "abcdef");
	});

	it("consumes folded thinking as one backing-state mutation after older text", () => {
		const { pacer, slices } = harness({ firstSliceGraphemes: 0, maxSliceGraphemes: 3 });
		pacer.enqueue(admission(1, "abc"));
		pacer.enqueue(admission(2, "invisible but retained", { kind: "thinking" as const, folded: true }));
		strictEqual(slices.length, 0, "folded state cannot overtake older visible text");
		pacer.dequeue(3);

		deepStrictEqual(
			slices.map(({ sequence, text, reason }) => [sequence, text, reason]),
			[
				[1, "abc", "tick"],
				[2, "invisible but retained", "folded"],
			],
		);
		strictEqual(slices[1]?.finalForItem, true);
		strictEqual(pacer.snapshot().queuedGraphemes, 0);
	});

	it("invalidates captured epochs and makes a queued stale timer harmless", () => {
		const { pacer, slices, clock } = harness({ firstSliceGraphemes: 0 });
		const oldEpoch = pacer.epoch;
		pacer.enqueue(admission(1, "stale", { epoch: oldEpoch }));
		const staleCallback = clock.peekCallback();
		ok(staleCallback);
		strictEqual(pacer.invalidateEpoch(), oldEpoch + 1);
		strictEqual(pacer.enqueue(admission(2, "rejected", { epoch: oldEpoch })).accepted, false);
		staleCallback();
		deepStrictEqual(slices, []);
		strictEqual(pacer.snapshot().queuedItems, 0);
	});

	it("does not let a cleared same-epoch timer consume or unschedule replacement work", () => {
		const { pacer, slices, clock } = harness({ firstSliceGraphemes: 0, arrivalCreditRatio: 0 });
		pacer.enqueue(admission(1, "old"));
		const staleCallback = clock.peekCallback();
		ok(staleCallback);
		pacer.dequeue(3);
		pacer.enqueue(admission(2, "new"));
		strictEqual(clock.pendingTimers, 1);
		staleCallback();

		deepStrictEqual(
			slices.map(({ text }) => text),
			["old"],
		);
		strictEqual(clock.pendingTimers, 1, "stale callback cannot clear the replacement timer");
		clock.advance(25);
		deepStrictEqual(
			slices.map(({ text }) => text),
			["old", "n"],
		);
	});

	it("flushes abort content in exact order and rejects every post-abort stale admission", () => {
		const log: string[] = [];
		const clock = new FakeClock();
		const pacer = createStreamPacer({
			mode: "on",
			onSlice: ({ text, reason }) => log.push(`${reason}:${text}`),
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			firstSliceGraphemes: 1,
		});
		const epoch = pacer.epoch;
		pacer.enqueue(admission(1, "abc", { epoch }));
		clock.advance(0);
		pacer.enqueue(admission(2, "def", { epoch }));
		pacer.flush("abort");
		log.push("boundary:abort");
		strictEqual(pacer.enqueue(admission(3, "late", { epoch })).accepted, false);

		deepStrictEqual(log, ["first:a", "flush:bc", "flush:def", "boundary:abort"]);
		strictEqual(clock.pendingTimers, 0);
	});

	it("requires a flush between generations and settles exactly once on dispose", () => {
		const { pacer, slices, clock } = harness({ firstSliceGraphemes: 0 });
		pacer.enqueue(admission(1, "one"));
		throws(
			() => pacer.enqueue(admission(2, "two", { generation: "turn-2" })),
			/error changed with queued content|generation changed/,
		);
		const first = pacer.dispose("shutdown");
		const second = pacer.dispose("shutdown-again");
		strictEqual(slices.map(({ text }) => text).join(""), "one");
		strictEqual(first.graphemes, 3);
		strictEqual(second.graphemes, 0);
		strictEqual(clock.pendingTimers, 0);
		strictEqual(pacer.enqueue(admission(3, "never")).accepted, false);
	});
});
