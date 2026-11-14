import assert from "node:assert/strict";
import { test } from "node:test";
import { contextView } from "../client/chat/context-model.js";
import { contextWorkView } from "../client/chat/context-work-model.js";
import type { WireContextLedger } from "../contracts/context-ledger.js";
import type { ContextOperation } from "../contracts/context-work.js";
import { withLedgerDisplay } from "../server/services/context-display.js";

const WIRE: WireContextLedger = {
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
const LEDGER = withLedgerDisplay(WIRE);

test("the context view words the agent's accounting and says whether it was measured", () => {
	const view = contextView(LEDGER);
	assert.equal(view.route, "mini · gemma");
	assert.equal(view.window, "131,072 tokens, one of 4 slots sharing 524,288 tokens, read from the loaded model.");
	assert.equal(view.accounting, "20,480 tokens in use (15.6%), anchored to provider-reported usage.");
	assert.deepEqual(view.rows, [{ key: "messages", label: "Conversation", tokens: "16,384", share: "12.5%" }]);
	assert.equal(view.compaction, "Compacts automatically at 80% of the window.");
	assert.equal(view.lastCompaction, "Last compaction (auto): estimated 90,000 tokens to 12,000 tokens.");
	assert.equal(
		view.cache,
		"Session shell reused; 8,000 tokens read from the provider cache; the backend reprocessed the prompt prefix.",
	);
});

test("an unknown window is said, not shown as zero, and estimates say so", () => {
	const view = contextView(
		withLedgerDisplay({
			...WIRE,
			contextWindow: 0,
			percent: null,
			measured: false,
			promptCache: null,
			lastCompaction: null,
		}),
	);
	assert.equal(view.window, "Window size not reported, so no share of it can be shown.");
	assert.equal(view.accounting, "20,480 tokens in use, estimated until the provider reports usage.");
	assert.equal(view.free, "Free space not reported.");
	assert.equal(view.cache, null);
});

test("the window bar's parts come worded from the server, the smallest categories folded into one", () => {
	const groups = [
		{ category: "system", label: "System prompt", tokens: 4096, percent: 3.125 },
		{ category: "messages", label: "Conversation", tokens: 16384, percent: 12.5 },
		{ category: "tools", label: "Tools", tokens: 1310, percent: 1 },
		{ category: "memory", label: "Memory", tokens: 655, percent: 0.5 },
		{ category: "skills", label: "Skills", tokens: 262, percent: 0.2 },
	];
	const { segments } = withLedgerDisplay({ ...WIRE, groups }).display;
	assert.deepEqual(
		segments.map(({ label, share }) => [label, share]),
		[
			["Conversation", "12.5%"],
			["System prompt", "3.1%"],
			["Tools", "1.0%"],
			["Other", "0.7%"],
		],
	);
	assert.equal(segments[3]?.fill, 0.7, "the folded part's width is the folded shares");
	assert.deepEqual(withLedgerDisplay({ ...WIRE, contextWindow: 0, groups }).display.segments, []);
});

test("a folded part holding a category with no reported share reads not reported, not a smaller sum", () => {
	const groups = [
		{ category: "system", label: "System prompt", tokens: 4096, percent: 3.125 },
		{ category: "messages", label: "Conversation", tokens: 16384, percent: 12.5 },
		{ category: "tools", label: "Tools", tokens: 1310, percent: 1 },
		{ category: "memory", label: "Memory", tokens: 655, percent: null },
		{ category: "skills", label: "Skills", tokens: 262, percent: 0.2 },
	];
	const { segments } = withLedgerDisplay({ ...WIRE, groups }).display;
	assert.deepEqual(
		segments.map(({ label, share, fill }) => [label, share, fill]),
		[
			["Conversation", "12.5%", 12.5],
			["System prompt", "3.1%", 3.125],
			["Tools", "1.0%", 1],
			["Other", "not reported", 0],
		],
	);
});

test("a compaction that summarized nothing says so, as the terminal does", () => {
	const compaction = (facts: NonNullable<ContextOperation["facts"]>): ContextOperation => ({
		version: 1,
		id: "op-1",
		kind: "compaction",
		sessionId: null,
		cwd: "/work",
		origin: "automatic",
		reason: "",
		startedAt: "2026-11-14T08:00:00.000Z",
		outcome: "completed",
		facts,
	});
	const evicted = contextWorkView(compaction([{ kind: "removed", unit: "observations", count: 12 }]));
	assert.equal(evicted.label, "Complete · no summary");
	assert.match(evicted.message ?? "", /nothing was summarized/u);
	assert.equal(contextWorkView(compaction([])).label, "Complete · no summary");
	const summarized = contextWorkView(compaction([{ kind: "summarized", unit: "messages", count: 40 }]));
	assert.deepEqual([summarized.label, summarized.message], ["Complete", null]);
});
