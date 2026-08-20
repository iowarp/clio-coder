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

	it("treats raw text/thinking wrappers as transparent so they cannot defeat the coalesce window", () => {
		const applied: string[] = [];
		const timers = new Map<number, () => void>();
		const cleared: number[] = [];
		let nextTimer = 1;
		let renders = 0;
		const renderer = createCoalescingChatRenderer({
			chatPanel: {
				applyEvent: (event: ChatLoopEvent) => {
					applied.push(event.type);
				},
			} as unknown as ChatPanel,
			requestRender: () => {
				renders += 1;
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

		// The provider stream interleaves each derived delta with the raw
		// wrapper that precedes it in turn-runtime's fan-out. The wrapper must
		// neither reach the panel nor cancel the pending display frame.
		const wrapper = (innerType: string): ChatLoopEvent =>
			({
				type: "message_update",
				assistantMessageEvent: { type: innerType, delta: "x" },
			}) as unknown as ChatLoopEvent;
		renderer.applyEvent(wrapper("text_delta"));
		renderer.applyEvent({ type: "text_delta", contentIndex: 0, delta: "hel", partialText: "hel" } as ChatLoopEvent);
		renderer.applyEvent(wrapper("text_delta"));
		renderer.applyEvent({ type: "text_delta", contentIndex: 0, delta: "lo", partialText: "hello" } as ChatLoopEvent);
		renderer.applyEvent(wrapper("thinking_delta"));

		deepStrictEqual(applied, ["text_delta", "text_delta"], "wrappers never reach the panel");
		strictEqual(timers.size, 1, "the coalesce window survives interleaved wrappers");
		deepStrictEqual(cleared, [], "no wrapper cancelled the pending frame");
		strictEqual(renders, 0, "no wrapper forced an immediate render");

		// A wrapper carrying tool-call formation keeps today's synchronous path.
		renderer.applyEvent(wrapper("toolcall_start"));
		deepStrictEqual(applied, ["text_delta", "text_delta", "message_update"]);
		strictEqual(renders, 1, "tool-call formation still renders synchronously");
		strictEqual(timers.size, 0, "and it flushes the pending display frame");
	});

	it("carries the canonical ingress sequence through queue and panel application", () => {
		const log: string[] = [];
		const event: ChatLoopEvent = { type: "text_delta", contentIndex: 0, delta: "x", partialText: "x" };
		const renderer = createCoalescingChatRenderer({
			chatPanel: {
				applyEvent: () => log.push("panel:apply"),
			} as unknown as ChatPanel,
			requestRender: () => {},
			visibleEventSequence: (candidate) => (candidate === event ? 17 : null),
			onQueue: (sequence, action) => log.push(`queue:${action}:${sequence}`),
			onPanelApplied: (sequence) => log.push(`panel:high-water:${sequence}`),
			setTimer: () => 1,
		});

		renderer.applyEvent(event);

		deepStrictEqual(log, ["queue:admit:17", "panel:apply", "panel:high-water:17", "queue:dequeue:17"]);
	});
});
