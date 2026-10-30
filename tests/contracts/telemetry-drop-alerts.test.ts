import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { HealthV1 } from "../../src/core/telemetry/dto.js";
import { renderFact } from "../../src/core/telemetry/render.js";
import { createDropAlerts, DROP_ALERT_WINDOW_MS } from "../../src/interactive/telemetry-drops.js";

const count = (value: number) => {
	const fact = { kind: "measured", value, source: "local-count" } as const;
	return { fact, display: renderFact(fact) };
};
const health = (journals: Record<string, { dropped?: number; invalid?: number; writeErrors?: number }>): HealthV1 => ({
	v: 1,
	foldVersion: 1,
	generatedAt: "2026-10-30T00:00:00.000Z",
	kind: "health",
	journals: Object.entries(journals).map(([owner, losses]) => ({
		owner,
		queueDepth: count(0),
		persisted: count(10),
		dropped: count(losses.dropped ?? 0),
		invalid: count(losses.invalid ?? 0),
		filtered: count(0),
		writeErrors: count(losses.writeErrors ?? 0),
	})),
	producer: { unownedRecords: count(0), sinkFailures: count(0) },
	loopLag: { p50: count(0), p99: count(0), max: count(0) },
});

test("a drop alert fires once per owner per window, and a rise the window held is reported when it ends (#434 §14)", () => {
	const alerts = createDropAlerts();
	const start = 1_000_000;
	strictEqual(alerts.observe(health({ "session:s1": {} }), start).length, 0, "no loss, no alert");
	const first = alerts.observe(health({ "session:s1": { dropped: 2 } }), start + 1);
	deepStrictEqual(
		first.map((alert) => alert.key),
		["telemetry-drop:session:s1"],
	);
	match(first[0]?.text ?? "", /2 records dropped/);
	// Inside the window: neither a further rise nor another owner's earlier alert repeats this owner's notice.
	strictEqual(alerts.observe(health({ "session:s1": { dropped: 5, invalid: 1 } }), start + 10_000).length, 0);
	const other = alerts.observe(
		health({ "session:s1": { dropped: 5, invalid: 1 }, "run:r1": { writeErrors: 1 } }),
		start + 20_000,
	);
	deepStrictEqual(
		other.map((alert) => alert.owner),
		["run:r1"],
	);
	strictEqual(alerts.nextCheckAt(), start + 1 + DROP_ALERT_WINDOW_MS, "the held rise is due when its window ends");
	const due = alerts.observe(
		health({ "session:s1": { dropped: 5, invalid: 1 }, "run:r1": { writeErrors: 1 } }),
		start + 1 + DROP_ALERT_WINDOW_MS,
	);
	deepStrictEqual(
		due.map((alert) => alert.owner),
		["session:s1"],
	);
	match(due[0]?.text ?? "", /3 records dropped, 1 invalid/, "the alert counts the rise since the last one");
	strictEqual(alerts.nextCheckAt(), null);
	strictEqual(
		alerts.observe(health({ "session:s1": { dropped: 5, invalid: 1 } }), start + 3 * DROP_ALERT_WINDOW_MS).length,
		0,
		"no new loss, no alert",
	);
});
