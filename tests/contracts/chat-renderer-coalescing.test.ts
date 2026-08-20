import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { type ChatPanel, createChatPanel } from "../../src/interactive/chat-panel.js";
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

	it("paces only derived content and drains it atomically before a raw tool boundary", () => {
		const applied: string[] = [];
		const timers = new Map<number, () => void>();
		let timerId = 0;
		let renders = 0;
		let sequence = 0;
		const ingress = new WeakMap<object, { sequence: number; generation: number; ingressAt: number }>();
		const renderer = createCoalescingChatRenderer({
			chatPanel: {
				applyEvent: (event: ChatLoopEvent) =>
					applied.push(
						event.type === "text_delta" || event.type === "thinking_delta" ? `${event.type}:${event.delta}` : event.type,
					),
				isThinkingExpanded: () => false,
			} as unknown as ChatPanel,
			requestRender: () => {
				renders += 1;
			},
			streamIngress: (event) => ingress.get(event) ?? null,
			getSmoothStreamingMode: () => "on",
			setTimer: (callback) => {
				const id = ++timerId;
				timers.set(id, callback);
				return id;
			},
			clearTimer: (id) => void timers.delete(id as number),
			now: () => 0,
		});
		const delta = { type: "text_delta", contentIndex: 0, delta: "A👩‍🔬B", partialText: "A👩‍🔬B" } as ChatLoopEvent;
		ingress.set(delta, { sequence: ++sequence, generation: 1, ingressAt: 0 });
		renderer.applyEvent(delta);
		renderer.applyEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "hidden" },
		} as unknown as ChatLoopEvent);
		strictEqual(applied.length, 0, "admission itself neither mutates nor renders paced visible text");

		renderer.applyEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 1,
				partial: { content: [null, { type: "toolCall", id: "t", name: "read", arguments: {} }] },
			},
		} as unknown as ChatLoopEvent);
		deepStrictEqual(applied, ["text_delta:A👩‍🔬B", "message_update"]);
		strictEqual(renders, 1, "drain plus boundary is one render transaction");
		strictEqual(timers.size, 0);
	});

	it("settles queued graphemes before cumulative state and awaits the final committed frame", async () => {
		const log: string[] = [];
		let sequence = 0;
		const ingress = new WeakMap<object, { sequence: number; generation: number; ingressAt: number }>();
		const renderer = createCoalescingChatRenderer({
			chatPanel: {
				applyEvent: (event: ChatLoopEvent) => log.push(event.type === "text_delta" ? `text:${event.delta}` : event.type),
				isThinkingExpanded: () => false,
			} as unknown as ChatPanel,
			requestRender: () => log.push("render"),
			streamIngress: (event) => ingress.get(event) ?? null,
			getSmoothStreamingMode: () => "on",
			setTimer: () => 1,
			clearTimer: () => {},
			commitFrame: async () => {
				log.push("commit");
			},
		});
		const first = { type: "text_delta", contentIndex: 0, delta: "before", partialText: "before" } as ChatLoopEvent;
		ingress.set(first, { sequence: ++sequence, generation: 1, ingressAt: 0 });
		renderer.applyEvent(first);
		renderer.applyEvent({
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "bash",
			partialResult: { content: [{ type: "text", text: "cumulative" }] },
		} as ChatLoopEvent);
		const last = { type: "text_delta", contentIndex: 2, delta: "after", partialText: "after" } as ChatLoopEvent;
		ingress.set(last, { sequence: ++sequence, generation: 1, ingressAt: 1 });
		renderer.applyEvent(last);
		await renderer.flushAndCommit("message-end");

		deepStrictEqual(
			log.filter((entry) => entry !== "render"),
			["text:before", "tool_execution_update", "text:after", "commit"],
		);
	});

	it("advances canonical panel high-water only after the complete paced ingress is present", () => {
		const applied: string[] = [];
		const highWater: number[] = [];
		const timers = new Map<number, () => void>();
		let timerId = 0;
		const event = { type: "text_delta", contentIndex: 0, delta: "abc", partialText: "abc" } as ChatLoopEvent;
		const renderer = createCoalescingChatRenderer({
			chatPanel: {
				applyEvent: (candidate: ChatLoopEvent) => {
					if (candidate.type === "text_delta") applied.push(candidate.delta);
				},
				isThinkingExpanded: () => true,
			} as unknown as ChatPanel,
			requestRender: () => {},
			streamIngress: (candidate) => (candidate === event ? { sequence: 1, generation: 1, ingressAt: 0 } : null),
			getSmoothStreamingMode: () => "on",
			onPanelApplied: (sequence) => highWater.push(sequence),
			setTimer: (callback) => {
				const id = ++timerId;
				timers.set(id, callback);
				return id;
			},
			clearTimer: (id) => void timers.delete(id as number),
			now: () => 0,
		});

		renderer.applyEvent(event);
		const firstSlice = [...timers.values()][0];
		ok(firstSlice);
		firstSlice();
		deepStrictEqual(applied, ["a"]);
		deepStrictEqual(highWater, [], "a partial synthetic slice cannot claim the complete canonical event");
		renderer.flush();
		deepStrictEqual(applied, ["a", "bc"]);
		deepStrictEqual(highWater, [1]);
	});

	it("drains queued content immediately when a live mode change arrives", () => {
		const applied: string[] = [];
		const timers = new Map<number, () => void>();
		let timerId = 0;
		let configuredMode: "off" | "auto" | "on" = "on";
		const event = { type: "text_delta", contentIndex: 0, delta: "backlog", partialText: "backlog" } as ChatLoopEvent;
		const renderer = createCoalescingChatRenderer({
			chatPanel: {
				applyEvent: (candidate: ChatLoopEvent) => {
					if (candidate.type === "text_delta") applied.push(candidate.delta);
				},
				isThinkingExpanded: () => true,
			} as unknown as ChatPanel,
			requestRender: () => {},
			streamIngress: (candidate) => (candidate === event ? { sequence: 1, generation: 1, ingressAt: 0 } : null),
			getSmoothStreamingMode: () => configuredMode,
			setTimer: (callback) => {
				const id = ++timerId;
				timers.set(id, callback);
				return id;
			},
			clearTimer: (id) => void timers.delete(id as number),
			now: () => 0,
		});

		renderer.applyEvent(event);
		strictEqual(applied.length, 0);
		configuredMode = "off";
		renderer.setSmoothStreamingMode("off");
		deepStrictEqual(applied, ["backlog"]);
		strictEqual(timers.size, 0);
	});

	it("keeps retry and operator-abort settlement behind all earlier visible content", () => {
		const applied: string[] = [];
		let sequence = 0;
		const ingress = new WeakMap<object, { sequence: number; generation: number; ingressAt: number }>();
		const renderer = createCoalescingChatRenderer({
			chatPanel: {
				applyEvent: (event: ChatLoopEvent) =>
					applied.push(event.type === "text_delta" ? `text:${event.delta}` : event.type),
				isThinkingExpanded: () => true,
			} as unknown as ChatPanel,
			requestRender: () => {},
			streamIngress: (event) => ingress.get(event) ?? null,
			getSmoothStreamingMode: () => "on",
			setTimer: () => 1,
			clearTimer: () => {},
		});
		const beforeRetry = {
			type: "text_delta",
			contentIndex: 0,
			delta: "before retry",
			partialText: "before retry",
		} as ChatLoopEvent;
		ingress.set(beforeRetry, { sequence: ++sequence, generation: 1, ingressAt: 0 });
		renderer.applyEvent(beforeRetry);
		renderer.applyEvent({
			type: "retry_status",
			status: { phase: "retrying", attempt: 1, maxAttempts: 2 },
		} as ChatLoopEvent);
		const beforeAbort = {
			type: "text_delta",
			contentIndex: 1,
			delta: "before abort",
			partialText: "before abort",
		} as ChatLoopEvent;
		ingress.set(beforeAbort, { sequence: ++sequence, generation: 1, ingressAt: 1 });
		renderer.applyEvent(beforeAbort);
		renderer.applyEvent({
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
		} as unknown as ChatLoopEvent);

		deepStrictEqual(applied, ["text:before retry", "retry_status", "text:before abort", "agent_end"]);
	});

	it("drops old-session paced content before a reset mutation", () => {
		const applied: string[] = [];
		const queue: string[] = [];
		const panelHighWater: number[] = [];
		let renders = 0;
		const event = { type: "text_delta", contentIndex: 0, delta: "stale", partialText: "stale" } as ChatLoopEvent;
		const renderer = createCoalescingChatRenderer({
			chatPanel: {
				applyEvent: (candidate: ChatLoopEvent) => applied.push(candidate.type),
				isThinkingExpanded: () => false,
			} as unknown as ChatPanel,
			requestRender: () => {
				renders += 1;
			},
			streamIngress: (candidate) => (candidate === event ? { sequence: 1, generation: "old", ingressAt: 0 } : null),
			getSmoothStreamingMode: () => "on",
			onQueue: (sequence, action) => queue.push(`${action}:${sequence}`),
			onPanelApplied: (sequence) => panelHighWater.push(sequence),
			setTimer: () => 1,
			clearTimer: () => {},
		});
		renderer.applyEvent(event);
		renderer.reset(() => applied.push("reset"));
		renderer.flush();
		deepStrictEqual(applied, ["reset"]);
		deepStrictEqual(queue, ["admit:1", "dequeue:1"], "discard balances render-queue trace accounting");
		deepStrictEqual(panelHighWater, [], "discarded state never advances the panel high-water mark");
		strictEqual(renders, 1, "only the replacement state renders");
	});

	it("balances an empty derived delta through the exact legacy path", () => {
		const queue: string[] = [];
		const applied: ChatLoopEvent[] = [];
		const event = { type: "text_delta", contentIndex: 0, delta: "", partialText: "" } as ChatLoopEvent;
		const renderer = createCoalescingChatRenderer({
			chatPanel: {
				applyEvent: (candidate: ChatLoopEvent) => applied.push(candidate),
				isThinkingExpanded: () => true,
			} as unknown as ChatPanel,
			requestRender: () => {},
			streamIngress: (candidate) => (candidate === event ? { sequence: 8, generation: 1, ingressAt: 0 } : null),
			visibleEventSequence: (candidate) => (candidate === event ? 8 : null),
			getSmoothStreamingMode: () => "on",
			onQueue: (sequence, action) => queue.push(`${action}:${sequence}`),
			setTimer: () => 1,
		});

		renderer.applyEvent(event);
		strictEqual(applied.length, 1);
		deepStrictEqual(queue, ["admit:8", "dequeue:8"]);
	});

	it("retains folded thinking in one panel mutation and expands it without pacing invisible graphemes", () => {
		const panel = createChatPanel({ now: () => 0 });
		const timers = new Map<number, () => void>();
		let timerId = 0;
		let sequence = 0;
		const queue: string[] = [];
		const ingress = new WeakMap<object, { sequence: number; generation: number; ingressAt: number }>();
		const renderer = createCoalescingChatRenderer({
			chatPanel: panel,
			requestRender: () => {},
			streamIngress: (event) => ingress.get(event) ?? null,
			getSmoothStreamingMode: () => "on",
			onQueue: (eventSequence, action) => queue.push(`${action}:${eventSequence}`),
			setTimer: (callback) => {
				const id = ++timerId;
				timers.set(id, callback);
				return id;
			},
			clearTimer: (id) => void timers.delete(id as number),
			now: () => 0,
		});
		const text = { type: "text_delta", contentIndex: 0, delta: "visible", partialText: "visible" } as ChatLoopEvent;
		const thinking = {
			type: "thinking_delta",
			contentIndex: 1,
			delta: "private chain retained exactly",
			partialThinking: "private chain retained exactly",
		} as ChatLoopEvent;
		for (const event of [text, thinking]) {
			ingress.set(event, { sequence: ++sequence, generation: 1, ingressAt: 0 });
			renderer.applyEvent(event);
		}

		renderer.mutate(() => panel.toggleLastThinking(), "thinking-visibility");
		const expanded = panel.render(80).join("\n");
		ok(expanded.includes("visible"));
		ok(expanded.includes("private chain retained exactly"), expanded);
		strictEqual(expanded.split("private chain retained exactly").length - 1, 1);
		deepStrictEqual(queue, ["admit:1", "admit:2", "dequeue:1", "dequeue:2"]);
		strictEqual(timers.size, 0, "visibility mutation drains folded state without spending later ticks");
	});
});
