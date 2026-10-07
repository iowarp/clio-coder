import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCost, formatTime, formatTokens, serverClock } from "../client/api/clock.js";

test("trace formatting keeps missing spend distinct from zero and adopts server clock once", () => {
	assert.equal(formatCost(null), "not recorded");
	assert.equal(formatCost(undefined), "not recorded");
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatCost(0.0024), "$0.0024");
	assert.equal(formatCost(0.25, { cost_estimated: 1, cost_unknown: 1 }), "about $0.25 subtotal, some calls unpriced");
	assert.equal(formatCost(0.25, { cost_estimated: 0, cost_unknown: 0 }), "$0.25");
	assert.equal(formatCost(0.25, {}), "$0.25 (pricing unknown)");
	assert.equal(formatCost(0, { cost_unknown: 1 }), "Cost not measured");
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
