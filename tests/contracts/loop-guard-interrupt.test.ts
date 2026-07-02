import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels, type LoopBlockedPayload, type ToolBudgetExceededPayload } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { ChatCancelOptions } from "../../src/interactive/chat-loop.js";
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
