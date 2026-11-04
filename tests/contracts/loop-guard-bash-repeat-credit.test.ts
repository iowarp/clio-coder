import { deepStrictEqual, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { createLoopState, hashToolCall, observe } from "../../src/domains/safety/loop-detector.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";

/**
 * Deliberate (#445, the maintainer's decision at every autonomy level): a bash
 * call that ran at least 5 s, or whose result changed, starts a new repeat
 * epoch, so a slow identical command no longer trips the loop guard. The turn
 * tool budget and the session cost ceiling still bound it.
 */
function harness(budget?: { soft: number; hard: number }) {
	let loopState = createLoopState();
	const safety = {
		observeLoop(key: string, now: number) {
			const [next, verdict] = observe(loopState, key, now);
			loopState = next;
			return verdict;
		},
	} as unknown as Parameters<typeof createLoopGuardRegistration>[0]["safety"];
	const guard = createLoopGuardRegistration({
		safety,
		turnBlockBudget: 2,
		turnSynthesisLockout: true,
		...(budget === undefined ? {} : { turnToolCallBudget: () => budget }),
	});
	const args = { command: "sleep 300; gh pr checks 42", timeout_ms: 600_000 };
	const call = (result: { elapsedMs: number; output: string; failed?: boolean }): boolean => {
		const base = { turnId: "turn-1", toolName: "bash", toolArgs: args };
		const before = guard.evaluate({
			...base,
			hook: "before_tool",
			metadata: { callFingerprint: hashToolCall("bash", args) },
		} as MiddlewareHookInput);
		if (before.some((effect) => effect.kind === "block_tool")) return false;
		guard.evaluate({
			...base,
			hook: "after_tool",
			metadata: {
				resultKind: result.failed === true ? "error" : "ok",
				outcomeFingerprint: result.output,
				...(result.failed === true ? {} : { resultFingerprint: result.output }),
			},
			toolResultDetails: { elapsedMs: result.elapsedMs },
		} as MiddlewareHookInput);
		return true;
	};
	return { call };
}

function admitted(run: (index: number) => boolean, calls: number): boolean[] {
	return Array.from({ length: calls }, (_, index) => run(index));
}

describe("loop guard bash repeat credit (#445)", () => {
	it("still blocks a fast identical command with an identical result on its third call", () => {
		const { call } = harness();
		deepStrictEqual(
			admitted(() => call({ elapsedMs: 100, output: "pending" }), 3),
			[true, true, false],
		);
	});

	it("lets a slow identical command keep polling on an unchanged result", () => {
		const { call } = harness();
		ok(admitted(() => call({ elapsedMs: 300_000, output: "pending" }), 12).every(Boolean));
	});

	it("counts a run of exactly 5 s as slow and one just under it as fast", () => {
		const atBound = harness();
		ok(admitted(() => atBound.call({ elapsedMs: 5_000, output: "pending" }), 6).every(Boolean));
		const under = harness();
		deepStrictEqual(
			admitted(() => under.call({ elapsedMs: 4_999, output: "pending" }), 3),
			[true, true, false],
		);
	});

	it("lets a fast identical command keep polling while its result changes, failing results included", () => {
		const { call } = harness();
		ok(admitted((index) => call({ elapsedMs: 100, output: `pending ${index}` }), 10).every(Boolean));
		const failing = harness();
		ok(
			admitted((index) => failing.call({ elapsedMs: 100, output: `exit 8: ${index} pending`, failed: true }), 10).every(
				Boolean,
			),
		);
	});

	it("leaves the turn tool budget in force over a credited poll", () => {
		const { call } = harness({ soft: 5, hard: 8 });
		deepStrictEqual(
			admitted(() => call({ elapsedMs: 300_000, output: "pending" }), 6),
			[true, true, true, true, false, false],
		);
	});
});
