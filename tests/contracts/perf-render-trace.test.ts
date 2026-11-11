import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Component } from "../../src/engine/tui.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { buildLayout } from "../../src/interactive/layout.js";
import { createRenderTrace, traceComponentRenders } from "../../src/interactive/render-trace.js";
import type { WorkerEntryState } from "../../src/session-control/worker-stream.js";

test("fullscreen reuses its document on composer frames and refreshes headers, tails, widths and resets", () => {
	const header = ["header"];
	const panel = createChatPanel({ now: () => 1_000 });
	panel.appendUser("A prompt long enough to wrap at a narrow width");
	let document: Component | undefined;
	const fixed = { render: () => [], invalidate() {} };
	buildLayout(
		{ banner: { render: () => header, invalidate() {} }, chat: panel, editor: fixed, footer: fixed },
		{
			mode: "fullscreen",
			onTranscript: (view) => {
				document = view.children[0];
			},
		},
	);
	ok(document);
	const initial = document.render(80);
	for (let frame = 0; frame < 100; frame++) strictEqual(document.render(80), initial);
	// The banner is allowed to reuse and mutate its array.
	header[0] = "updated";
	const updated = document.render(80);
	notStrictEqual(updated, initial);
	strictEqual(updated[0], "updated");
	strictEqual(initial[0], "header", "previous frame snapshots remain intact");
	panel.applyEvent({ type: "text_delta", delta: "New live answer " } as never);
	const live = document.render(80);
	notStrictEqual(live, updated);
	ok(stripTerminalSequences(live.join("\n")).includes("New live answer"));
	const narrow = document.render(20);
	notStrictEqual(narrow, live);
	ok(narrow.every((line) => visibleWidth(line) <= 20));
	document.invalidate();
	notStrictEqual(document.render(20), narrow);
	panel.reset();
	deepStrictEqual(document.render(80), ["updated"]);
});

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

/** One live turn of `messages` assistant messages, each with reasoning, prose, and two reads Compact folds. */
function liveTurnEvents(messages: number, from = 0): object[] {
	const fence = "```";
	const events: object[] = from === 0 ? [{ type: "agent_start" }] : [];
	for (let index = from; index < from + messages; index++) {
		const text = `Step ${index}: reading the next files.\n\n- one\n- two\n\n${fence}ts\nconst a = ${index};\n${fence}`;
		events.push({ type: "message_start", message: { role: "assistant" } });
		events.push({ type: "thinking_delta", delta: `Plan ${index}` });
		events.push({ type: "text_delta", contentIndex: 0, delta: text });
		events.push({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text }], stopReason: "toolUse" },
		});
		for (const suffix of ["a", "b"]) {
			const toolCallId = `read-${index}-${suffix}`;
			events.push({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path: `${toolCallId}.ts` } });
			events.push({
				type: "tool_execution_end",
				toolCallId,
				toolName: "read",
				result: `body ${toolCallId}`,
				isError: false,
			});
		}
	}
	return events;
}

function panelWith(style: "compact" | "standard" | "detailed", events: readonly object[]) {
	const panel = createChatPanel({ now: () => 1_000, getOutputStyle: () => style });
	panel.appendUser("Go");
	for (const event of events) panel.applyEvent(event as never);
	return panel;
}

for (const style of ["compact", "standard", "detailed"] as const) {
	test(`a ${style} live turn renders the rows a fresh panel renders, frame by frame and across a width change`, () => {
		const events = [
			...liveTurnEvents(6),
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "text_delta", contentIndex: 0, delta: "Still " },
			{ type: "text_delta", contentIndex: 0, delta: "writing" },
		];
		const live = panelWith(style, []);
		for (let index = 0; index < events.length; index++) {
			live.applyEvent(events[index] as never);
			const frame = live.render(80);
			deepStrictEqual(frame, panelWith(style, events.slice(0, index + 1)).render(80), `after event ${index}`);
		}
		deepStrictEqual(live.render(60), panelWith(style, events).render(60));
		deepStrictEqual(live.render(80), panelWith(style, events).render(80));
	});
}

test("a settled call a worker card attaches to re-renders inside a live turn's settled rows", () => {
	const events = [
		{ type: "agent_start" },
		{ type: "tool_execution_start", toolCallId: "d1", toolName: "dispatch", args: { agent: "reviewer", task: "review" } },
		{ type: "tool_execution_end", toolCallId: "d1", toolName: "dispatch", result: "1 task dispatched", isError: false },
		...liveTurnEvents(4, 1),
		{ type: "message_start", message: { role: "assistant" } },
	];
	const card = (): WorkerEntryState =>
		({
			assignmentId: "a1",
			runId: "run-1",
			origin: "agent",
			agentId: "reviewer",
			runtime: { kind: "clio", targetId: "mini", wireModelId: "coder" },
			text: "looks fine",
			droppedLines: 0,
			tools: [],
			attempts: [{ runId: "run-1", targetLabel: "mini" }],
			pending: false,
			parentToolCallId: "d1",
			result: { outcome: "succeeded" },
		}) as WorkerEntryState;
	const live = panelWith("standard", []);
	for (const event of events) {
		live.applyEvent(event as never);
		live.render(80);
	}
	const before = live.render(80);
	live.applyWorkerState(card());
	const delta = { type: "text_delta", contentIndex: 0, delta: "Next" };
	live.applyEvent(delta as never);
	const fresh = panelWith("standard", events);
	fresh.applyWorkerState(card());
	fresh.applyEvent(delta as never);
	const frame = live.render(80);
	deepStrictEqual(frame, fresh.render(80));
	notStrictEqual(frame.join("\n"), before.join("\n"));
});

test("a delta in a live turn of many settled messages renders only the live message", () => {
	let segments = -1;
	const panel = createChatPanel({
		now: () => 1_000,
		onRenderMetrics: (metrics) => (segments = metrics.segmentsRendered),
	});
	panel.appendUser("Go");
	for (const event of liveTurnEvents(400)) panel.applyEvent(event as never);
	panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	panel.renderRegions(80);
	// The first frames build the turn's settled head, then freeze it.
	panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "Next" } as never);
	panel.renderRegions(80);
	for (let tick = 0; tick < 4; tick++) {
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: ` word${tick}` } as never);
		const { prefix, tail } = panel.renderRegions(80);
		ok(segments <= 4, `${segments} segments rendered for one delta`);
		ok(tail.length <= 8, `${tail.length} tail rows, after a frozen prefix of ${prefix.length}`);
	}
});
