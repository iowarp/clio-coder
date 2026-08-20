import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import type { ChatPanel } from "../../src/interactive/chat-panel.js";
import { createCoalescingChatRenderer } from "../../src/interactive/chat-renderer.js";

describe("contracts/chat renderer coalescing", () => {
	it("coalesces cumulative Pi tool updates into display frames and renders settlement immediately", () => {
		const applied: string[] = [];
		const timers = new Map<number, () => void>();
		const cleared: number[] = [];
		let nextTimer = 1;
		let renders = 0;
		let deltas = 0;
		const renderer = createCoalescingChatRenderer({
			chatPanel: {
				applyEvent: (event: ChatLoopEvent) => {
					applied.push(event.type);
				},
			} as unknown as ChatPanel,
			requestRender: () => {
				renders += 1;
			},
			onDelta: () => {
				deltas += 1;
			},
			setTimer: (callback) => {
				const id = nextTimer++;
				timers.set(id, callback);
				return id;
			},
			clearTimer: (id) => {
				const timer = id as number;
				cleared.push(timer);
				timers.delete(timer);
			},
		});

		const update = (text: string): ChatLoopEvent =>
			({
				type: "tool_execution_update",
				toolCallId: "tool-1",
				toolName: "bash",
				partialResult: { content: [{ type: "text", text }] },
			}) as ChatLoopEvent;
		renderer.applyEvent(update("one"));
		renderer.applyEvent(update("one\ntwo"));

		deepStrictEqual(applied, ["tool_execution_update", "tool_execution_update"]);
		strictEqual(timers.size, 1, "rapid cumulative snapshots share one display frame");
		strictEqual(renders, 0);
		strictEqual(deltas, 2);

		renderer.applyEvent({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "one\ntwo" }] },
			isError: false,
		} as ChatLoopEvent);
		strictEqual(timers.size, 0);
		deepStrictEqual(cleared, [1]);
		strictEqual(renders, 1, "the settled result bypasses the coalesce delay");
	});
});
