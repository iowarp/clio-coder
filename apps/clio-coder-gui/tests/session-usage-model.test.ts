import assert from "node:assert/strict";
import { test } from "node:test";
import { taskOverview } from "../client/chat/overview-model.js";
import {
	costText,
	hasJournalFacts,
	quotaCards,
	sessionSpend,
	usageRows,
	usageSummary,
	usageTotals,
} from "../client/chat/session-usage-model.js";
import type { SessionSnapshot } from "../contracts/sessions.js";
import type { SessionUsage } from "../contracts/usage.js";
import { renderCostAggregate } from "../server/clio/http-shims.js";

const cost = (knownUsd: number, extra: Partial<SessionUsage["session"]["cost"]> = {}) => {
	const value = { knownUsd, calls: 2, estimated: false, unknown: false, free: false, ...extra };
	return {
		...value,
		display: renderCostAggregate({
			knownUsd,
			calls: value.calls,
			hasEstimated: value.estimated,
			hasUnknown: value.unknown,
			allKnownFree: value.free,
		}),
	};
};

test("cost is worded as measured, estimated, partly unpriced, free or not yet recorded", () => {
	assert.equal(costText(cost(0.4213)), "$0.42");
	assert.equal(costText(cost(0.0042)), "$0.0042");
	assert.equal(costText(cost(0.42, { estimated: true })), "~$0.42 est");
	assert.equal(costText(cost(0.42, { unknown: true })), "$0.42 +?");
	assert.equal(costText(cost(0, { free: true })), "$0.00 local");
	assert.equal(costText(cost(0, { calls: 0 })), "not measured");
	assert.equal(costText(cost(0, { unknown: true })), "not measured");
});

test("the turn overview counts turns and wall time and sums no tokens or cost (#434)", () => {
	const turns = [
		{ status: "succeeded", startedAt: "2026-10-30T10:00:00.000Z", finishedAt: "2026-10-30T10:00:30.000Z", usage: null },
		{ status: "running", startedAt: "2026-10-30T10:01:00.000Z", finishedAt: null, usage: null },
	] as unknown as SessionSnapshot["turns"];
	assert.deepEqual(taskOverview(turns, Date.parse("2026-10-30T10:01:10.000Z")), {
		turns: 2,
		elapsedMs: 40_000,
		running: true,
	});
	// With neither a usage read nor telemetry, a session shows no spend: nothing outside the read model folds one.
	assert.deepEqual(sessionSpend({}), {
		tokens: null,
		cost: null,
		calls: null,
		source: "none",
		refs: { tokens: null, cost: null, calls: null },
	});
	assert.deepEqual(usageSummary(false, undefined, undefined).totals, []);
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

test("legacy v1 totals and rows read the agent's counts without a sum or a suffix the client invents", () => {
	assert.deepEqual(usageTotals(usage), [
		{ label: "Cost", value: "$0.42", ref: null },
		{ label: "Tokens", value: "5,200", ref: null },
		{ label: "Model calls", value: "7", ref: null },
		{ label: "Calls missing usage", value: "1", ref: null },
	]);
	assert.deepEqual(usageRows(usage), [
		{
			key: "anthropic/claude-sonnet-5",
			route: "anthropic · claude-sonnet-5",
			tokens: "4,000 in · 1,000 out · 150 cache read · 50 cache write",
			cost: "$0.42",
			calls: "7",
			beside:
				"1 side question, 2 pre-warms, 1 System One call, 1 failed compaction call, 1 worker call, 1 call missing token usage",
			refs: { tokens: null, cost: null },
		},
	]);
});

/** The read-model DTOs as the usage read carries them; only the fields the model reads are spelled out. */
const telemetry = {
	session: {
		totals: {
			tokens: { display: "≥5,120 (1 call unknown)", ref: "session:s1#total" },
			usd: { display: "$0.42 +?", ref: "session:s1#usd" },
		},
		own: {
			counts: {
				attempts: {
					fact: {
						measured: 7,
						estimated: 0,
						unknownCount: 0,
						absentCount: 0,
						coverage: { measured: 1, estimated: 0, unknown: 0 },
					},
				},
				calls: { display: "7" },
			},
		},
	},
	cost: {
		groups: [
			{
				key: "claude-sonnet-5",
				calls: { display: "7" },
				tokens: { display: "≥5,120 (1 call unknown)" },
				usd: { display: "$0.42 +?" },
			},
		],
	},
} as unknown as NonNullable<SessionUsage["telemetry"]>;

test("the read model's displays win over the v1 counts wherever the usage read carries them (#434)", () => {
	const withTelemetry = { ...usage, telemetry };
	assert.deepEqual(sessionSpend({ usage: withTelemetry }), {
		tokens: "≥5,120 (1 call unknown)",
		cost: "$0.42 +?",
		calls: "7",
		source: "telemetry",
		refs: { tokens: "session:s1#total", cost: "session:s1#usd", calls: null },
	});
	assert.deepEqual(usageTotals(withTelemetry), [
		{ label: "Cost", value: "$0.42 +?", ref: "session:s1#usd" },
		{ label: "Tokens", value: "≥5,120 (1 call unknown)", ref: "session:s1#total" },
		{ label: "Model calls", value: "7", ref: null },
	]);
	assert.deepEqual(usageRows(withTelemetry), [
		{
			key: "claude-sonnet-5",
			route: "claude-sonnet-5",
			tokens: "Tokens: ≥5,120 (1 call unknown)",
			cost: "$0.42 +?",
			calls: "7",
			beside: null,
			refs: { tokens: null, cost: null },
		},
	]);
	// A closed task has no usage read; its cold session fold takes the same place.
	assert.equal(sessionSpend({ cold: telemetry.session }).source, "telemetry");
	// A session the host knows but never journaled answers unknown coverage (R9): the legacy counts stand.
	const unjournaled = {
		...telemetry.session,
		own: {
			counts: {
				attempts: {
					fact: {
						measured: 0,
						estimated: 0,
						unknownCount: 1,
						absentCount: 0,
						coverage: { measured: 0, estimated: 0, unknown: 1 },
					},
				},
				calls: { display: "unknown (1 call unknown)" },
			},
		},
	} as unknown as NonNullable<SessionUsage["telemetry"]>["session"];
	assert.equal(hasJournalFacts(unjournaled), false);
	assert.equal(sessionSpend({ usage, cold: unjournaled }).source, "legacy");
	assert.equal(
		sessionSpend({ usage: { ...usage, telemetry: { ...telemetry, session: unjournaled } } }).source,
		"legacy",
	);
	assert.deepEqual(sessionSpend({ cold: unjournaled }), {
		tokens: null,
		cost: null,
		calls: null,
		source: "none",
		refs: { tokens: null, cost: null, calls: null },
	});
	const summary = usageSummary(true, withTelemetry, undefined);
	assert.equal(summary.source, "telemetry");
	assert.match(summary.note, /read model/);
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
			costDisplay: "~$0.03 est",
			costProvenance: "estimated" as const,
		},
	};
	const parked = usageSummary(false, usage, recorded);
	assert.deepEqual(parked.totals, [
		{ label: "Cost", value: "~$0.03 est", ref: null },
		{ label: "Tokens", value: "1,284,413", ref: null },
	]);
	assert.match(parked.note, /^Last recorded totals\./);
	assert.equal(parked.details, false);
	assert.deepEqual(usageSummary(false, undefined, recorded), parked);
	assert.deepEqual(usageSummary(false, usage, undefined).totals, usageTotals(usage));
	assert.equal(usageSummary(true, usage, recorded).details, true);
	assert.match(usageSummary(true, usage, recorded).note, /^Live totals\./);
	const absent = usageSummary(false, undefined, undefined);
	assert.deepEqual(absent.totals, []);
	assert.match(absent.note, /^No usage totals were recorded\./);
});
