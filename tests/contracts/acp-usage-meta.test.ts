import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { emptyUsage, mergeUsage } from "../../src/engine/acp/server.js";

describe("ACP server usage accumulator carries cost and a combined total", () => {
	it("starts every field at zero, including the two the TUI and json-stream carry", () => {
		const usage = emptyUsage();
		strictEqual(usage.totalTokens, 0);
		strictEqual(usage.costUsd, 0);
	});

	it("sums costUsd from the same usage.cost.total field sumRunUsage reads, never re-deriving it", () => {
		const usage = emptyUsage();
		mergeUsage(usage, { input: 10, output: 5, cost: { total: 0.0123 } });
		mergeUsage(usage, { input: 2, output: 1, cost: { total: 0.0007 } });
		strictEqual(usage.costUsd, 0.013);
	});

	it("prefers an explicit totalTokens over the derived sum", () => {
		const usage = emptyUsage();
		mergeUsage(usage, { input: 10, output: 5, cacheRead: 1, cacheWrite: 1, totalTokens: 100 });
		strictEqual(usage.totalTokens, 100);
	});

	it("falls back to input+output+cacheRead+cacheWrite when no total is reported, excluding reasoning like sumRunUsage does", () => {
		const usage = emptyUsage();
		mergeUsage(usage, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 40 });
		strictEqual(usage.totalTokens, 18);
	});

	it("accumulates totalTokens and costUsd across message_end and agent_end merges like every other field", () => {
		const usage = emptyUsage();
		mergeUsage(usage, { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } });
		mergeUsage(usage, { input: 3, output: 2, totalTokens: 5, cost: { total: 0.002 } });
		strictEqual(usage.totalTokens, 20);
		strictEqual(usage.costUsd, 0.012);
	});

	it("treats a missing or malformed cost object as zero rather than throwing", () => {
		const usage = emptyUsage();
		mergeUsage(usage, { input: 1, output: 1 });
		mergeUsage(usage, { input: 1, output: 1, cost: "not-an-object" });
		mergeUsage(usage, { input: 1, output: 1, cost: { total: "not-a-number" } });
		strictEqual(usage.costUsd, 0);
	});
});
