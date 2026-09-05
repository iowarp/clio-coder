import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { emptyUsage, mergeUsage } from "../../src/engine/acp/adapter.js";

describe("ACP delegation usage accumulator carries cost and a combined total", () => {
	it("starts totalTokens and costUsd at zero beside the token counters", () => {
		const usage = emptyUsage();
		strictEqual(usage.totalTokens, 0);
		strictEqual(usage.costUsd, 0);
	});

	it("takes an explicit total and cost from the peer when present", () => {
		const usage = emptyUsage();
		mergeUsage(usage, { input: 10, output: 5, cacheRead: 1, cacheWrite: 1, totalTokens: 100, cost: { total: 0.0123 } });
		strictEqual(usage.totalTokens, 100);
		strictEqual(usage.costUsd, 0.0123);
	});

	it("derives totalTokens from input+output+cacheRead+cacheWrite and leaves costUsd at 0 when the peer sends only token counts", () => {
		const usage = emptyUsage();
		mergeUsage(usage, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 40 });
		strictEqual(usage.inputTokens, 10);
		strictEqual(usage.outputTokens, 5);
		strictEqual(usage.cacheReadTokens, 2);
		strictEqual(usage.cacheWriteTokens, 1);
		strictEqual(usage.reasoningTokens, 40);
		strictEqual(usage.totalTokens, 18);
		strictEqual(usage.costUsd, 0);
	});

	it("accumulates explicit and derived totals across merges like every other field", () => {
		const usage = emptyUsage();
		mergeUsage(usage, { input: 10, output: 5, total_tokens: 15, cost: { total: 0.01 } });
		mergeUsage(usage, { input: 3, output: 2 });
		strictEqual(usage.totalTokens, 20);
		strictEqual(usage.costUsd, 0.01);
	});

	it("treats a missing or malformed cost object as zero rather than throwing", () => {
		const usage = emptyUsage();
		mergeUsage(usage, { input: 1, output: 1, cost: "not-an-object" });
		mergeUsage(usage, { input: 1, output: 1, cost: { total: "not-a-number" } });
		mergeUsage(usage, "not-a-record");
		strictEqual(usage.costUsd, 0);
		strictEqual(usage.totalTokens, 4);
	});
});
