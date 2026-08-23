/**
 * The canonical worker-progress fold: event sequences in, one bounded snapshot
 * out. Both the transcript block and the Fleet Runs board read this projection,
 * so the bounds it promises are asserted here once rather than at each surface.
 */

import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createWorkerProgressFold,
	WORKER_ACTION_TRAIL_LIMIT,
	WORKER_LIVE_TAIL_LINES,
	WORKER_LIVE_TAIL_MAX_BYTES,
	WORKER_PROGRESS_WINDOW_BYTES,
	WORKER_PROGRESS_WINDOW_MS,
	WORKER_TOOL_NAME_LIMIT,
} from "../../src/interactive/worker-progress.js";

function textDelta(delta: string): unknown {
	return { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } };
}

function toolStart(
	tool: string,
	action?: { verb: string; object?: string; truncated?: boolean },
	toolCallId?: string,
): unknown {
	return {
		type: "clio_tool_start",
		payload: {
			tool,
			posture: "operating",
			startedAt: 1,
			...(toolCallId !== undefined ? { toolCallId } : {}),
			...(action ? { action } : {}),
		},
	};
}

function toolFinish(tool: string, toolCallId?: string): unknown {
	return {
		type: "clio_tool_finish",
		payload: {
			tool,
			posture: "operating",
			durationMs: 5,
			outcome: "ok",
			...(toolCallId !== undefined ? { toolCallId } : {}),
		},
	};
}

function messageEnd(text: string): unknown {
	return {
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
	};
}

describe("worker progress projection", () => {
	it("streams assistant deltas into the tail and moves the phase to writing", () => {
		const fold = createWorkerProgressFold();
		ok(fold.observe(textDelta("Hello")));
		ok(fold.observe(textDelta(" there")));
		const snapshot = fold.snapshot();
		strictEqual(snapshot.tailText, "Hello there");
		strictEqual(snapshot.phase, "writing");
		strictEqual(snapshot.settled, false);
	});

	it("reads a top-level text_delta so ACP peers need no separate path", () => {
		const fold = createWorkerProgressFold();
		fold.observe({ type: "text_delta", text: "from a peer" });
		strictEqual(fold.snapshot().tailText, "from a peer");
	});

	it("shows a thinking phase and never the reasoning content", () => {
		const fold = createWorkerProgressFold();
		fold.observe({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret plan" } });
		const snapshot = fold.snapshot();
		strictEqual(snapshot.phase, "thinking");
		strictEqual(snapshot.tailText, "");
		ok(!JSON.stringify(snapshot).includes("secret plan"), JSON.stringify(snapshot));
	});

	it("keeps a worker that emits no text attributable through its actions alone", () => {
		const fold = createWorkerProgressFold();
		fold.observe(toolStart("bash", { verb: "running", object: "npm test" }));
		fold.observe(toolFinish("bash"));
		const snapshot = fold.snapshot();
		strictEqual(snapshot.tailText, "");
		deepStrictEqual(snapshot.toolNames, ["bash"]);
		deepStrictEqual(snapshot.recentActions, [{ tool: "bash", descriptor: { verb: "running", object: "npm test" } }]);
	});
});

describe("worker progress tool activity", () => {
	it("pairs concurrent calls of one tool by id", () => {
		const fold = createWorkerProgressFold();
		fold.observe(toolStart("bash", { verb: "running", object: "npm run lint" }, "bash-1"));
		fold.observe(toolStart("bash", { verb: "running", object: "npm run typecheck" }, "bash-2"));
		fold.observe(toolFinish("bash", "bash-1"));
		let snapshot = fold.snapshot();
		deepStrictEqual(snapshot.recentActions, [
			{ tool: "bash", toolCallId: "bash-1", descriptor: { verb: "running", object: "npm run lint" } },
		]);
		deepStrictEqual(snapshot.currentAction, {
			tool: "bash",
			toolCallId: "bash-2",
			descriptor: { verb: "running", object: "npm run typecheck" },
		});
		strictEqual(snapshot.phase, "tool");

		fold.observe(toolFinish("bash", "bash-2"));
		snapshot = fold.snapshot();
		deepStrictEqual(
			snapshot.recentActions.map((action) => [action.toolCallId, action.descriptor?.object]),
			[
				["bash-2", "npm run typecheck"],
				["bash-1", "npm run lint"],
			],
		);
		strictEqual(snapshot.currentAction, null);
		strictEqual(snapshot.phase, "waiting");
	});

	it("falls back to last-started name matching when ids are absent", () => {
		const fold = createWorkerProgressFold();
		fold.observe(toolStart("read", { verb: "reading", object: "src/first.ts" }));
		fold.observe(toolStart("read", { verb: "reading", object: "src/second.ts" }));
		fold.observe(toolFinish("read"));
		let snapshot = fold.snapshot();
		strictEqual(snapshot.recentActions[0]?.descriptor?.object, "src/second.ts");
		strictEqual(snapshot.currentAction?.descriptor?.object, "src/first.ts");

		// A producer that adds the id only to its finish still uses the legacy
		// name fallback and keeps the start rather than dropping the activity.
		fold.observe(toolFinish("read", "finish-only-id"));
		snapshot = fold.snapshot();
		strictEqual(snapshot.recentActions[0]?.descriptor?.object, "src/first.ts");
		strictEqual(snapshot.currentAction, null);
	});

	it("carries the tool name plus its typed descriptor while the call runs", () => {
		const fold = createWorkerProgressFold();
		fold.observe(toolStart("read", { verb: "reading", object: "src/app.ts" }));
		const snapshot = fold.snapshot();
		strictEqual(snapshot.phase, "tool");
		deepStrictEqual(snapshot.currentAction, { tool: "read", descriptor: { verb: "reading", object: "src/app.ts" } });
	});

	it("keeps the name alone when a runtime emitted no descriptor", () => {
		const fold = createWorkerProgressFold();
		fold.observe(toolStart("legacy_tool"));
		deepStrictEqual(fold.snapshot().currentAction, { tool: "legacy_tool" });
	});

	it("never reads tool_execution_start, whose args are the call's own arguments", () => {
		const fold = createWorkerProgressFold();
		strictEqual(
			fold.observe({
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "bash",
				args: { command: "cat ~/.aws/credentials" },
			}),
			false,
		);
		const snapshot = fold.snapshot();
		strictEqual(snapshot.currentAction, null);
		deepStrictEqual(snapshot.toolNames, []);
		ok(!JSON.stringify(snapshot).includes("credentials"), JSON.stringify(snapshot));
	});

	it("clears the current action on finish and bounds the recent trail", () => {
		const fold = createWorkerProgressFold();
		for (let index = 0; index < WORKER_ACTION_TRAIL_LIMIT + 3; index += 1) {
			fold.observe(toolStart(`tool-${index}`, { verb: "calling", object: `arg-${index}` }));
			fold.observe(toolFinish(`tool-${index}`));
		}
		const snapshot = fold.snapshot();
		strictEqual(snapshot.currentAction, null);
		strictEqual(snapshot.phase, "waiting");
		strictEqual(snapshot.recentActions.length, WORKER_ACTION_TRAIL_LIMIT);
		strictEqual(snapshot.recentActions[0]?.tool, `tool-${WORKER_ACTION_TRAIL_LIMIT + 2}`);
	});

	it("bounds the distinct tool names it names", () => {
		const fold = createWorkerProgressFold();
		for (let index = 0; index < WORKER_TOOL_NAME_LIMIT + 5; index += 1) {
			fold.observe(toolStart(`tool-${index}`));
		}
		strictEqual(fold.snapshot().toolNames.length, WORKER_TOOL_NAME_LIMIT);
	});
});

describe("worker progress bounds", () => {
	it("keeps the newest lines and counts what the line bound dropped", () => {
		const fold = createWorkerProgressFold();
		const lines = WORKER_LIVE_TAIL_LINES + 10;
		for (let index = 0; index < lines; index += 1) fold.observe(textDelta(`line ${index}\n`));
		const snapshot = fold.snapshot();
		// The trailing newline leaves an empty final line, so the tail holds the
		// bound exactly and the head lost the rest.
		strictEqual(snapshot.tailText.split("\n").length, WORKER_LIVE_TAIL_LINES);
		strictEqual(snapshot.droppedLines, lines + 1 - WORKER_LIVE_TAIL_LINES);
		ok(snapshot.tailText.includes(`line ${lines - 1}`), snapshot.tailText);
	});

	it("holds the byte bound against few but enormous lines", () => {
		const fold = createWorkerProgressFold();
		for (let index = 0; index < 8; index += 1) fold.observe(textDelta(`${"x".repeat(2000)}\n`));
		const snapshot = fold.snapshot();
		ok(
			Buffer.byteLength(snapshot.tailText, "utf8") <= WORKER_LIVE_TAIL_MAX_BYTES,
			String(Buffer.byteLength(snapshot.tailText, "utf8")),
		);
		ok(snapshot.droppedLines > 0);
	});

	it("holds the byte bound against a single line larger than the whole tail", () => {
		const fold = createWorkerProgressFold();
		fold.observe(textDelta("y".repeat(WORKER_LIVE_TAIL_MAX_BYTES * 3)));
		const snapshot = fold.snapshot();
		strictEqual(Buffer.byteLength(snapshot.tailText, "utf8"), WORKER_LIVE_TAIL_MAX_BYTES);
		ok(snapshot.droppedBytes > 0);
	});

	it("refuses delta bytes past the rate window and says how many", () => {
		const fold = createWorkerProgressFold();
		const chunk = "z".repeat(4096);
		let accepted = 0;
		for (let index = 0; index < 12; index += 1) {
			if (fold.observe(textDelta(chunk), 1_000)) accepted += 1;
		}
		ok(accepted * 4096 <= WORKER_PROGRESS_WINDOW_BYTES, String(accepted));
		ok(fold.snapshot().droppedBytes > 0);
		// The next window opens the budget again.
		ok(fold.observe(textDelta(chunk), 1_000 + WORKER_PROGRESS_WINDOW_MS));
	});

	it("bounds a tail assembled from multi-byte characters on a character boundary", () => {
		const fold = createWorkerProgressFold();
		fold.observe(textDelta("é".repeat(WORKER_LIVE_TAIL_MAX_BYTES)));
		const tail = fold.snapshot().tailText;
		ok(Buffer.byteLength(tail, "utf8") <= WORKER_LIVE_TAIL_MAX_BYTES);
		ok(!tail.includes("�"), "the head cut split a character");
	});
});

describe("worker progress settlement and attempts", () => {
	it("replaces the provisional tail with the receipt-sealed answer", () => {
		const fold = createWorkerProgressFold();
		fold.observe(textDelta("partial draft"));
		fold.settle("the sealed answer");
		const snapshot = fold.snapshot();
		strictEqual(snapshot.tailText, "the sealed answer");
		strictEqual(snapshot.settled, true);
		strictEqual(snapshot.phase, "settled");
		strictEqual(snapshot.currentAction, null);
	});

	it("falls back to the durable message_end when no receipt could be read", () => {
		const fold = createWorkerProgressFold();
		fold.observe(textDelta("streamed tail"));
		fold.observe(messageEnd("durable answer"));
		strictEqual(fold.durableText(), "durable answer");
		fold.settle();
		strictEqual(fold.snapshot().tailText, "durable answer");
	});

	it("keeps the live tail when the run produced no durable answer at all", () => {
		const fold = createWorkerProgressFold();
		fold.observe(textDelta("all it ever said"));
		fold.settle();
		strictEqual(fold.snapshot().tailText, "all it ever said");
	});

	it("takes no further progress once settled", () => {
		const fold = createWorkerProgressFold();
		fold.settle("final");
		strictEqual(fold.observe(textDelta(" late straggler")), false);
		strictEqual(fold.snapshot().tailText, "final");
	});

	it("hands a retry the history and drops the finished attempt's live state", () => {
		const fold = createWorkerProgressFold();
		fold.observe(textDelta("first attempt output"));
		fold.observe(toolStart("bash", { verb: "running", object: "npm test" }));
		fold.settle();
		fold.restart();
		const snapshot = fold.snapshot();
		strictEqual(snapshot.settled, false);
		strictEqual(snapshot.phase, "starting");
		strictEqual(snapshot.currentAction, null);
		ok(snapshot.tailText.includes("first attempt output"));
		ok(fold.observe(textDelta(" plus the retry")));
	});

	it("never settles a retry on the answer the previous attempt sealed", () => {
		const fold = createWorkerProgressFold();
		fold.observe(messageEnd("the first attempt's answer"));
		fold.settle();
		fold.restart();
		strictEqual(fold.durableText(), "");
		// The tail is history the operator is already reading and carries over; the
		// previous attempt's durable answer does not, so a retry that produces
		// nothing durable settles on its own tail rather than on attempt one's.
		fold.observe(textDelta("\nthe retry got this far"));
		fold.settle();
		const tail = fold.snapshot().tailText;
		ok(tail.endsWith("the retry got this far"), tail);
	});
});

describe("worker progress redraw discipline", () => {
	it("changes its revision only when a visible field changes", () => {
		const fold = createWorkerProgressFold();
		const before = fold.snapshot();
		strictEqual(fold.observe({ type: "heartbeat_status", status: "alive" }), false);
		strictEqual(fold.snapshot().revision, before.revision);
		ok(fold.observe(textDelta("visible")));
		notStrictEqual(fold.snapshot().revision, before.revision);
	});

	it("returns the same snapshot object until something changes", () => {
		const fold = createWorkerProgressFold();
		fold.observe(textDelta("stable"));
		const first = fold.snapshot();
		strictEqual(fold.snapshot(), first);
		fold.observe(textDelta("!"));
		notStrictEqual(fold.snapshot(), first);
	});
});
