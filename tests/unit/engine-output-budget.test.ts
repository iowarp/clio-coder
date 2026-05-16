import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { remainingContextMaxTokens } from "../../src/engine/apis/output-budget.js";

const emptyContext: Context = {
	systemPrompt: "",
	messages: [],
	tools: [],
} as unknown as Context;

describe("engine/apis/output-budget remainingContextMaxTokens", () => {
	it("returns a finite default when model limits are unknown", () => {
		const maxTokens = remainingContextMaxTokens({ contextWindow: 0, maxTokens: 0 }, emptyContext, undefined);

		strictEqual(maxTokens, 4096);
	});

	it("honors an explicit finite request when model limits are unknown", () => {
		const maxTokens = remainingContextMaxTokens({ contextWindow: 0, maxTokens: 0 }, emptyContext, { maxTokens: 1234 });

		strictEqual(maxTokens, 1234);
	});

	it("still clamps to the remaining context budget when the window is known", () => {
		const maxTokens = remainingContextMaxTokens({ contextWindow: 2048, maxTokens: 0 }, emptyContext, {
			maxTokens: 9999,
		});

		strictEqual(maxTokens, 1024);
	});
});
