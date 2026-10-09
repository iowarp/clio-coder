import assert from "node:assert/strict";
import { test } from "node:test";
import { taskOverview } from "../client/chat/overview-model.js";
import {
	costText,
	quotaCards,
	sessionSpend,
	usageRows,
	usageSummary,
	usageTotals,
} from "../client/chat/session-usage-model.js";
import type { SessionSnapshot } from "../contracts/sessions.js";
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
	assert.equal(costText(cost(0.42, { unknown: true })), "$0.42 subtotal, some calls unpriced");
	assert.equal(costText(cost(0, { free: true })), "$0.00, every call free");
	assert.equal(costText(cost(0, { calls: 0 })), "Nothing recorded yet");
	assert.equal(costText(cost(0, { unknown: true })), "Cost not measured");
	const turns = [
		{
			status: "succeeded",
			startedAt: null,
			finishedAt: null,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 20,
				cacheWrite: 1,
				reasoning: 2,
				totalTokens: 36,
				missingTokenCalls: 1,
				costUsd: 0.42,
				costProvenance: "unknown",
				costSummary: { knownUsd: 0.42, calls: 3, hasEstimated: true, hasUnknown: true, allKnownFree: false },
			},
		},
	] as unknown as SessionSnapshot["turns"];
	assert.equal(taskOverview(turns, 0).tokens, 36);
	assert.deepEqual(usageSummary(false, turns, undefined, undefined).totals, [
		{ label: "Cost", value: "~$0.42 +?" },
		{ label: "Tokens", value: "36 +? (1 call missing usage)" },
	]);
	assert.deepEqual(sessionSpend(turns, undefined), {
		tokens: 36,
		cost: "~$0.42 +?",
		source: "turns",
		missingTokenCalls: 1,
	});
});

const usage: SessionUsage = {
	version: 1,
	session: {
		cost: cost(0.42, { calls: 7 }),
		tokens: 5200,
		missingTokenCalls: 1,
		rows: [
			{
				provider: "anthropic",
				model: "claude-sonnet-5",
				runs: 2,
				calls: 7,
				missingTokenCalls: 1,
				tokens: { input: 4000, output: 1000, cacheRead: 150, cacheWrite: 50, reasoning: 0, total: 5200 },
				beside: {
					sideQuestions: 1,
					handoffs: 0,
					prewarms: 2,
					backgroundMemory: 0,
					systemOne: 1,
					workers: 1,
					failedCompaction: 1,
				},
				cost: cost(0.42, { calls: 7 }),
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
		{ label: "Tokens", value: "5,200 +? (1 call missing usage)" },
		{ label: "Model calls", value: "7" },
	]);
	assert.deepEqual(usageRows(usage), [
		{
			key: "anthropic/claude-sonnet-5",
			route: "anthropic · claude-sonnet-5",
			tokens: "4,000 in · 1,000 out · 200 cache",
			cost: "$0.42",
			beside:
				"1 side question, 2 pre-warms, 1 System One call, 1 failed compaction call, 1 worker call, 1 call missing token usage",
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

test("parked usage shows recorded totals without exposing live model details or quota", () => {
	const recorded = {
		used: 1,
		size: 10,
		session: {
			input: 1_284_400,
			output: 13,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 1_284_413,
			costUsd: 0.03,
			costProvenance: "estimated" as const,
		},
	};
	const parked = usageSummary(false, [], usage, recorded);
	assert.deepEqual(parked.totals, [
		{ label: "Cost", value: "~$0.03" },
		{ label: "Tokens", value: "1,284,413" },
	]);
	assert.match(parked.note, /^Last recorded totals\./);
	assert.equal(parked.details, false);
	assert.deepEqual(usageSummary(false, [], undefined, recorded), parked);
	assert.deepEqual(usageSummary(false, [], usage, undefined).totals, usageTotals(usage));
	assert.equal(usageSummary(true, [], usage, recorded).details, true);
	assert.match(usageSummary(true, [], usage, recorded).note, /^Live totals\./);
	const absent = usageSummary(false, [], undefined, undefined);
	assert.deepEqual(absent.totals, []);
	assert.match(absent.note, /^No usage totals were recorded\./);
});
