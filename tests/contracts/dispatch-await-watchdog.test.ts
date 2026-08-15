/**
 * Issue #54: the await-watchdog measured the orchestrator's own silence while a
 * worker streamed, and reported "no progress for 1m30s" about a run that was
 * emitting thousands of events. Worker stream evidence is the turn's progress.
 */

import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { ChatLoop, ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { createStatusController } from "../../src/interactive/status/controller.js";
import { resolveInlineVerb } from "../../src/interactive/status/verbs.js";

function harness() {
	const bus = createSafeEventBus();
	let clock = 1_000_000;
	let chatListener: ((event: ChatLoopEvent) => void) | null = null;
	let tick: (() => void) | null = null;
	const chat = {
		onEvent(handler: (event: ChatLoopEvent) => void) {
			chatListener = handler;
			return () => {
				chatListener = null;
			};
		},
		getSessionId: () => "orchestrator-run",
	} as unknown as ChatLoop;
	const controller = createStatusController({
		chat,
		providers: { list: () => [] } as unknown as ProvidersContract,
		bus,
		now: () => clock,
		setInterval: (listener) => {
			tick = listener;
			return 0;
		},
		clearInterval: () => {},
		setTimeout: () => 0,
		clearTimeout: () => {},
	});
	return {
		bus,
		controller,
		now: () => clock,
		startDispatch(): void {
			chatListener?.({ type: "agent_start", messages: [] } as unknown as ChatLoopEvent);
			bus.emit(BusChannels.DispatchStarted, { runId: "w1", agentId: "scout", agentName: "scout" } as never);
		},
		/** Advance the clock in one-second steps, ticking the watchdog like the real interval does. */
		advance(ms: number, onSecond?: (elapsed: number) => void): void {
			for (let step = 0; step < ms; step += 1000) {
				clock += 1000;
				onSecond?.(step + 1000);
				tick?.();
			}
		},
		streamWorkerEvent(): void {
			bus.emit(BusChannels.DispatchProgress, {
				runId: "w1",
				agentId: "scout",
				event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "…" } },
			} as never);
		},
	};
}

describe("dispatch await-watchdog reads worker stream evidence", () => {
	it("never claims no progress while the worker streams past the tier thresholds", () => {
		const h = harness();
		h.startDispatch();
		// Two minutes of streaming: past tier 3 (90s) and the stuck ceiling (180s
		// is not reached, but tier 3 is what prints the hint).
		h.advance(120_000, () => h.streamWorkerEvent());
		const status = h.controller.current();
		strictEqual(status.phase, "dispatching", "the turn is still awaiting the worker, not stuck");
		strictEqual(status.watchdogTier, 0, `a streaming worker keeps the tier at 0, got ${status.watchdogTier}`);
		const verb = resolveInlineVerb(status, h.now(), 120, 4);
		ok(!verb?.text.includes("no progress"), `no false no-progress hint, got: ${verb?.text}`);
		h.controller.dispose();
	});

	it("still reports no progress when the worker is silent", () => {
		const h = harness();
		h.startDispatch();
		h.advance(120_000);
		const status = h.controller.current();
		strictEqual(status.watchdogTier, 3, `a silent worker still escalates, got ${status.watchdogTier}`);
		const verb = resolveInlineVerb(status, h.now(), 120, 4);
		ok(verb?.text.includes("no progress"), `the silent case keeps its hint, got: ${verb?.text}`);
		h.controller.dispose();
	});

	it("does not accept a heartbeat as worker output", () => {
		for (const event of [
			{ type: "heartbeat_status", status: "stale" },
			{ type: "heartbeat", at: 1 },
		]) {
			const h = harness();
			h.startDispatch();
			h.advance(120_000, () => {
				h.bus.emit(BusChannels.DispatchProgress, { runId: "w1", agentId: "scout", event } as never);
			});
			strictEqual(h.controller.current().watchdogTier, 3, `${event.type} is not evidence the worker ran`);
			h.controller.dispose();
		}
	});

	it("ignores worker progress when no dispatch is in flight", () => {
		const h = harness();
		h.startDispatch();
		h.bus.emit(BusChannels.DispatchCompleted, { runId: "w1", agentId: "scout" } as never);
		h.advance(120_000, () => h.streamWorkerEvent());
		ok(h.controller.current().watchdogTier >= 3, "a stale progress event cannot mask an idle orchestrator");
		h.controller.dispose();
	});
});
