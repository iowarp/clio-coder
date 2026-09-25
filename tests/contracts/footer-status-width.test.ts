import { doesNotMatch, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { activityQuadrant } from "../../src/interactive/footer/widgets.js";
import { footerState } from "../harness/footer-fixture.js";

test("Activity uses the actual column width for its status pill", () => {
	const state = footerState();
	const status = { ...state.status, phase: "retrying" as const, retry: { attempt: 2, maxAttempts: 3, waitMs: 0 } };
	for (const width of [40, 60, 80, 120, 200]) {
		const lines = activityQuadrant(state.agent, { width, status, now: state.now });
		const text = lines.map(stripTerminalSequences).join("\n");
		match(text, /retry/u);
		if (width === 40) doesNotMatch(text, /retry 2\/3/u);
		else match(text, /retry 2\/3/u);
		for (const line of lines) {
			ok(visibleWidth(line) <= width);
			for (const tail of line.split(String.fromCharCode(27)).slice(1)) ok(/^\[[0-9;]*m/u.test(tail));
		}
	}
});
