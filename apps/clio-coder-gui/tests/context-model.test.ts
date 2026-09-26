import assert from "node:assert/strict";
import { test } from "node:test";
import { contextView } from "../client/chat/context-model.js";
import type { ContextLedger } from "../contracts/context-ledger.js";

const LEDGER: ContextLedger = {
	version: 1,
	provider: "mini",
	model: "gemma",
	contextWindow: 131072,
	contextWindowSource: "loaded",
	contextWindowSlots: { slots: 4, totalTokens: 524288 },
	usedTokens: 20480,
	reserveTokens: 16384,
	freeTokens: 94208,
	percent: 15.625,
	measured: true,
	compactionThreshold: 0.8,
	compactionAuto: true,
	projectPreload: null,
	projectHandbookFiles: ["CLIO-CODER.md"],
	toolCount: 14,
	groups: [{ category: "messages", label: "Conversation", tokens: 16384, percent: 12.5 }],
	lastCompaction: { stage: "summary", tokensBefore: 90000, tokensAfter: 12000, trigger: "auto" },
	promptCache: {
		shellReused: true,
		cacheReadTokens: 8000,
		cacheWriteTokens: null,
		uncachedInputTokens: 400,
		backendVerdict: "cold",
	},
};

test("the context view words the agent's accounting and says whether it was measured", () => {
	const view = contextView(LEDGER);
	assert.equal(view.route, "mini · gemma");
	assert.equal(view.window, "131,072 tokens, one of 4 slots sharing 524,288 tokens, read from the loaded model.");
	assert.equal(view.accounting, "20,480 tokens in use (16%), measured by the provider.");
	assert.deepEqual(view.rows, [{ key: "messages", label: "Conversation", tokens: "16,384", share: "13%" }]);
	assert.equal(view.compaction, "Compacts automatically at 80% of the window.");
	assert.equal(view.lastCompaction, "Last compaction (auto): 90,000 tokens to 12,000 tokens.");
	assert.equal(
		view.cache,
		"Session shell reused; 8,000 tokens read from the provider cache; the backend reprocessed the prompt prefix.",
	);
});

test("an unknown window is said, not shown as zero, and estimates say so", () => {
	const view = contextView({
		...LEDGER,
		contextWindow: 0,
		percent: null,
		measured: false,
		promptCache: null,
		lastCompaction: null,
	});
	assert.equal(view.window, "Window size not reported, so no share of it can be shown.");
	assert.equal(view.accounting, "20,480 tokens in use, estimated until the provider reports usage.");
	assert.equal(view.free, "Free space not reported.");
	assert.equal(view.cache, null);
});
