import { ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { buildLayout } from "../../src/interactive/layout.js";
import { createRenderTrace, traceComponentRenders } from "../../src/interactive/render-trace.js";

const WIDTHS = [60, 80, 120, 200] as const;

for (const width of WIDTHS) {
	test(`trace attributes panel work and changed rows to the ${width}-column frame`, async () => {
		const path = join(tmpdir(), `perf-render-trace-${width}.jsonl`);
		const trace = createRenderTrace(path);
		let row = "initial";
		const reusedRows = ["fixed prefix", row];
		const root = {
			render: (_columns: number) => {
				reusedRows[1] = row;
				return reusedRows;
			},
		};
		const restore = traceComponentRenders(root, trace);
		for (const [index, rendered, changed] of [
			[0, 7, 2],
			[1, 1, 1],
		] as const) {
			const frame = trace.beginFrame({ mode: "regular", columns: width, rows: 24 });
			trace.recordPanelRender({ durationMs: 0, cacheHit: false, entriesRendered: rendered });
			const lines = root.render(width);
			for (const line of lines) {
				ok(visibleWidth(line) <= width);
				ok(!line.includes(String.fromCharCode(27)), "no raw terminal escapes");
			}
			trace.recordTerminalWrite({ bytes: 1, enqueueMs: 0, returned: true });
			trace.endFrame(frame);
			const record = trace.snapshotInputWedge().frames.at(-1);
			strictEqual(record?.frameId, index + 1);
			strictEqual(record?.panel?.entriesRendered, rendered);
			strictEqual(record?.rowsChanged, changed);
			row = "updated";
		}
		restore();
		await trace.close();
		const records = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; rowsChanged?: number });
		strictEqual(records.filter((record) => record.type === "frame").at(-1)?.rowsChanged, 1);
	});
}

test("ring-only tracing skips root row comparison", () => {
	const trace = createRenderTrace(null);
	const root = { render: (_columns: number) => ["fixed"] };
	const originalRecordRows = trace.recordRootRows;
	trace.recordRootRows = () => {
		throw new Error("row comparison must stay off without a trace path");
	};
	const restore = traceComponentRenders(root, trace);
	const frame = trace.beginFrame({ mode: "regular", columns: 80, rows: 24 });
	root.render(80);
	trace.recordTerminalWrite({ bytes: 1, enqueueMs: 0, returned: true });
	trace.endFrame(frame);
	strictEqual(trace.snapshotInputWedge().frames.at(-1)?.rowsChanged, null);
	restore();
	trace.recordRootRows = originalRecordRows;
});

test("an 80-column streaming answer changes only the live tail after long settled history", async () => {
	const trace = createRenderTrace(join(tmpdir(), "perf-stream-trace.jsonl"));
	const panel = createChatPanel({ now: () => 1_000, onRenderMetrics: (metrics) => trace.recordPanelRender(metrics) });
	const settle = (answer: string): void => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: answer }],
			stopReason: "stop",
			usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
		};
		panel.applyEvent({ type: "message_end", message } as never);
		panel.applyEvent({ type: "agent_end", messages: [message] } as never);
	};
	for (let index = 0; index < 40; index++) {
		panel.appendUser(`Question ${index}`);
		panel.applyEvent({ type: "agent_start" } as never);
		panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: `Answer ${index}` } as never);
		settle(`Answer ${index}`);
	}
	panel.appendUser("New question");
	panel.applyEvent({ type: "agent_start" } as never);
	panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	const fixed = { render: () => ["fixed"], invalidate: () => {} };
	const root = buildLayout({ banner: fixed, chat: panel, editor: fixed, footer: fixed });
	const restore = traceComponentRenders(root, trace);
	const frame = (): number => {
		const token = trace.beginFrame({ mode: "regular", columns: 80, rows: 24 });
		const lines = root.render(80);
		for (const line of lines) ok(visibleWidth(line) <= 80);
		trace.recordTerminalWrite({ bytes: 1, enqueueMs: 0, returned: true });
		trace.endFrame(token);
		return trace.snapshotInputWedge().frames.at(-1)?.rowsChanged ?? -1;
	};
	frame();
	panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: " first" } as never);
	frame();
	const prefixRows = panel.renderRegions(80).prefix.length;
	ok(prefixRows > 100, `the settled transcript has a long frozen prefix: ${prefixRows} rows`);
	for (let tick = 0; tick < 8; tick++) {
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: ` word${tick}` } as never);
		const changed = frame();
		ok((trace.snapshotInputWedge().frames.at(-1)?.panel?.entriesRendered ?? -1) <= 1);
		const tailRows = panel.renderRegions(80).tail.length;
		ok(changed <= tailRows + 4, `${changed} rows changed, with ${tailRows} tail rows`);
		ok(changed < prefixRows, "settled prefix rows are not counted");
	}
	restore();
	await trace.close();
});
