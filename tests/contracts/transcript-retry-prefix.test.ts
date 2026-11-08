import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { keptRows } from "../../src/interactive/kept-rows.js";

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

/**
 * A stream tick reports how many leading rows of the live tail are last tick's strings, and the terminal renderer
 * skips those rows. The count must never cover a row that changed: neither the open tail of a plain reply, nor rows
 * above it that a late reference definition rewrites. Either streamed frame must match the same reply rendered fresh.
 */
test("the rows a stream tick vouches for are last tick's rows, even when a late definition rewrites earlier ones", () => {
	const paragraphs = Array.from(
		{ length: 40 },
		(_, index) => `Paragraph ${index} of the answer, with prose that wraps.\n\n`,
	);
	const texts = [
		`${paragraphs.join("")}Done.`,
		`See [the guide][ref] first.\n\n${paragraphs.join("")}[ref]: https://example.com/guide\n\nDone.`,
	];
	const start = (panel: ReturnType<typeof createChatPanel>): void => {
		panel.appendUser("Write the guide.");
		panel.applyEvent({ type: "agent_start" } as never);
		panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	};
	for (const text of texts) {
		const panel = createChatPanel({ now: () => 0 });
		start(panel);
		let previous = panel.renderRegions(80);
		let vouched = 0;
		for (const delta of text.match(/[\s\S]{1,23}/gu) ?? []) {
			panel.applyEvent({ type: "text_delta", contentIndex: 0, delta } as never);
			const frame = panel.renderRegions(80);
			const kept = frame.prefix === previous.prefix ? keptRows(frame.tail, previous.tail) : 0;
			for (let row = 0; row < kept; row += 1)
				strictEqual(
					frame.tail[row],
					previous.tail[row],
					`row ${row} of ${kept} vouched for after ${JSON.stringify(delta)}`,
				);
			vouched += kept;
			previous = frame;
		}
		ok(vouched > 0, "stream ticks vouch for unchanged rows");
		const fresh = createChatPanel({ now: () => 0 });
		start(fresh);
		fresh.applyEvent({ type: "text_delta", contentIndex: 0, delta: text } as never);
		strictEqual(panel.render(80).join("\n"), fresh.render(80).join("\n"));
	}
});

/**
 * A kept-rows record names the rows it was taken against without holding them: when it held them, the latest frame
 * held the one before, which held the one before that, and a 500 KB reply kept every frame's rows alive (#428).
 */
test("a streamed frame's rows do not keep earlier frames' rows alive", async () => {
	setFlagsFromString("--expose-gc");
	const gc = runInNewContext("gc") as () => void;
	const panel = createChatPanel({ now: () => 0 });
	panel.appendUser("Write the guide.");
	panel.applyEvent({ type: "agent_start" } as never);
	panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	const paragraph = "A paragraph of the answer, with prose that wraps.\n\n";
	panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: paragraph.repeat(20) } as never);
	panel.renderRegions(80);
	panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "More " } as never);
	const first = new WeakRef(panel.renderRegions(80).tail);
	for (let frame = 0; frame < 20; frame += 1) {
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: frame % 4 === 3 ? paragraph : "words " } as never);
		panel.renderRegions(80);
	}
	await new Promise((resolve) => setImmediate(resolve));
	gc();
	strictEqual(first.deref(), undefined, "the first frame's tail was collected");
});
