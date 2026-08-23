/**
 * Buffered live worker progress in the Fleet Runs board.
 *
 * The board and the transcript block read one projection, so what is asserted
 * here is the board half: that opening a run shows what the worker is saying
 * and touching, that the descriptor it shows was redacted before it crossed
 * the worker seam, that the default list stays compact, and that the card's
 * height stays bounded whatever the stream does.
 */

import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus, type SafeEventBus } from "../../src/core/event-bus.js";
import {
	createDispatchBoardStore,
	createDispatchBoardView,
	type DispatchBoardRow,
	renderDispatchCard,
} from "../../src/interactive/dispatch-board.js";
import { routeDispatchBoardOverlayKey } from "../../src/interactive/overlay-key-routing.js";
import { workerEntriesFromRunEntries } from "../../src/interactive/worker-replay.js";
import type { WorkerReceiptFacts } from "../../src/interactive/worker-stream.js";

const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const stripSgr = (text: string): string => text.replace(SGR, "");

function started(bus: SafeEventBus, runId: string, agentId = "coder"): void {
	bus.emit(BusChannels.DispatchStarted, {
		runId,
		agentId,
		executionRole: "builder",
		targetId: "default",
		wireModelId: "model",
		runtimeId: "runtime",
		runtimeKind: "http",
		requestOrigin: "user",
		pid: 1,
	} as never);
}

function progress(bus: SafeEventBus, runId: string, event: unknown, agentId = "coder"): void {
	bus.emit(BusChannels.DispatchProgress, { runId, agentId, event } as never);
}

function delta(text: string): unknown {
	return { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } };
}

function completed(bus: SafeEventBus, runId: string): void {
	bus.emit(BusChannels.DispatchCompleted, {
		runId,
		agentId: "coder",
		executionRole: "builder",
		targetId: "default",
		wireModelId: "model",
		runtimeId: "runtime",
		runtimeKind: "http",
		requestOrigin: "user",
		outcome: "succeeded",
		outcomeDetail: null,
	} as never);
}

function card(row: DispatchBoardRow, options: { expanded?: boolean } = {}, width = 76): string {
	return stripSgr(renderDispatchCard(row, width, undefined, options).join("\n"));
}

describe("fleet runs worker progress", () => {
	it("carries the streamed answer tail on the row for the selected worker", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-1");
			progress(bus, "run-1", delta("Reading the failing test"));
			progress(bus, "run-1", delta(" before I change anything."));
			const row = store.rows()[0];
			strictEqual(row?.progress?.tailText, "Reading the failing test before I change anything.");
			strictEqual(row?.progress?.phase, "writing");
			ok(card(row as DispatchBoardRow, { expanded: true }).includes("Reading the failing test"));
		} finally {
			store.unsubscribe();
		}
	});

	it("keeps the default list compact and shows the tail only when the operator expands", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-1");
			progress(bus, "run-1", delta("a sentence the operator did not ask to read"));
			const row = store.rows()[0] as DispatchBoardRow;
			const compact = card(row);
			ok(!compact.includes("a sentence the operator did not ask to read"), compact);
			ok(!compact.includes("answer"), compact);
			ok(card(row, { expanded: true }).includes("a sentence the operator did not ask to read"));
		} finally {
			store.unsubscribe();
		}
	});

	it("shows the tool name plus its redacted descriptor, never an argument object", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-1");
			progress(bus, "run-1", {
				type: "clio_tool_start",
				payload: { tool: "bash", action: { verb: "running", object: "npm test" } },
			});
			const row = store.rows()[0] as DispatchBoardRow;
			deepStrictEqual(row.progress?.currentAction, {
				tool: "bash",
				descriptor: { verb: "running", object: "npm test" },
			});
			const rendered = card(row, { expanded: true });
			ok(rendered.includes("bash running npm test"), rendered);
			strictEqual(row.currentTool, "bash");
		} finally {
			store.unsubscribe();
		}
	});

	it("attributes concurrent calls of one tool independently on Fleet Runs", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-1");
			progress(bus, "run-1", {
				type: "clio_tool_start",
				payload: {
					tool: "bash",
					toolCallId: "bash-1",
					action: { verb: "running", object: "npm run lint" },
				},
			});
			progress(bus, "run-1", {
				type: "clio_tool_start",
				payload: {
					tool: "bash",
					toolCallId: "bash-2",
					action: { verb: "running", object: "npm run typecheck" },
				},
			});
			progress(bus, "run-1", {
				type: "clio_tool_finish",
				payload: { tool: "bash", toolCallId: "bash-1", outcome: "ok" },
			});
			let row = store.rows()[0] as DispatchBoardRow;
			strictEqual(row.progress?.recentActions[0]?.toolCallId, "bash-1");
			strictEqual(row.progress?.recentActions[0]?.descriptor?.object, "npm run lint");
			strictEqual(row.progress?.currentAction?.toolCallId, "bash-2");
			const running = card(row, { expanded: true });
			ok(running.includes("bash running npm run typecheck"), running);

			progress(bus, "run-1", {
				type: "clio_tool_finish",
				payload: { tool: "bash", toolCallId: "bash-2", outcome: "ok" },
			});
			row = store.rows()[0] as DispatchBoardRow;
			deepStrictEqual(
				row.progress?.recentActions.map((action) => action.toolCallId),
				["bash-2", "bash-1"],
			);
			strictEqual(row.progress?.currentAction, null);
		} finally {
			store.unsubscribe();
		}
	});

	it("ignores tool_execution_start, whose args are the call's literal arguments", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-1");
			progress(bus, "run-1", {
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "bash",
				args: { command: "cat ~/.ssh/id_rsa" },
			});
			const row = store.rows()[0] as DispatchBoardRow;
			strictEqual(row.currentTool, null);
			ok(!card(row, { expanded: true }).includes("id_rsa"));
		} finally {
			store.unsubscribe();
		}
	});

	it("shows a thinking phase and never the reasoning text behind it", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-1");
			progress(bus, "run-1", {
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", delta: "the private plan" },
			});
			const row = store.rows()[0] as DispatchBoardRow;
			strictEqual(row.progress?.phase, "thinking");
			const rendered = card(row, { expanded: true });
			ok(rendered.includes("thinking"), rendered);
			ok(!rendered.includes("the private plan"), rendered);
		} finally {
			store.unsubscribe();
		}
	});

	it("attributes parallel workers independently", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-a", "scout-a");
			started(bus, "run-b", "scout-b");
			progress(bus, "run-a", delta("alpha is reading"), "scout-a");
			progress(bus, "run-b", delta("beta is writing"), "scout-b");
			const rows = store.rows();
			const a = rows.find((row) => row.runId === "run-a");
			const b = rows.find((row) => row.runId === "run-b");
			strictEqual(a?.progress?.tailText, "alpha is reading");
			strictEqual(b?.progress?.tailText, "beta is writing");
		} finally {
			store.unsubscribe();
		}
	});

	it("keeps a worker that emits no text attributable through its actions", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-1");
			progress(bus, "run-1", {
				type: "clio_tool_start",
				payload: { tool: "verify", action: { verb: "verifying", object: "typecheck" } },
			});
			progress(bus, "run-1", { type: "clio_tool_finish", payload: { tool: "verify", outcome: "ok" } });
			const row = store.rows()[0] as DispatchBoardRow;
			strictEqual(row.progress?.tailText, "");
			deepStrictEqual(row.recentTools, ["verify"]);
			ok(card(row, { expanded: true }).includes("last verify verifying typecheck"));
		} finally {
			store.unsubscribe();
		}
	});
});

describe("fleet runs worker progress settlement", () => {
	it("replaces the provisional tail with the receipt-sealed answer", () => {
		const bus = createSafeEventBus();
		const receipt = (): WorkerReceiptFacts => ({ outcome: "succeeded", text: "the sealed answer" });
		const store = createDispatchBoardStore(bus, undefined, receipt);
		try {
			started(bus, "run-1");
			progress(bus, "run-1", delta("a provisional draft"));
			completed(bus, "run-1");
			const row = store.rows()[0] as DispatchBoardRow;
			strictEqual(row.progress?.tailText, "the sealed answer");
			strictEqual(row.progress?.settled, true);
			strictEqual(row.currentTool, null);
		} finally {
			store.unsubscribe();
		}
	});

	it("settles agent_end on the durable message, then reseals it on the receipt", () => {
		const bus = createSafeEventBus();
		let receiptReads = 0;
		const store = createDispatchBoardStore(bus, undefined, (): WorkerReceiptFacts => {
			receiptReads += 1;
			return { outcome: "succeeded", text: "the sealed answer" };
		});
		try {
			started(bus, "run-1");
			progress(bus, "run-1", delta("a provisional draft"));
			progress(bus, "run-1", {
				type: "message_end",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "durable answer" }] },
			});
			progress(bus, "run-1", { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
			// The worker is done before the domain has sealed anything, so nothing
			// has gone looking for a receipt that cannot exist yet.
			strictEqual(receiptReads, 0);
			strictEqual(store.rows()[0]?.progress?.tailText, "durable answer");
			completed(bus, "run-1");
			strictEqual(receiptReads, 1);
			strictEqual(store.rows()[0]?.progress?.tailText, "the sealed answer");
		} finally {
			store.unsubscribe();
		}
	});

	it("keeps the run's own durable message when no receipt could be read", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus, undefined, () => null);
		try {
			started(bus, "run-1");
			progress(bus, "run-1", delta("streamed but unsealed"));
			progress(bus, "run-1", {
				type: "message_end",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "durable answer" }] },
			});
			completed(bus, "run-1");
			strictEqual(store.rows()[0]?.progress?.tailText, "durable answer");
		} finally {
			store.unsubscribe();
		}
	});

	it("clears the running call on cancellation without blanking what the worker said", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-1");
			progress(bus, "run-1", delta("half an answer"));
			progress(bus, "run-1", { type: "clio_tool_start", payload: { tool: "bash" } });
			bus.emit(BusChannels.RunAborted, {
				source: "dispatch_abort",
				runId: "run-1",
				startedAt: new Date().toISOString(),
				elapsedMs: 10,
				reason: "operator cancel",
			});
			bus.emit(BusChannels.DispatchFailed, {
				runId: "run-1",
				agentId: "coder",
				executionRole: "builder",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
				requestOrigin: "user",
				reason: "canceled",
				outcome: "canceled",
				outcomeDetail: "operator cancel",
			} as never);
			const row = store.rows()[0] as DispatchBoardRow;
			strictEqual(row.status, "aborted");
			strictEqual(row.currentTool, null);
			strictEqual(row.progress?.tailText, "half an answer");
		} finally {
			store.unsubscribe();
		}
	});

	it("hands a retry the tail and reopens the projection for the new attempt", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-1");
			progress(bus, "run-1", delta("first attempt got this far"));
			progress(bus, "run-1", { type: "clio_tool_start", payload: { tool: "bash" } });
			progress(bus, "run-1", { type: "attempt_start", attempt: 2 });
			const afterHandoff = store.rows()[0] as DispatchBoardRow;
			strictEqual(afterHandoff.status, "running");
			strictEqual(afterHandoff.currentTool, null);
			ok(afterHandoff.progress?.tailText.includes("first attempt got this far"));
			progress(bus, "run-1", delta(" and the retry continued"));
			ok(store.rows()[0]?.progress?.tailText.includes("and the retry continued"));
		} finally {
			store.unsubscribe();
		}
	});
});

describe("fleet runs worker progress presentation", () => {
	it("bounds the expanded card's height however long the stream runs", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-1");
			for (let index = 0; index < 5; index += 1) progress(bus, "run-1", delta(`line ${index}\n`));
			const short = card(store.rows()[0] as DispatchBoardRow, { expanded: true }).split("\n").length;
			for (let index = 0; index < 300; index += 1) progress(bus, "run-1", delta(`line ${index}\n`));
			const long = card(store.rows()[0] as DispatchBoardRow, { expanded: true }).split("\n").length;
			ok(long - short <= 2, `card grew from ${short} to ${long} rows`);
		} finally {
			store.unsubscribe();
		}
	});

	it("says how much it is not showing and where to read the rest", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-1");
			for (let index = 0; index < 60; index += 1) progress(bus, "run-1", delta(`line ${index}\n`));
			const rendered = card(store.rows()[0] as DispatchBoardRow, { expanded: true });
			ok(/\d+ more lines/.test(rendered), rendered);
			ok(rendered.includes("/view dispatch:run-1"), rendered);
		} finally {
			store.unsubscribe();
		}
	});

	it("holds the frame at narrow widths without clipping past the border", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-1");
			progress(bus, "run-1", {
				type: "clio_tool_start",
				payload: { tool: "bash", action: { verb: "running", object: "npm run typecheck --workspace packages/core" } },
			});
			progress(bus, "run-1", delta("a fairly long sentence that will certainly need wrapping at 40 columns\n"));
			const row = store.rows()[0] as DispatchBoardRow;
			for (const width of [40, 52, 76]) {
				const lines = renderDispatchCard(row, width, undefined, { expanded: true }).map(stripSgr);
				for (const line of lines) {
					ok(line.length <= width, `width ${width} produced a ${line.length} column row: ${line}`);
				}
			}
		} finally {
			store.unsubscribe();
		}
	});

	it("neutralizes a hostile answer tail before it reaches the frame", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-1");
			progress(bus, "run-1", delta(`${ESC}[2J${ESC}]0;pwned${String.fromCharCode(7)}innocent text`));
			const rendered = renderDispatchCard(store.rows()[0] as DispatchBoardRow, 76, undefined, {
				expanded: true,
			}).join("\n");
			ok(!stripSgr(rendered).includes(`${ESC}[2J`), JSON.stringify(rendered));
			ok(!rendered.includes("pwned"), JSON.stringify(rendered));
		} finally {
			store.unsubscribe();
		}
	});
});

describe("fleet runs detail control", () => {
	it("opens and closes detail on the operator's key, and follows the cursor", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-a", "scout-a");
			started(bus, "run-b", "scout-b");
			progress(bus, "run-a", delta("alpha prose"), "scout-a");
			progress(bus, "run-b", delta("beta prose"), "scout-b");
			const view = createDispatchBoardView(
				() => store.rows(),
				() => undefined,
			);
			strictEqual(view.detailExpanded(), false);
			const before = stripSgr(view.render(76).join("\n"));
			ok(!before.includes("alpha prose") && !before.includes("beta prose"), before);

			const routed = routeDispatchBoardOverlayKey("\r", {
				closeOverlay: () => {},
				selectPreviousDispatch: () => view.selectPrevious(),
				selectNextDispatch: () => view.selectNext(),
				steerSelectedDispatch: () => {},
				cancelSelectedDispatch: () => {},
				toggleSelectedDispatchDetail: () => view.toggleDetail(),
			});
			strictEqual(routed, true);
			strictEqual(view.detailExpanded(), true);

			const first = view.selectedRow()?.runId;
			const opened = stripSgr(view.render(76).join("\n"));
			ok(opened.includes(first === "run-a" ? "alpha prose" : "beta prose"), opened);

			view.selectNext();
			notStrictEqual(view.selectedRow()?.runId, first);
			const moved = stripSgr(view.render(76).join("\n"));
			ok(moved.includes(first === "run-a" ? "beta prose" : "alpha prose"), moved);
			ok(!moved.includes(first === "run-a" ? "alpha prose" : "beta prose"), moved);

			view.toggleDetail();
			ok(!stripSgr(view.render(76).join("\n")).includes("beta prose"));
		} finally {
			store.unsubscribe();
		}
	});

	it("never reconstructs live progress on replay", () => {
		// Action descriptors and tool names are live telemetry. A receipt seals a
		// call count, not a list, so a resumed block draws its body from the
		// receipt and carries no progress state a fold would have produced.
		const entries = workerEntriesFromRunEntries(
			[
				{
					kind: "workerRun",
					assignmentId: "assignment-1",
					runId: "run-1",
					origin: "user",
					agentId: "coder",
					runtime: { kind: "clio", targetId: "default", wireModelId: "model" },
				} as never,
			],
			() => ({ outcome: "succeeded", text: "the sealed answer", toolCalls: 3 }),
		);
		const entry = entries.get("assignment-1");
		strictEqual(entry?.text, "the sealed answer");
		deepStrictEqual(entry?.tools, []);
		strictEqual(entry?.pending, false);
		strictEqual(entry?.receipt?.toolCalls, 3);
	});

	it("closes detail when the board resets its selection", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		try {
			started(bus, "run-1");
			const view = createDispatchBoardView(
				() => store.rows(),
				() => undefined,
			);
			view.toggleDetail();
			strictEqual(view.detailExpanded(), true);
			view.resetSelection();
			strictEqual(view.detailExpanded(), false);
		} finally {
			store.unsubscribe();
		}
	});
});
