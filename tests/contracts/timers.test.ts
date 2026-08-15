import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { negativeDurationCount, rawDurationMs } from "../../src/core/timers.js";
import { createTestClock, TEST_CLOCK_START_MS } from "../harness/clock.js";

describe("rawDurationMs", () => {
	it("returns the signed elapsed and counts a backwards clock", () => {
		const clock = createTestClock();
		const start = clock.now();
		strictEqual(clock.advance(250), start + 250);
		strictEqual(rawDurationMs(start, clock.now()), 250);

		const before = negativeDurationCount();
		clock.set(start - 1_000);
		strictEqual(rawDurationMs(start, clock.now()), -1_000);
		strictEqual(negativeDurationCount(), before + 1);
	});

	it("leaves the counter alone for zero and positive spans", () => {
		const before = negativeDurationCount();
		strictEqual(rawDurationMs(5, 5), 0);
		strictEqual(rawDurationMs(5, 6), 1);
		strictEqual(negativeDurationCount(), before);
	});
});

describe("test clock harness", () => {
	it("freezes until stepped", () => {
		const clock = createTestClock();
		strictEqual(clock.now(), TEST_CLOCK_START_MS);
		strictEqual(clock.now(), TEST_CLOCK_START_MS);
		clock.advance(1);
		strictEqual(clock.now(), TEST_CLOCK_START_MS + 1);
	});

	it("starts anywhere and detaches from the real clock", () => {
		const clock = createTestClock("2026-08-15T02:30:00.000Z");
		strictEqual(clock.now(), Date.parse("2026-08-15T02:30:00.000Z"));
		clock.set(0);
		strictEqual(clock.now(), 0);
		ok(clock.now() !== Date.now());
	});
});
