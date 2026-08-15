import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { INLINE_STATUS_INDENT_COLS, resolveInlineVerb, spinnerFrame } from "../../src/interactive/status/index.js";
import type { AgentStatus } from "../../src/interactive/status/types.js";

/** The watchdog tier-3 dispatch status that exited the TUI at 73 columns (issue #53). */
function stalledDispatch(agentName: string): AgentStatus {
	return {
		phase: "dispatching",
		since: 0,
		lastMeaningfulAt: 0,
		watchdogTier: 3,
		watchdogPeak: 3,
		localRuntime: false,
		dispatch: { agentName },
	};
}

/** What interactive-event-projection prepends to the verb on the same row. */
function prefixCols(cols: number): { frame: string; cols: number } {
	const frame = cols < 30 ? "" : `${spinnerFrame(0)} `;
	return { frame, cols: INLINE_STATUS_INDENT_COLS + visibleWidth(frame) };
}

describe("inline status line fits the terminal at narrow widths", () => {
	it("renders a tier-3 dispatch hint at 73 columns without exceeding the width", () => {
		// The crash line was `  ⣽ Awaiting agent result: scout (no progress for
		// 1m30s; press Esc to cancel)` at 77 cells against a 73-column terminal.
		const status = stalledDispatch("scout");
		const prefix = prefixCols(73);
		const verb = resolveInlineVerb(status, 90_000, 73, prefix.cols);
		ok(verb, "a stalled dispatch still shows a verb");
		ok(verb.text.includes("Awaiting agent result"), `the verb survives the fit, got: ${verb.text}`);

		const panel = createChatPanel();
		panel.setStatusLine({ phase: status.phase, verb: `${prefix.frame}${verb.text}`, toneHint: verb.toneHint });
		for (const line of panel.render(73)) {
			ok(visibleWidth(line) <= 73, `rendered line exceeds 73 columns (${visibleWidth(line)}): ${line}`);
		}
	});

	it("keeps the hint when the terminal has room for it", () => {
		const verb = resolveInlineVerb(stalledDispatch("scout"), 90_000, 120, prefixCols(120).cols);
		ok(verb?.text.includes("press Esc to cancel"), `wide terminals keep the hint, got: ${verb?.text}`);
	});

	it("truncates the agent-name tail once dropping the hint is not enough", () => {
		const cols = 24;
		const prefix = prefixCols(cols);
		const verb = resolveInlineVerb(stalledDispatch("scout-with-a-long-name"), 90_000, cols, prefix.cols);
		ok(verb, "a narrow terminal still shows a verb");
		ok(!verb.text.includes("press Esc"), "the hint is gone before the verb is cut");
		ok(
			visibleWidth(`${prefix.frame}${verb.text}`) + INLINE_STATUS_INDENT_COLS <= cols,
			`the fitted line stays inside ${cols} columns, got: ${verb.text}`,
		);
	});
});
