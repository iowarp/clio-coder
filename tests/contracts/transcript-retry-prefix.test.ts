import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";

const WIDTHS = [60, 80, 120, 200] as const;

/**
 * A settled retry row used to stop the frozen prefix at its position, so every
 * streamed token re-rendered it and every settled row after it. The stream tick
 * must render only the live answer, and a later update of the same attempt must
 * still reach the screen.
 */
test("a settled retry row joins the frozen prefix and a stream tick renders only the live answer", () => {
	for (const width of WIDTHS) {
		let rendered = -1;
		const panel = createChatPanel({
			now: () => 0,
			onRenderMetrics: (metrics) => {
				rendered = metrics.entriesRendered;
			},
		});
		panel.applyEvent({ type: "retry_status", status: { phase: "retrying", attempt: 1, maxAttempts: 3 } });
		panel.appendUser("Explain the render path of a streamed token.");
		panel.applyEvent({ type: "agent_start" } as never);
		panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "The panel " } as never);
		// This frame freezes the settled rows; from here on only the answer streams.
		panel.renderRegions(width);
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "then " } as never);
		const first = panel.renderRegions(width);
		ok(first.prefix.length > 0, `${width}: the retry and prompt rows are frozen`);
		for (const delta of ["renders ", "only ", "its ", "tail."]) {
			panel.applyEvent({ type: "text_delta", contentIndex: 0, delta } as never);
			const frame = panel.renderRegions(width);
			strictEqual(frame.prefix, first.prefix, `${width}: the settled rows are the same array every tick`);
			strictEqual(rendered, 1, `${width}: a stream tick renders one entry`);
			for (const line of [...frame.prefix, ...frame.tail]) ok(visibleWidth(line) <= width);
		}
	}
});

test("an update of the same retry attempt replaces its frozen row", () => {
	for (const width of WIDTHS) {
		const panel = createChatPanel({ now: () => 0 });
		panel.applyEvent({ type: "retry_status", status: { phase: "retrying", attempt: 1, maxAttempts: 3 } });
		panel.renderRegions(width);
		panel.renderRegions(width);
		panel.applyEvent({ type: "retry_status", status: { phase: "recovered", attempt: 1, maxAttempts: 3 } });
		const plain = panel.render(width).map(stripTerminalSequences).join("\n");
		match(plain, /recovered after 1 attempt/u);
		strictEqual((plain.match(/↻/gu) ?? []).length, 1);
	}
});
