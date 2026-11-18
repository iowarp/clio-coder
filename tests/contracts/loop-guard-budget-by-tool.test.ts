import { ok } from "node:assert/strict";
import { test } from "node:test";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { createLoopState, hashToolCall, observe } from "../../src/domains/safety/loop-detector.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";

test("the soft tool budget refusal names where the turn's calls went", () => {
	let loopState = createLoopState();
	const safety = {
		observeLoop(key: string, now: number) {
			const [next, verdict] = observe(loopState, key, now);
			loopState = next;
			return verdict;
		},
	} as unknown as Parameters<typeof createLoopGuardRegistration>[0]["safety"];
	const guard = createLoopGuardRegistration({ safety, turnToolCallBudget: () => ({ soft: 3, hard: 18 }) });
	const calls: Array<[string, Record<string, unknown>]> = [
		["read", { path: "a.md" }],
		["read", { path: "b.md" }],
		["gateway", { op: "call", capability: "extension_desk__next_step", args: {} }],
		["gateway", { op: "call", capability: "extension_desk__record", args: { uri: "project://x" } }],
	];
	let reason = "";
	for (const [toolName, toolArgs] of calls) {
		const effects = guard.evaluate({
			hook: "before_tool",
			turnId: "turn-1",
			toolName,
			toolArgs,
			metadata: { callFingerprint: hashToolCall(toolName, toolArgs) },
		} as MiddlewareHookInput);
		const block = effects.find((effect) => effect.kind === "block_tool");
		if (block?.kind === "block_tool") reason = block.reason;
	}
	ok(reason.includes("soft budget 3"), reason);
	ok(
		reason.includes("This turn's calls by tool: read 2, extension_desk__next_step 1, extension_desk__record 1."),
		reason,
	);
});
