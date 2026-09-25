import { deepStrictEqual, ok } from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import { bucketActivity, renderActivityHeatmap } from "../../src/interactive/activity-view.js";

test("workspace activity rejects invalid instants and fits every supported width", () => {
	const now = new Date(2026, 8, 25, 12).getTime();
	const at = new Date(now).toISOString();
	const days = bucketActivity([{ at, weight: 5 }, { at, weight: 2 }, { at: "invalid", weight: 10 }], now);
	deepStrictEqual([...days.values()], [7]);
	for (const width of [40, 60, 80, 120, 200]) {
		for (const line of renderActivityHeatmap(days, now, width, "last 182 days")) ok(visibleWidth(line) <= width);
	}
});
