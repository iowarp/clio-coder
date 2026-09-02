import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";

function before(turnId: string, toolName: string, fingerprint: string): MiddlewareHookInput {
	return {
		hook: "before_tool",
		turnId,
		toolName,
		toolArgs: { q: fingerprint },
		metadata: { callFingerprint: fingerprint },
	};
}

function afterOk(turnId: string, toolName: string): MiddlewareHookInput {
	return { hook: "after_tool", turnId, toolName, toolArgs: {}, metadata: { resultKind: "ok" }, toolResultDetails: {} };
}

describe("loop guard identical-call epoch", () => {
	it("blocks the third verbatim repeat when nothing changed in between", () => {
		const guard = createLoopGuardRegistration({ safety: createWorkerSafety() });
		const turn = "t1";
		strictEqual(guard.evaluate(before(turn, ToolNames.Bash, "fp-grep")).length, 0);
		strictEqual(guard.evaluate(before(turn, ToolNames.Bash, "fp-grep")).length, 0);
		const third = guard.evaluate(before(turn, ToolNames.Bash, "fp-grep"));
		ok(
			third.some((effect) => effect.kind === "block_tool"),
			JSON.stringify(third),
		);
	});

	it("lets a check rerun after a successful edit: the repeat count restarts at the write", () => {
		const guard = createLoopGuardRegistration({ safety: createWorkerSafety() });
		const turn = "t2";
		strictEqual(guard.evaluate(before(turn, ToolNames.Bash, "fp-test")).length, 0);
		strictEqual(guard.evaluate(before(turn, ToolNames.Bash, "fp-test")).length, 0);
		guard.evaluate(afterOk(turn, ToolNames.Edit));
		strictEqual(guard.evaluate(before(turn, ToolNames.Bash, "fp-test")).length, 0);
		strictEqual(guard.evaluate(before(turn, ToolNames.Bash, "fp-test")).length, 0);
		const third = guard.evaluate(before(turn, ToolNames.Bash, "fp-test"));
		ok(
			third.some((effect) => effect.kind === "block_tool"),
			JSON.stringify(third),
		);
	});
});
