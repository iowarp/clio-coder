import { deepStrictEqual, doesNotMatch, match, ok } from "node:assert/strict";
import { test } from "node:test";
import type { CostAggregate, ObservabilityContract } from "../../src/domains/observability/index.js";
import type { TUI } from "../../src/engine/tui.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { bucketActivity, renderActivityHeatmap } from "../../src/interactive/activity-view.js";
import { dockTop } from "../../src/interactive/dock.js";
import { openUsageOverlay } from "../../src/interactive/usage-overlay.js";

test("workspace activity rejects invalid instants and fits every supported width", () => {
	const now = new Date(2026, 8, 25, 12).getTime();
	const at = new Date(now).toISOString();
	const days = bucketActivity(
		[
			{ at, weight: 5 },
			{ at, weight: 2 },
			{ at: "invalid", weight: 10 },
		],
		now,
	);
	deepStrictEqual([...days.values()], [7]);
	for (const width of [40, 60, 80, 120, 200]) {
		for (const line of renderActivityHeatmap(days, now, width, "last 182 days")) ok(visibleWidth(line) <= width);
	}
});

test("usage Activity preserves unpriced, estimated and measured session cost", () => {
	const cases: Array<{ cost: CostAggregate; expected: RegExp; unpriced?: boolean }> = [
		{
			cost: { knownUsd: 0, hasEstimated: false, hasUnknown: false, allKnownFree: false, calls: 0 },
			expected: /Session\s+0 tokens/,
			unpriced: true,
		},
		{
			cost: { knownUsd: 0, hasEstimated: false, hasUnknown: true, allKnownFree: false, calls: 1 },
			expected: /Session\s+0 tokens/,
			unpriced: true,
		},
		{
			cost: { knownUsd: 0, hasEstimated: false, hasUnknown: false, allKnownFree: true, calls: 1 },
			expected: /Session\s+\$0\.00 local/,
		},
		{
			cost: { knownUsd: 0.25, hasEstimated: true, hasUnknown: false, allKnownFree: false, calls: 1 },
			expected: /Session\s+~\$0\.25 est/,
		},
		{
			cost: { knownUsd: 0.25, hasEstimated: false, hasUnknown: true, allKnownFree: false, calls: 2 },
			expected: /Session\s+\$0\.25 \+\?/,
		},
	];
	for (const { cost, expected, unpriced } of cases) {
		const text = activityOverlay(cost);
		match(text, expected);
		if (unpriced) doesNotMatch(text, /\$0\.00/);
	}
});

test("usage Activity leaves pending or unavailable Git changes unobserved", () => {
	const text = activityOverlay({ knownUsd: 0, hasEstimated: false, hasUnknown: false, allKnownFree: false, calls: 0 });
	match(text, /Changes\s+not observed/);
	doesNotMatch(text, /no repository/);
});

function activityOverlay(cost: CostAggregate): string {
	const tui = {
		terminal: { rows: 24 },
		requestRender() {},
		showOverlay() {
			return { hide() {} };
		},
	} as unknown as TUI;
	const snapshot = { session: { cost } };
	const observability = {
		snapshot: () => snapshot,
		costEntries: () => [],
		subscribe: () => () => {},
	} as unknown as ObservabilityContract;
	const handle = openUsageOverlay(tui, observability, { now: () => new Date(2026, 8, 26, 12).getTime() });
	try {
		const frame = dockTop(tui)?.frame;
		ok(frame);
		return stripTerminalSequences(frame.renderDockBody(104, 16).join("\n"));
	} finally {
		handle.hide();
	}
}
