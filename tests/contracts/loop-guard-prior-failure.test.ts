import { match } from "node:assert/strict";
import { test } from "node:test";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { createLoopState, hashToolCall, observe } from "../../src/domains/safety/loop-detector.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";

test("a blocked repeat of a failed call restates why the call failed", () => {
	let loopState = createLoopState();
	const safety = {
		observeLoop(key: string, now: number) {
			const [next, verdict] = observe(loopState, key, now);
			loopState = next;
			return verdict;
		},
	} as unknown as Parameters<typeof createLoopGuardRegistration>[0]["safety"];
	const guard = createLoopGuardRegistration({ safety, turnBlockBudget: 1, turnSynthesisLockout: true });
	const args = { op: "call", capability: "extension_desk__record", args: { uri: "project://state" } };
	const base = { turnId: "turn-1", toolName: "gateway", toolArgs: args };
	const reasons: string[] = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		const block = guard
			.evaluate({
				...base,
				hook: "before_tool",
				metadata: { callFingerprint: hashToolCall("gateway", args) },
			} as MiddlewareHookInput)
			.find((effect) => effect.kind === "block_tool");
		if (block?.kind === "block_tool") {
			reasons.push(block.reason);
			continue;
		}
		guard.evaluate({
			...base,
			hook: "after_tool",
			metadata: {
				resultKind: "error",
				errorMessage: "Not written: project://state already exists; pass expect_revision.\nDetails follow.",
			},
		} as MiddlewareHookInput);
	}
	match(reasons[0] ?? "", /disabled for the rest of this turn/u);
	match(
		reasons[0] ?? "",
		/\nThe identical call failed earlier with: Not written: project:\/\/state already exists; pass expect_revision\. Fix/u,
	);
});
