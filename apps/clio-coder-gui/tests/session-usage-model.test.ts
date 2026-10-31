import assert from "node:assert/strict";
import { test } from "node:test";
import { taskOverview } from "../client/chat/overview-model.js";
import { sessionSpend, usageRows, usageSummary, usageTotals } from "../client/chat/session-usage-model.js";
import type { SessionSnapshot } from "../contracts/sessions.js";
import type { SessionUsage } from "../contracts/usage.js";

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

test("the usage view renders the read model displays (#434)", () => {
	const withTelemetry = { telemetry, telemetryQuota: { providers: [] } } as unknown as SessionUsage;
	assert.deepEqual(sessionSpend({ usage: withTelemetry }), {
		tokens: "≥5,120 (1 call unknown)",
		cost: "$0.42 +?",
		calls: "7",
		source: "telemetry",
		refs: { tokens: "session:s1#total", cost: "session:s1#usd", calls: null },
	});
	assert.deepEqual(usageTotals(withTelemetry), [
		{ label: "Cost", value: "$0.42 +?", factRef: "session:s1#usd" },
		{ label: "Tokens", value: "≥5,120 (1 call unknown)", factRef: "session:s1#total" },
		{ label: "Model calls", value: "7", factRef: null },
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
	const summary = usageSummary(true, withTelemetry, undefined);
	assert.equal(summary.source, "telemetry");
	assert.match(summary.note, /read model/);
});
