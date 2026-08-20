import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { AgentMessage } from "../../src/engine/types.js";
import type { ChatLoop, ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { createStatusController } from "../../src/interactive/status/controller.js";
import { type ReduceContext, reduceStatus, type StatusInputEvent } from "../../src/interactive/status/state-machine.js";
import { buildSummary } from "../../src/interactive/status/summary.js";
import { INITIAL_STATUS } from "../../src/interactive/status/types.js";

// Regression for the v0.2.8 demo session: a loop-guard abort ended a turn that
// had consumed millions of tokens across dozens of tool rounds, yet the footer
// showed "up 0 down 0" and "tools none". run_aborted stamps an empty summary
// immediately (correct: the run has not settled), but the agent_end that
// follows must rebuild the summary from the run's real message window and keep
// the abort provenance run_aborted stamped.

function ctx(now: number): ReduceContext {
	return { now, localRuntime: true, modelId: "m", targetId: "t", runId: "r" };
}

describe("contracts/status aborted runs keep usage and abort provenance", () => {
	it("publishes the corrected terminal usage after a rapid abort settlement", () => {
		let now = 1_000;
		const chatListeners: Array<(event: ChatLoopEvent) => void> = [];
		const chat = {
			getSessionId: () => "session-1",
			onEvent: (listener: (event: ChatLoopEvent) => void) => {
				chatListeners.push(listener);
				return () => {};
			},
		} as unknown as ChatLoop;
		const bus = createSafeEventBus();
		const controller = createStatusController({
			chat,
			bus,
			providers: { list: () => [] } as unknown as ProvidersContract,
			now: () => now,
			setInterval: () => Symbol("interval"),
			clearInterval: () => {},
			setTimeout: () => Symbol("timeout"),
			clearTimeout: () => {},
		});
		const delivered: Array<{ inputTokens: number; outputTokens: number }> = [];
		controller.subscribe((status) => {
			if (status.phase === "ended" && status.summary) {
				delivered.push({ inputTokens: status.summary.inputTokens, outputTokens: status.summary.outputTokens });
			}
		});
		const emit = (event: ChatLoopEvent): void => {
			for (const listener of chatListeners) listener(event);
		};

		try {
			emit({ type: "agent_start" } as ChatLoopEvent);
			now = 47_000;
			bus.emit(BusChannels.RunAborted, {
				source: "stream_cancel",
				runId: null,
				startedAt: null,
				elapsedMs: null,
				at: now,
				reason: "user cancelled stream",
			});
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "partial" }],
					stopReason: "aborted",
					usage: { input: 16_279, output: 10, cacheRead: 0, cacheWrite: 0 },
				},
			} as unknown as ChatLoopEvent);
			emit({
				type: "agent_end",
				messages: [{ role: "assistant", content: [], stopReason: "aborted", usage: {} }],
			} as unknown as ChatLoopEvent);

			strictEqual(controller.current().summary?.inputTokens, 16_279);
			strictEqual(controller.current().summary?.outputTokens, 10);
			strictEqual(delivered.at(-1)?.inputTokens, 16_279, "the footer subscriber receives the reconciled receipt");
			strictEqual(delivered.at(-1)?.outputTokens, 10);
		} finally {
			controller.dispose();
		}
	});

	it("preserves a provider-reported zero and labels a mixed reasoning total", () => {
		const base = {
			startedAt: 0,
			endedAt: 1,
			modelId: "m",
			targetId: "t",
			watchdogPeak: 0 as const,
			cancelled: false,
		};
		const providerZero = buildSummary({
			...base,
			messages: [
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "provider reported no hidden tokens" }],
					usage: { reasoningTokens: 0 },
				},
			] as unknown as ReadonlyArray<AgentMessage>,
		});
		strictEqual(providerZero.reasoningTokens, 0);
		strictEqual(providerZero.reasoningTokenProvenance, "provider");

		const mixed = buildSummary({
			...base,
			messages: [
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "provider turn" }],
					usage: { reasoningTokens: 0 },
				},
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "unreported turn with enough text to estimate" }],
				},
			] as unknown as ReadonlyArray<AgentMessage>,
		});
		strictEqual(mixed.reasoningTokenProvenance, "mixed");
		ok((mixed.reasoningTokens ?? 0) > 0, "the unreported thinking block contributes an estimate");
	});

	it("the settled agent_end after run_aborted carries the run's usage and keeps stopDetail", () => {
		let status = { ...INITIAL_STATUS };
		status = reduceStatus(status, { type: "agent_start", messages: [] } as unknown as StatusInputEvent, ctx(0));
		status = reduceStatus(
			status,
			{ type: "run_aborted", source: "loop_guard", reason: "loop: context repeated 4x" } as StatusInputEvent,
			ctx(120_000),
		);
		strictEqual(status.phase, "ended");
		strictEqual(status.summary?.inputTokens, 0, "the immediate abort summary has no usage yet");
		ok(status.summary?.stopDetail?.includes("loop guard"), "abort provenance is stamped");

		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "gathering" }],
				stopReason: "toolUse",
				usage: { input: 52_000, output: 900, cacheRead: 0, cacheWrite: 0 },
			},
			{ role: "toolResult", isError: false, content: [] },
			{
				role: "assistant",
				content: [],
				stopReason: "aborted",
				errorMessage: "Request was aborted",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		];
		status = reduceStatus(status, { type: "agent_end", messages } as unknown as StatusInputEvent, ctx(146_000));
		strictEqual(status.phase, "ended");
		strictEqual(status.summary?.inputTokens, 52_000, "the run's real input tokens replace the empty abort summary");
		strictEqual(status.summary?.outputTokens, 900);
		strictEqual(status.summary?.toolCount, 1, "tool results in the window are counted");
		strictEqual(status.summary?.stopReason, "aborted");
		ok(status.summary?.stopDetail?.includes("loop guard"), "abort provenance survives the rebuild");
	});

	// The test above passes because it hands agent_end a real message window.
	// Live, the engine replaces an aborted run's window with one synthetic
	// zero-usage failure message before agent_end is emitted, so the rebuild had
	// nothing to rebuild from. Measured on dynamo: Escape during a bash tool call
	// produced "⊘ 971ms · ↑0 ↓0 · Σ464.3k" on one footer line while the session
	// transcript for that same turn held usage input 64162, output 27. The live
	// tally folded from message_end is the record that survives.
	it("reports the run's usage when the engine hands agent_end a synthetic empty window", () => {
		let status = { ...INITIAL_STATUS };
		status = reduceStatus(status, { type: "agent_start", messages: [] } as unknown as StatusInputEvent, ctx(0));

		const settled = [
			{
				role: "assistant",
				content: [{ type: "text", text: "" }],
				stopReason: "toolUse",
				usage: { input: 64_162, output: 27, cacheRead: 0, cacheWrite: 0 },
			},
			{ role: "toolResult", isError: false, content: [] },
		];
		for (const message of settled) {
			status = reduceStatus(status, { type: "message_end", message } as unknown as StatusInputEvent, ctx(1_000));
		}

		status = reduceStatus(
			status,
			{ type: "run_aborted", source: "stream_cancel", reason: "user cancelled stream" } as StatusInputEvent,
			ctx(3_400),
		);
		strictEqual(status.phase, "ended");
		strictEqual(status.summary?.inputTokens, 64_162, "the cancel reports what the run settled, not zero");
		strictEqual(status.summary?.outputTokens, 27);
		strictEqual(status.summary?.toolCount, 1);
		strictEqual(status.summary?.stopReason, "cancelled");

		// The engine's post-abort window: one synthetic zero-usage message.
		status = reduceStatus(
			status,
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted", usage: {} },
				],
			} as unknown as StatusInputEvent,
			ctx(3_500),
		);
		strictEqual(status.summary?.inputTokens, 64_162, "agent_end must not zero what the tally already saw");
		strictEqual(status.summary?.outputTokens, 27);
		strictEqual(status.summary?.toolCount, 1);
		ok(status.summary?.stopDetail?.includes("stream cancel"), "abort provenance survives");
	});

	it("a later notice message_end does not rebuild or wipe the ended usage summary", () => {
		let status = { ...INITIAL_STATUS };
		status = reduceStatus(status, { type: "agent_start", messages: [] } as unknown as StatusInputEvent, ctx(0));

		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
				usage: { input: 12_345, output: 678, cacheRead: 90, cacheWrite: 0 },
			},
			{ role: "toolResult", isError: false, content: [] },
		];
		status = reduceStatus(status, { type: "agent_end", messages } as unknown as StatusInputEvent, ctx(2_000));
		strictEqual(status.phase, "ended");
		strictEqual(status.summary?.inputTokens, 12_345);
		strictEqual(status.summary?.outputTokens, 678);
		strictEqual(status.summary?.cacheReadTokens, 90);
		strictEqual(status.summary?.toolCount, 1);

		status = reduceStatus(
			status,
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "[Clio Coder] notice after the run" }],
					stopReason: "stop",
				},
			} as unknown as StatusInputEvent,
			ctx(3_000),
		);

		strictEqual(status.phase, "ended");
		strictEqual(status.summary?.inputTokens, 12_345);
		strictEqual(status.summary?.outputTokens, 678);
		strictEqual(status.summary?.cacheReadTokens, 90);
		strictEqual(status.summary?.toolCount, 1);
	});
});
