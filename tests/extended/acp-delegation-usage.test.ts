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

describe("ACP usage presence and provenance", () => {
	it("distinguishes valid zero counts from absent or malformed usage", () => {
		const usage = emptyUsage();
		for (const raw of [undefined, {}, { totalTokens: -1 }, { totalTokens: Number.NaN }, { input: "0" }]) {
			mergeUsage(usage, raw);
			strictEqual(usage.tokensReported, false);
		}
		mergeUsage(usage, { input_tokens: 0 });
		strictEqual(usage.tokensReported, true);
		strictEqual(usage.totalTokens, 0);
		strictEqual(usage.costProvenance, "unknown");
	});

	it("prefers explicit zero and treats total/cost aliases as alternate representations", () => {
		const usage = emptyUsage();
		mergeUsage(usage, {
			input: 10,
			totalTokens: 0,
			total_tokens: 25,
			cost: { total: 0 },
			costUsd: 1,
			costProvenance: "known",
		});
		strictEqual(usage.totalTokens, 0);
		strictEqual(usage.inputTokens, 10);
		strictEqual(usage.costUsd, 0);
		strictEqual(usage.costProvenance, "known");
	});

	it("retains a numeric amount without inventing pricing provenance", () => {
		const usage = emptyUsage();
		mergeUsage(usage, { costUsd: 0.0123 });
		strictEqual(usage.tokensReported, false);
		strictEqual(usage.costUsd, 0.0123);
		strictEqual(usage.costProvenance, "unknown");
	});

	it("does not treat malformed cost as measured zero", () => {
		for (const cost of [-1, Number.NaN, Number.POSITIVE_INFINITY, "0"]) {
			const usage = emptyUsage();
			mergeUsage(usage, { input: 1, cost: { total: cost }, costProvenance: "known_free" });
			strictEqual(usage.costUsd, 0);
			strictEqual(usage.costProvenance, "unknown");
		}
	});

	it("keeps accumulated provenance conservative across priced and unpriced reports", () => {
		const usage = emptyUsage();
		mergeUsage(usage, { totalTokens: 0, costUsd: 0, costProvenance: "known_free" });
		mergeUsage(usage, { totalTokens: 5, costUsd: 0.01, costProvenance: "known" });
		strictEqual(usage.costProvenance, "known");
		mergeUsage(usage, { totalTokens: 3, costUsd: 0.02, costProvenance: "estimated" });
		strictEqual(usage.costProvenance, "estimated");
		mergeUsage(usage, { totalTokens: 2 });
		strictEqual(usage.costProvenance, "unknown");
		strictEqual(usage.totalTokens, 10);
		strictEqual(usage.costUsd, 0.03);
	});
});
