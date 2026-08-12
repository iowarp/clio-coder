import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels, type LoopBlockedPayload, type ToolBudgetExceededPayload } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { ChatCancelOptions } from "../../src/interactive/chat-loop.js";
import { noticeMessage } from "../../src/interactive/chat-loop-messages.js";
import { subscribeLoopGuardStop } from "../../src/interactive/loop-guard-interrupt.js";

function captureChat(): { calls: ChatCancelOptions[]; cancel(options?: ChatCancelOptions): void } {
	const calls: ChatCancelOptions[] = [];
	return {
		calls,
		cancel(options?: ChatCancelOptions) {
			calls.push(options ?? {});
		},
	};
}

const loopBlocked = (interrupted: boolean): LoopBlockedPayload => ({
	tool: "context",
	repeatCount: 3,
	blocksThisTurn: interrupted ? 2 : 1,
	budget: 2,
	interrupted,
	disposition: interrupted ? "stop" : "block",
	at: 1,
	turnId: "t1",
});

const loopLockout = (): LoopBlockedPayload => ({
	tool: "context",
	repeatCount: 3,
	blocksThisTurn: 2,
	budget: 2,
	interrupted: false,
	disposition: "lockout",
	at: 1,
	turnId: "t1",
});

const budgetExceeded = (interrupted: boolean): ToolBudgetExceededPayload => ({
	tool: "grep",
	callsThisTurn: interrupted ? 40 : 25,
	softBudget: 25,
	hardCeiling: 40,
	interrupted,
	at: 1,
	turnId: "t1",
});

describe("contracts/loop-guard-interrupt operatorless stop", () => {
	it("stops the turn with a loop_guard cancel on an identical-call interrupt", () => {
		const bus = createSafeEventBus();
		const chat = captureChat();
		subscribeLoopGuardStop(bus, chat);
		bus.emit(BusChannels.LoopBlocked, loopBlocked(true));
		strictEqual(chat.calls.length, 1);
		strictEqual(chat.calls[0]?.source, "loop_guard");
		ok(chat.calls[0]?.reason?.includes("context"), "reason names the looping tool");
		ok(chat.calls[0]?.reason?.includes("loop guard stopped this turn"), "reason states the stop");
		strictEqual(chat.calls[0]?.auditReason, "loop: context repeated 3x");
	});

	it("stops the turn with a loop_guard cancel on a tool-call ceiling interrupt", () => {
		const bus = createSafeEventBus();
		const chat = captureChat();
		subscribeLoopGuardStop(bus, chat);
		bus.emit(BusChannels.ToolBudgetExceeded, budgetExceeded(true));
		strictEqual(chat.calls.length, 1);
		strictEqual(chat.calls[0]?.source, "loop_guard");
		ok(chat.calls[0]?.reason?.includes("per-turn ceiling"), "reason names the ceiling");
		strictEqual(chat.calls[0]?.auditReason, "tool-call ceiling: 40 calls");
	});

	it("ignores non-interrupt blocks so individual blocked calls do not abort the run", () => {
		const bus = createSafeEventBus();
		const chat = captureChat();
		subscribeLoopGuardStop(bus, chat);
		bus.emit(BusChannels.LoopBlocked, loopBlocked(false));
		bus.emit(BusChannels.ToolBudgetExceeded, budgetExceeded(false));
		strictEqual(chat.calls.length, 0, "warn-level blocks do not stop the run");
	});

	it("does not cancel on a synthesis lockout so the model can answer from what it gathered", () => {
		const bus = createSafeEventBus();
		const chat = captureChat();
		subscribeLoopGuardStop(bus, chat);
		bus.emit(BusChannels.LoopBlocked, loopLockout());
		strictEqual(chat.calls.length, 0, "a lockout leaves the turn running; only the backstop stop cancels");
	});

	it("stops firing after unsubscribe", () => {
		const bus = createSafeEventBus();
		const chat = captureChat();
		const unsubscribe = subscribeLoopGuardStop(bus, chat);
		unsubscribe();
		bus.emit(BusChannels.LoopBlocked, loopBlocked(true));
		bus.emit(BusChannels.ToolBudgetExceeded, budgetExceeded(true));
		strictEqual(chat.calls.length, 0, "no cancels after unsubscribe");
	});
});

/**
 * The durable record a cancelled run leaves behind.
 *
 * Both the operator cancel and the loop guard persist one closing assistant
 * turn through `noticeMessage`. It carries no `usage`, because no model call
 * completed, and it was written with `stopReason: "stop"`.
 *
 * The engine's context estimator, `getLastAssistantUsageInfo` in
 * `@earendil-works/pi-ai/dist/utils/estimate.js`, skips assistant messages
 * marked `aborted` or `error` and then dereferences `usage.totalTokens` on
 * every other one. That guard encodes the contract: an assistant turn either
 * carries usage or is marked as one of those two. Labelling a cancelled turn
 * `stop` broke both halves at once.
 *
 * The process that cancelled never saw it, because it does not re-read the
 * record it just wrote. Reconstruction from disk did, and the estimate runs
 * inside `clampMaxTokensToContext` before any network call, so every turn in
 * the resumed session died in tens of milliseconds with a raw TypeError and
 * went on doing so until the session was abandoned.
 */
describe("contracts/cancelled turn persistence", () => {
	it("marks the closing turn aborted, so a later read does not have to guess", () => {
		const message = noticeMessage("[Clio Coder] active response cancelled.") as {
			role: string;
			stopReason?: string;
			usage?: unknown;
		};
		strictEqual(message.role, "assistant");
		strictEqual(message.usage, undefined, "no model call completed, so there is no usage to record");
		// The estimator dereferences usage on anything that is not one of these.
		ok(
			message.stopReason === "aborted" || message.stopReason === "error",
			`an assistant turn with no usage must not claim it stopped normally, got ${String(message.stopReason)}`,
		);
	});

	it("says the same thing to the reader as it does to the estimator", () => {
		// `/tree` renders this node as the cancellation text while the persisted
		// stopReason said the turn stopped normally. One event, two accounts.
		const text = "[Clio Coder] active response cancelled.";
		const message = noticeMessage(text) as { content?: Array<{ text?: string }>; stopReason?: string };
		strictEqual(message.content?.[0]?.text, text);
		strictEqual(message.stopReason, "aborted", "the display and the record agree that it was cancelled");
	});
});
