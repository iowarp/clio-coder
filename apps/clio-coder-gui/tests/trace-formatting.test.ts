import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTime, formatTokens, serverClock } from "../client/api/clock.js";
import { renderTraceCost } from "../server/clio/http-shims.js";

test("trace formatting keeps missing spend distinct from zero and adopts server clock once", () => {
	for (const [row, expected] of [
		[{ total_cost_usd: null }, "not measured"],
		[{ total_cost_usd: 0 }, "not measured"],
		[{ total_cost_usd: 0, cost_unknown: 0, api_calls: 0 }, "not measured"],
		[{ total_cost_usd: 0, cost_unknown: 0, api_calls: 1 }, "$0.00"],
		[{ total_cost_usd: 0.0024, cost_unknown: 0, api_calls: 1 }, "$0.0024"],
		[{ total_cost_usd: 0.25, cost_estimated: 1, cost_unknown: 1, api_calls: 2 }, "~$0.25 +?"],
		[{ total_cost_usd: 0, cost_unknown: 1, api_calls: 1 }, "not measured"],
	] as const)
		assert.equal(renderTraceCost(row), expected);
	assert.equal(formatTokens(24, 1), "24 +? (1 call missing usage)");
	assert.equal(formatTokens(null), "not recorded");
	assert.equal(formatTokens(0), "0");
	assert.match(formatTime("2026-09-11T12:00:00Z"), /^2026-09-11 \d{2}:\d{2}:\d{2}$/);
	let now = 10000;
	const clock = serverClock(() => now);
	clock.adopt(null);
	clock.adopt(new Date(20000).toUTCString());
	assert.equal(clock.now(), 20000);
	now += 123;
	clock.adopt(new Date(40000).toUTCString());
	assert.equal(clock.now(), 20123);
});
