import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { thinkingOptionsForInput } from "../../src/engine/claude/sdk-runtime.js";
import type { WorkerRunInput } from "../../src/engine/worker-runtime.js";

const options = (wireModelId: string, thinkingLevel: string) =>
	thinkingOptionsForInput({
		target: { id: "claude", runtime: "claude-sdk" },
		wireModelId,
		thinkingLevel,
	} as WorkerRunInput);

test("the Claude SDK runtime sends each model the thinking form the catalog says it takes", () => {
	const adaptive = { type: "adaptive", display: "summarized" };
	for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]) {
		// These models cannot turn thinking off, so off runs at the lowest effort, as the native path sends it.
		deepStrictEqual(options(model, "off"), { thinking: adaptive, effort: "low" }, model);
		deepStrictEqual(options(model, "high"), { thinking: adaptive, effort: "high" }, model);
	}
	deepStrictEqual(options("claude-haiku-5-5", "off"), { thinking: { type: "disabled" } });
	deepStrictEqual(options("claude-haiku-5-5", "medium"), { thinking: adaptive, effort: "medium" });
	// A budget model gets its token budget and no effort level.
	deepStrictEqual(options("claude-sonnet-4-5", "medium"), {
		thinking: { type: "enabled", budgetTokens: 8192, display: "summarized" },
	});
});
