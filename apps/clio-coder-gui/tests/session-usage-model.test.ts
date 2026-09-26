import assert from "node:assert/strict";
import { test } from "node:test";
import { costText, quotaCards, usageRows, usageTotals } from "../client/chat/session-usage-model.js";
import type { SessionUsage } from "../contracts/usage.js";

const cost = (knownUsd: number, extra: Partial<SessionUsage["session"]["cost"]> = {}) => ({
	knownUsd,
	calls: 2,
	estimated: false,
	unknown: false,
	free: false,
	...extra,
});

test("cost is worded as measured, estimated, partly unpriced, free or not yet recorded", () => {
	assert.equal(costText(cost(0.4213)), "$0.42");
	assert.equal(costText(cost(0.0042)), "$0.0042");
	assert.equal(costText(cost(0.42, { estimated: true })), "about $0.42");
	assert.equal(costText(cost(0.42, { unknown: true })), "$0.42 known, some calls unpriced");
	assert.equal(costText(cost(0, { free: true })), "$0.00, every call free");
	assert.equal(costText(cost(0, { calls: 0 })), "Nothing recorded yet");
});

const usage: SessionUsage = {
	version: 1,
	session: {
		cost: cost(0.42, { calls: 3 }),
		tokens: 5200,
		rows: [
			{
				provider: "anthropic",
				model: "claude-sonnet-5",
				runs: 2,
				calls: 3,
				tokens: { input: 4000, output: 1000, cacheRead: 150, cacheWrite: 50, reasoning: 0, total: 5200 },
				beside: { sideQuestions: 1, handoffs: 0, prewarms: 2, backgroundMemory: 0 },
				cost: cost(0.42, { calls: 3 }),
			},
		],
		truncated: false,
	},
	quota: {
		status: "read",
		providers: [
			{
				provider: "anthropic-max",
				name: "Claude Max",
				status: "ok",
				plan: "Max 5X",
				message: null,
				credits: null,
				stale: true,
				fetchedAt: "2026-09-26T10:00:00.000Z",
				retryAfterSeconds: null,
				windows: [{ label: "5h", usedPct: 71.4, resetsAt: "2026-09-26T13:00:00.000Z", scope: null, active: true }],
			},
			{
				provider: "codex",
				name: "Codex",
				status: "no_credentials",
				plan: null,
				message: null,
				credits: null,
				stale: false,
				fetchedAt: null,
				retryAfterSeconds: null,
				windows: [],
			},
		],
	},
};

test("session totals and rows read the agent's own accounting, with calls beside the conversation named", () => {
	assert.deepEqual(usageTotals(usage), [
		{ label: "Cost", value: "$0.42" },
		{ label: "Tokens", value: "5,200" },
		{ label: "Model calls", value: "3" },
	]);
	assert.deepEqual(usageRows(usage), [
		{
			key: "anthropic/claude-sonnet-5",
			route: "anthropic · claude-sonnet-5",
			tokens: "4,000 in · 1,000 out · 200 cache",
			cost: "$0.42",
			beside: "1 side question, 2 pre-warms",
		},
	]);
});

test("quota cards say what each provider reported, and a stale reading says so", () => {
	const cards = quotaCards(usage);
	assert.deepEqual(cards.status, "read");
	assert.deepEqual(
		cards.status === "read" ? cards.cards.map((card) => [card.name, card.word, card.tone, card.note]) : [],
		[
			["Claude Max", "Read", "success", "Max 5X · last good reading, not refreshed"],
			["Codex", "Not signed in", "neutral", null],
		],
	);
	assert.deepEqual(cards.status === "read" ? cards.cards[0]?.windows : [], [
		{ label: "5h", used: "71%", share: 71.4, resetsAt: "2026-09-26T13:00:00.000Z", binding: true },
	]);
	assert.deepEqual(quotaCards({ ...usage, quota: { status: "failed", reason: "quota cache locked" } }), {
		status: "failed",
		reason: "Quota could not be read: quota cache locked",
	});
});
