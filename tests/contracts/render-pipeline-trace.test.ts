import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type Component, InstrumentedTuiMainScreen, type Terminal } from "../../src/engine/tui.js";
import {
	createRenderTrace,
	type RenderTrace,
	type RenderTraceRecord,
	traceComponentRenders,
	traceProcessStdout,
} from "../../src/interactive/render-trace.js";

interface TraceHarness {
	trace: RenderTrace;
	advance(ms: number): void;
	records(): RenderTraceRecord[];
	close(): Promise<void>;
}

function createHarness(
	options: {
		maxRecords?: number;
		append?: (path: string, payload: string) => Promise<void>;
		appendTimeoutMs?: number;
	} = {},
): TraceHarness {
	const dir = mkdtempSync(join(tmpdir(), "clio-render-trace-"));
	const chunks: string[] = [];
	let clock = 100;
	const append =
		options.append ??
		(async (_path: string, payload: string): Promise<void> => {
			chunks.push(payload);
		});
	const trace = createRenderTrace(join(dir, "trace.jsonl"), () => clock, {
		...(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }),
		...(options.appendTimeoutMs === undefined ? {} : { appendTimeoutMs: options.appendTimeoutMs }),
		batchRecords: 1,
		append,
	});
	return {
		trace,
		advance: (ms) => {
			clock += ms;
		},
		records: () =>
			chunks
				.join("")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as RenderTraceRecord),
		close: async () => {
			await trace.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

class TraceTerminal implements Terminal {
	readonly columns = 80;
	readonly rows = 24;
	readonly kittyProtocolActive = false;

	constructor(
		private readonly trace: RenderTrace,
		private readonly order: string[],
	) {}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.order.push(`write:${Buffer.byteLength(data, "utf8")}`);
		this.trace.recordTerminalWrite({ bytes: Buffer.byteLength(data, "utf8"), enqueueMs: 0.1, returned: true });
	}
	moveBy(lines: number): void {
		this.write(`move:${lines}`);
	}
	hideCursor(): void {
		this.order.push("cursor:hide");
		this.trace.recordTerminalWrite({ bytes: 6, enqueueMs: 0.1, returned: true });
	}
	showCursor(): void {
		this.order.push("cursor:show");
		this.trace.recordTerminalWrite({ bytes: 6, enqueueMs: 0.1, returned: true });
	}
	clearLine(): void {
		this.write("clear-line");
	}
	clearFromCursor(): void {
		this.write("clear-tail");
	}
	clearScreen(): void {
		this.write("clear-screen");
	}
	setTitle(title: string): void {
		this.write(`title:${title}`);
	}
	setProgress(active: boolean): void {
		this.write(`progress:${active}`);
	}
}

describe("contracts/render pipeline trace", () => {
	it("groups a regular frame's diff and IME cursor writes under one frame id", async () => {
		const harness = createHarness();
		const order: string[] = [];
		const terminal = new TraceTerminal(harness.trace, order);
		const tui = new InstrumentedTuiMainScreen(terminal, harness.trace);
		const root: Component = {
			render: () => [`hello\x1b_pi:c\x07`],
			invalidate: () => {},
		};
		const restoreRoot = traceComponentRenders(root, harness.trace);
		tui.addChild(root);
		harness.trace.onFirstFrameCommit((frameId) => order.push(`first:${frameId}`));

		terminal.hideCursor(); // protocol/lifecycle write outside any frame
		tui.renderNow();
		restoreRoot();
		await harness.close();

		const writes = harness.records().filter((record) => record.type === "terminal_write");
		strictEqual(writes[0]?.frameId, null, "lifecycle writes are not fabricated into frames");
		const framedWrites = writes.filter((record) => record.frameId !== null);
		ok(framedWrites.length >= 3, "main diff, cursor positioning, and cursor visibility are grouped");
		strictEqual(new Set(framedWrites.map((record) => record.frameId)).size, 1);
		const frame = harness.records().find((record) => record.type === "frame");
		ok(frame?.type === "frame");
		strictEqual(frame.commits.length, framedWrites.length);
		ok(frame.pipeline.componentMs >= 0);
		ok(frame.pipeline.overlayCompositionMs >= 0);
		ok(frame.pipeline.normalizationMs >= 0);
		ok(frame.pipeline.cursorExtractionMs >= 0);
		ok(frame.pipeline.viewportDiffAnsiCursorMs >= 0);
		strictEqual(order.at(-1), "first:1", "first commit fires after every frame write returned");
	});

	it("correlates grapheme ranges, panel application, input, and the first containing commit", async () => {
		const harness = createHarness();
		harness.trace.beginGeneration();
		const first = harness.trace.recordVisibleEvent({
			kind: "text",
			contentIndex: 0,
			delta: "A👨‍👩‍👧‍👦é",
		});
		harness.trace.recordQueue(first, "admit");
		harness.trace.recordPanelApplied(first);
		harness.trace.recordQueue(first, "dequeue");
		const second = harness.trace.recordVisibleEvent({ kind: "text", contentIndex: 0, delta: "!" });
		harness.trace.recordPanelApplied(second);
		const input = harness.trace.recordInputIngress("editor", 1);
		const frame = harness.trace.beginFrame({ mode: "regular", columns: 80, rows: 24 });
		harness.trace.recordTerminalWrite({ bytes: 12, enqueueMs: 0.2, returned: true });
		harness.trace.endFrame(frame);
		await harness.close();

		const ingress = harness.records().filter((record) => record.type === "event_ingress");
		deepStrictEqual(
			ingress.map((record) => [record.graphemeStart, record.graphemeEnd, record.codeUnitStart, record.codeUnitEnd]),
			[
				[0, 3, 0, "A👨‍👩‍👧‍👦é".length],
				[3, 4, "A👨‍👩‍👧‍👦é".length, "A👨‍👩‍👧‍👦é!".length],
			],
		);
		const committed = harness.records().find((record) => record.type === "frame");
		ok(committed?.type === "frame");
		strictEqual(committed.panelHighWater, second);
		strictEqual(committed.inputHighWater, input);
	});

	it("records stdout backpressure and the matching drain without inventing a frame", async () => {
		const harness = createHarness();
		class FakeStdout extends EventEmitter {
			chunks: string[] = [];
			write(chunk: string): boolean {
				this.chunks.push(chunk);
				return false;
			}
		}
		const stdout = new FakeStdout();
		const restore = traceProcessStdout(harness.trace, () => 10, stdout as never);
		strictEqual(stdout.write("slow"), false);
		harness.advance(7);
		stdout.emit("drain");
		restore();
		await harness.close();

		const write = harness.records().find((record) => record.type === "terminal_write");
		const drain = harness.records().find((record) => record.type === "terminal_drain");
		ok(write?.type === "terminal_write");
		strictEqual(write.frameId, null);
		strictEqual(write.returned, false);
		strictEqual(write.backpressured, true);
		ok(drain?.type === "terminal_drain");
		strictEqual(drain.writeId, write.writeId);
		strictEqual(drain.waitMs, 7);
	});

	it("buffers asynchronously, reports bounded drops, and treats write failure as nonfatal", async () => {
		let appendCalls = 0;
		const payloads: string[] = [];
		const harness = createHarness({
			maxRecords: 2,
			append: async (_path, payload) => {
				appendCalls += 1;
				payloads.push(payload);
			},
		});
		for (let index = 0; index < 10; index += 1) {
			harness.trace.recordInputIngress("editor", index);
		}
		strictEqual(appendCalls, 0, "recording performs no synchronous file append");
		await harness.close();
		ok(appendCalls > 0);
		ok(payloads.join("").includes('"type":"trace_drop"'));

		const failing = createHarness({ append: async () => Promise.reject(new Error("disk unavailable")) });
		failing.trace.recordInputIngress("editor", 1);
		await failing.close();

		const stalled = createHarness({ append: () => new Promise(() => {}), appendTimeoutMs: 5 });
		stalled.trace.recordInputIngress("editor", 1);
		await stalled.close();
	});
});
