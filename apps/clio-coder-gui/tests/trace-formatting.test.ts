import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTime, formatTokens, serverClock } from "../client/api/clock.js";

test("trace formatting keeps missing counts distinct from zero and adopts server clock once", () => {
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
