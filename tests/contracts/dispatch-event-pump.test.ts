import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkerOutputCapture, startDispatchEventPump } from "../../src/domains/dispatch/event-pump.js";
import { assistantTextFromEvent } from "../../src/tools/dispatch.js";

describe("contracts/dispatch event pump", () => {
	it("does not misclassify a tool-use planning preamble as final worker output", () => {
		const capture = createWorkerOutputCapture();
		capture.observe({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "text", text: "Let me do a few final targeted reads:" },
					{ type: "toolCall", name: "read", arguments: { path: "src/index.ts" } },
				],
			},
		});
		strictEqual(capture.snapshot(), undefined);
		strictEqual(
			assistantTextFromEvent({
				type: "message_end",
				message: { role: "assistant", stopReason: "toolUse", content: "Let me do a few final targeted reads:" },
			}),
			"",
			"the parent dispatch summary must reject the same preamble",
		);
	});

	it("captures only the later normal text synthesis as final", () => {
		const capture = createWorkerOutputCapture();
		capture.observe({
			type: "message_end",
			message: { role: "assistant", stopReason: "toolUse", content: "I will read more." },
		});
		capture.observe({
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: "Grounded result at src/index.ts:12." },
		});
		deepStrictEqual(capture.snapshot(), {
			state: "final",
			text: "Grounded result at src/index.ts:12.",
			bytes: 35,
			truncated: false,
		});
	});

	it("accepts provider terminal spellings but rejects structured calls and failures", () => {
		const capture = createWorkerOutputCapture();
		capture.observe({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [
					{ type: "text", text: "not final" },
					{ type: "toolCall", name: "read", arguments: { path: "src/index.ts" } },
				],
			},
		});
		capture.observe({
			type: "message_end",
			message: { role: "assistant", stopReason: "error", content: "provider failed" },
		});
		capture.observe({
			type: "message_end",
			message: { role: "assistant", stopReason: "end_turn", content: "WINNER: 2" },
		});
		deepStrictEqual(capture.snapshot(), {
			state: "final",
			text: "WINNER: 2",
			bytes: 9,
			truncated: false,
		});
		strictEqual(
			assistantTextFromEvent({
				type: "message_end",
				message: { role: "assistant", stopReason: "end_turn", content: "WINNER: 2" },
			}),
			"WINNER: 2",
		);
	});

	it("publishes each prelude and source event once while folding source events once", async () => {
		const folded: unknown[] = [];
		const published: unknown[] = [];
		const prelude = { type: "route_warning" };
		const sourceEvents = [{ type: "message_update" }, { type: "message_end" }];
		const pump = startDispatchEventPump(
			(async function* () {
				for (const event of sourceEvents) yield event;
			})(),
			(event) => folded.push(event),
			{ prelude: [prelude], onEvent: (event) => published.push(event) },
		);
		const replayed: unknown[] = [];
		for await (const event of pump.events) replayed.push(event);
		await pump.done;
		deepStrictEqual(folded, sourceEvents);
		deepStrictEqual(published, [prelude, ...sourceEvents]);
		deepStrictEqual(replayed, [prelude, ...sourceEvents]);
	});
});
