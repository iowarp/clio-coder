import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTime, serverClock } from "../client/api/clock.js";
import { countText } from "../client/telemetry/quantity-model.js";

test("trace formatting keeps missing counts distinct from zero and adopts server clock once", () => {
	assert.equal(countText(null), "not recorded");
	assert.equal(countText(0), "0");
	assert.equal(countText(1234567), "1,234,567");
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
