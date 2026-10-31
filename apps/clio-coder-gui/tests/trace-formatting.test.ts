import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTime, serverClock } from "../client/api/clock.js";
import { countText, explanationView } from "../client/telemetry/quantity-model.js";
import type { ExplanationV1 } from "../contracts/wire.js";

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

test("an explanation reads in the server's words and lists only the contributors it named", () => {
	const explanation = {
		value: { display: "≥24 (1 call unknown)" },
		coverage: "1 measured, 1 unknown",
		rule: "sum(call.usage.total) over attempts where disposition≠never_sent",
		from: { callIds: ["call-1"], attemptIds: [], runIds: ["run-0"], recordIds: [], omitted: 2 },
	} as unknown as ExplanationV1;
	assert.deepEqual(explanationView(explanation), {
		value: "≥24 (1 call unknown)",
		coverage: "1 measured, 1 unknown",
		rule: "sum(call.usage.total) over attempts where disposition≠never_sent",
		sources: [
			{ label: "Calls", ids: ["call-1"] },
			{ label: "Runs", ids: ["run-0"] },
		],
		omitted: "2 more contributors are not listed.",
	});
});
