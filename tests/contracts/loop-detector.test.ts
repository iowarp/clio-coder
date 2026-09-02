import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createLoopState, observe } from "../../src/domains/safety/loop-detector.js";

describe("loop detector retention", () => {
	it("catches a batch of distinct calls re-emitted verbatim on its third round", () => {
		// A live session repeated the same eleven read-only bash calls five
		// times, one batch every twenty seconds, and every call was admitted:
		// no key ever had a third repeat inside a 30 s window or the last four
		// attempts. The retained tail now covers three rounds of a wide batch.
		const batch = Array.from({ length: 11 }, (_, i) => `turn-1|0|call-${i}`);
		let state = createLoopState();
		let tripped: string | null = null;
		let now = 0;
		for (let round = 0; round < 3 && tripped === null; round += 1) {
			for (const key of batch) {
				const [next, verdict] = observe(state, key, now);
				state = next;
				now += 20;
				if (verdict.looping) {
					tripped = `${round}:${key}`;
					break;
				}
			}
			now += 20_000;
		}
		strictEqual(tripped, "2:turn-1|0|call-0");
	});

	it("keeps the retained-tail size across observations", () => {
		let state = createLoopState({ keepLastAttempts: 8 });
		for (let i = 0; i < 20; i += 1) [state] = observe(state, `k${i}`, i * 60_000);
		strictEqual(state.recent.length, 8);
	});
});
