import { deepStrictEqual, doesNotMatch, match, ok } from "node:assert/strict";
import { test } from "node:test";
import type { TelemetryView } from "../../src/domains/observability/contract.js";
import type { ObservabilityContract } from "../../src/domains/observability/index.js";
import type { TUI } from "../../src/engine/tui.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { bucketActivity, renderActivityHeatmap } from "../../src/interactive/activity-view.js";
import { dockTop } from "../../src/interactive/dock.js";
import { openUsageOverlay } from "../../src/interactive/usage-overlay.js";
import { telemetryCall, telemetryViewOf } from "../harness/telemetry-view.js";

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

test("usage Activity preserves unpriced, estimated and measured session cost from the read model", () => {
	const call = (usd: number | null, pricedBy?: "free" | "catalog" | "target-rates") =>
		telemetryCall("usage-session", { usage: { input: 100, output: 10 }, usd, ...(pricedBy ? { pricedBy } : {}) });
	const cases: Array<{ calls: ReturnType<typeof call>; expected: RegExp; unpriced?: boolean }> = [
		{ calls: [], expected: /Session\s+0 tokens/, unpriced: true },
		{ calls: call(null), expected: /Session\s+not measured · 110 tokens/, unpriced: true },
		{ calls: call(0, "free"), expected: /Session\s+\$0\.00 local/ },
		{ calls: call(0.25, "catalog"), expected: /Session\s+~\$0\.25 est/ },
		{ calls: [...call(0.25), ...call(null)], expected: /Session\s+\$0\.25 \+\?/ },
	];
	for (const { calls, expected, unpriced } of cases) {
		const text = activityOverlay(telemetryViewOf("usage-session", calls));
		match(text, expected);
		if (unpriced) doesNotMatch(text, /\$0\.00/);
	}
});

test("usage Activity leaves pending or unavailable Git changes unobserved", () => {
	const text = activityOverlay(telemetryViewOf("usage-session", []));
	match(text, /Changes\s+not observed/);
	doesNotMatch(text, /no repository/);
});

function activityOverlay(view: TelemetryView): string {
	const tui = {
		terminal: { rows: 24 },
		requestRender() {},
		showOverlay() {
			return { hide() {} };
		},
	} as unknown as TUI;
	const observability = {
		subscribe: () => () => {},
		telemetry: { live: () => view, subscribe: () => () => {} },
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
