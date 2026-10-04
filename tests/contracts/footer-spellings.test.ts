import { match, ok } from "node:assert/strict";
import { test } from "node:test";
import type { TokenThroughputSnapshot, UsageBreakdown } from "../../src/domains/observability/index.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { renderDashboardPage } from "../../src/interactive/footer/pages.js";
import { activityQuadrant } from "../../src/interactive/footer/widgets.js";
import { throughputSegment, tokensSegment } from "../../src/interactive/footer-panel.js";
import { resolveFooterVerb } from "../../src/interactive/status/verbs.js";
import { GLYPH } from "../../src/interactive/theme/index.js";
import type { TurnSummary } from "../../src/session-control/status-types.js";
import { footerState } from "../harness/footer-fixture.js";

test("footer status, counts and token units use one vocabulary at release widths", () => {
	const state = footerState();
	state.session.target = null;
	const row = state.dispatchRows[0];
	ok(row);
	state.dispatchRows = [{ ...row, status: "failed" }];
	const throughput = { tokensPerSecond: 12.4, outputTokens: 200, ttftMs: 100 } as TokenThroughputSnapshot;
	const usage = { input: 100, output: 200, totalTokens: 300 } as UsageBreakdown;
	match(throughputSegment(throughput) ?? "", /12 Tk\/s/u);
	match(tokensSegment(usage) ?? "", new RegExp(`${GLYPH.up} 100 ${GLYPH.down} 200`));
	const retrying = { ...state.status, phase: "retrying" as const, retry: { attempt: 2, maxAttempts: 3, waitMs: 0 } };
	const ended = {
		...state.status,
		phase: "ended" as const,
		summary: { stopReason: "stop", elapsedMs: 1000 } as TurnSummary,
	};
	for (const width of [60, 80, 120, 200]) {
		const status = renderDashboardPage(state, "Status", width, 240, "Alt+U");
		const plain = status.map(stripTerminalSequences).join("\n");
		match(
			renderDashboardPage(state, "Status", width, 240, "Alt+U", 6).map(stripTerminalSequences).join("\n"),
			/No model selected/u,
		);
		match(plain, /1 failed/u);
		const activity = activityQuadrant(state.agent, { width, status: retrying, throughput, now: state.now });
		match(activity.map(stripTerminalSequences).join("\n"), /Retrying 2\/3/u);
		match(activity.map(stripTerminalSequences).join("\n"), /12 Tk\/s/u);
		const done = activityQuadrant(state.agent, { width, status: ended, now: state.now });
		match(done.map(stripTerminalSequences).join("\n"), new RegExp(`${GLYPH.ok} Done`));
		match(resolveFooterVerb(ended, state.now, width)?.text ?? "", new RegExp(`${GLYPH.ok} Done`));
		for (const line of [...status, ...activity, ...done]) {
			ok(visibleWidth(line) <= width);
			for (const tail of line.split(String.fromCharCode(27)).slice(1)) ok(/^\[[0-9;]*m/u.test(tail));
		}
	}
});
