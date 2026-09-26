import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration } from "../client/api/clock.js";

// A countdown read "stops in 9m 60s": minutes were floored and seconds rounded on their own.
test("a duration never shows sixty seconds; it carries into the next unit", () => {
	assert.equal(formatDuration(599_600), "10m 0s");
	assert.equal(formatDuration(59_960), "1m 0s");
	assert.equal(formatDuration(119_499), "1m 59s");
	assert.equal(formatDuration(9_960), "10s");
});

test("durations keep their existing precision elsewhere", () => {
	assert.equal(formatDuration(0), "0ms");
	assert.equal(formatDuration(999.4), "999ms");
	assert.equal(formatDuration(1_234), "1.2s");
	assert.equal(formatDuration(12_345), "12s");
	assert.equal(formatDuration(61_000), "1m 1s");
	assert.equal(formatDuration(Number.NaN), "0ms");
});
