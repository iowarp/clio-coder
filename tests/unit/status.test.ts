import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { createStatusController } from "../../src/interactive/status/controller.js";
import { reduceStatus } from "../../src/interactive/status/state-machine.js";
import { buildSummary } from "../../src/interactive/status/summary.js";
import { INITIAL_STATUS } from "../../src/interactive/status/types.js";
import { resolveFooterVerb } from "../../src/interactive/status/verbs.js";

describe("status/reduceStatus", () => {
	it("idle transitions to preparing on agent_start", () => {
		const next = reduceStatus(INITIAL_STATUS, { type: "agent_start" } as never, {
			now: 100,
			localRuntime: false,
		});
		strictEqual(next.phase, "preparing");
		strictEqual(next.since, 100);
		strictEqual(next.lastMeaningfulAt, 100);
		strictEqual(next.watchdogTier, 0);
	});

	it("preparing transitions to thinking on first thinking_delta", () => {
		const prep = { ...INITIAL_STATUS, phase: "preparing" as const, since: 100, lastMeaningfulAt: 100 };
		const next = reduceStatus(
			prep,
			{ type: "thinking_delta", contentIndex: 0, delta: "hmm", partialThinking: "hmm" },
			{ now: 150, localRuntime: false },
		);
		strictEqual(next.phase, "thinking");
		strictEqual(next.lastMeaningfulAt, 150);
	});

	it("preparing transitions to writing on first text_delta", () => {
		const prep = { ...INITIAL_STATUS, phase: "preparing" as const, since: 100, lastMeaningfulAt: 100 };
		const next = reduceStatus(
			prep,
			{ type: "text_delta", contentIndex: 0, delta: "Hi", partialText: "Hi" },
			{
				now: 1000,
				localRuntime: false,
			},
		);
		strictEqual(next.phase, "writing");
		strictEqual(next.lastMeaningfulAt, 1000);
	});

	it("preparing transitions to tool_running on tool_execution_start", () => {
		const prep = { ...INITIAL_STATUS, phase: "preparing" as const, since: 100, lastMeaningfulAt: 100 };
		const next = reduceStatus(
			prep,
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
			{ now: 1000, localRuntime: false },
		);
		strictEqual(next.phase, "tool_running");
		strictEqual(next.tool?.toolName, "bash");
	});

	it("tool_execution_end clears the running tool phase", () => {
		const tool = {
			...INITIAL_STATUS,
			phase: "tool_running" as const,
			since: 100,
			lastMeaningfulAt: 200,
			tool: { toolName: "bash", toolPreview: "npm test" },
		};
		const next = reduceStatus(
			tool,
			{ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false },
			{ now: 1000, localRuntime: false },
		);
		strictEqual(next.phase, "preparing");
		strictEqual(next.tool, undefined);
		strictEqual(next.lastMeaningfulAt, 1000);
	});

	it("watchdog after tool_execution_end does not claim the tool is still running", () => {
		const tool = {
			...INITIAL_STATUS,
			phase: "tool_running" as const,
			since: 100,
			lastMeaningfulAt: 200,
			tool: { toolName: "bash", toolPreview: "npm test" },
		};
		const done = reduceStatus(
			tool,
			{ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: true },
			{ now: 1000, localRuntime: false },
		);
		const watched = reduceStatus(done, { type: "watchdog_tick" }, { now: 1000 + 90_000, localRuntime: false });
		const footer = resolveFooterVerb(watched, 1000 + 90_000, 120);
		strictEqual(footer?.text.includes("bash"), false);
		strictEqual(footer?.text.includes("still running"), false);
	});

	it("retry_status scheduled pushes retrying overlay with resumePhase", () => {
		const writ = { ...INITIAL_STATUS, phase: "writing" as const, since: 100, lastMeaningfulAt: 500 };
		const next = reduceStatus(
			writ,
			{ type: "retry_status", status: { phase: "scheduled", attempt: 1, maxAttempts: 3, delayMs: 8000 } },
			{ now: 1000, localRuntime: false },
		);
		strictEqual(next.phase, "retrying");
		strictEqual(next.resumePhase, "writing");
		strictEqual(next.retry?.attempt, 1);
	});

	it("retry_status recovered pops to resumePhase", () => {
		const retr = {
			...INITIAL_STATUS,
			phase: "retrying" as const,
			resumePhase: "writing" as const,
			retry: { attempt: 2, maxAttempts: 3, waitMs: 0 },
			since: 100,
			lastMeaningfulAt: 500,
		};
		const next = reduceStatus(
			retr,
			{ type: "retry_status", status: { phase: "recovered", attempt: 2, maxAttempts: 3 } },
			{ now: 1000, localRuntime: false },
		);
		strictEqual(next.phase, "writing");
		strictEqual(next.retry, undefined);
	});

	it("supports overlay stacking in LIFO order", () => {
		const base = { ...INITIAL_STATUS, phase: "writing" as const, since: 100, lastMeaningfulAt: 100 };
		const blocked = reduceStatus(
			base,
			{ type: "overlay_push", overlay: "tool_blocked" },
			{ now: 200, localRuntime: false },
		);
		const retrying = reduceStatus(
			blocked,
			{ type: "retry_status", status: { phase: "scheduled", attempt: 1, maxAttempts: 2, delayMs: 500 } },
			{ now: 300, localRuntime: false },
		);
		strictEqual(retrying.phase, "retrying");
		const popped = reduceStatus(
			retrying,
			{ type: "retry_status", status: { phase: "recovered", attempt: 1, maxAttempts: 2 } },
			{ now: 400, localRuntime: false },
		);
		strictEqual(popped.phase, "tool_blocked");
		const restored = reduceStatus(
			popped,
			{ type: "overlay_pop", overlay: "tool_blocked" },
			{ now: 500, localRuntime: false },
		);
		strictEqual(restored.phase, "writing");
	});

	it("agent_end transitions active phase to ended with summary", () => {
		const writ = { ...INITIAL_STATUS, phase: "writing" as const, since: 100, lastMeaningfulAt: 500 };
		const next = reduceStatus(writ, { type: "agent_end", messages: [] }, { now: 1000, localRuntime: false });
		strictEqual(next.phase, "ended");
		strictEqual(next.summary?.elapsedMs, 900);
	});

	it("agent_end without prior agent_start marks summary truncated", () => {
		const next = reduceStatus(INITIAL_STATUS, { type: "agent_end", messages: [] }, { now: 1000, localRuntime: false });
		strictEqual(next.phase, "ended");
		strictEqual(next.summary?.truncated, true);
	});

	it("watchdog_tick at tier 4 enters stuck preserving resumePhase", () => {
		const think = { ...INITIAL_STATUS, phase: "thinking" as const, since: 100, lastMeaningfulAt: 100 };
		const next = reduceStatus(think, { type: "watchdog_tick" }, { now: 100 + 200_000, localRuntime: false });
		strictEqual(next.phase, "stuck");
		strictEqual(next.resumePhase, "thinking");
		strictEqual(next.watchdogTier, 4);
	});

	it("meaningful event clears stuck and restores progress phase", () => {
		const stuck = {
			...INITIAL_STATUS,
			phase: "stuck" as const,
			resumePhase: "thinking" as const,
			since: 100,
			lastMeaningfulAt: 100,
			watchdogTier: 4 as const,
		};
		const next = reduceStatus(
			stuck,
			{ type: "thinking_delta", contentIndex: 0, delta: "x", partialThinking: "x" },
			{
				now: 1000,
				localRuntime: false,
			},
		);
		strictEqual(next.phase, "thinking");
		strictEqual(next.watchdogTier, 0);
	});
});

describe("status/buildSummary", () => {
	it("computes elapsed, tokens, tool counts from agent_end messages", () => {
		const summary = buildSummary({
			startedAt: 1000,
			endedAt: 8000,
			modelId: "qwen2.5-coder",
			endpointId: "ollama",
			messages: [
				{
					role: "assistant",
					usage: { input: 1200, output: 847, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
				} as never,
				{ role: "toolResult", isError: false } as never,
				{ role: "toolResult", isError: true } as never,
			],
			watchdogPeak: 1,
			cancelled: false,
		});
		strictEqual(summary.elapsedMs, 7000);
		strictEqual(summary.inputTokens, 1200);
		strictEqual(summary.outputTokens, 847);
		strictEqual(summary.toolCount, 2);
		strictEqual(summary.toolErrorCount, 1);
		strictEqual(summary.stopReason, "stop");
	});

	it("surfaces reasoning tokens only when usage exposes them", () => {
		const summary = buildSummary({
			startedAt: 0,
			endedAt: 1,
			modelId: "gpt-5.4-mini",
			endpointId: "openai-codex",
			messages: [
				{
					role: "assistant",
					usage: { input: 10, output: 20, outputDetails: { reasoningTokens: 7 } },
					stopReason: "stop",
				} as never,
				{
					role: "assistant",
					usage: { input: 5, output: 6 },
					stopReason: "stop",
				} as never,
			],
			watchdogPeak: 0,
			cancelled: false,
		});
		strictEqual(summary.reasoningTokens, 7);
	});
});

describe("status/controller", () => {
	it("emits AgentStatusChanged on distinct phase transitions", () => {
		let clock = 0;
		const bus = createSafeEventBus();
		const transitions: unknown[] = [];
		bus.on(BusChannels.AgentStatusChanged, (payload) => {
			transitions.push(payload);
		});
		const chatListeners = new Set<(event: never) => void>();
		const providers = {
			list: () => [],
		} as unknown as ProvidersContract;
		const controller = createStatusController({
			chat: {
				submit: async () => undefined,
				queueFollowUp: () => false,
				clearQueuedFollowUps: () => [],
				queuedMessages: () => ({ followUp: [] }),
				cancel: () => undefined,
				onEvent: (listener) => {
					chatListeners.add(listener as (event: never) => void);
					return () => chatListeners.delete(listener as (event: never) => void);
				},
				getSessionId: () => "session-1",
				isStreaming: () => false,
				contextUsage: () => ({ tokens: null, contextWindow: 0, percent: null }),
				compact: async () => undefined,
				resetForSession: () => undefined,
			},
			providers,
			bus,
			now: () => clock,
			setInterval: () => 0,
			clearInterval: () => undefined,
			setTimeout: () => 0,
			clearTimeout: () => undefined,
		});
		try {
			for (const listener of chatListeners) listener({ type: "agent_start" } as never);
			clock = 10;
			for (const listener of chatListeners) {
				listener({ type: "thinking_delta", contentIndex: 0, delta: "x", partialThinking: "x" } as never);
			}
			deepStrictEqual(
				transitions.map((p) => (p as { phase: string }).phase),
				["preparing", "thinking"],
			);
		} finally {
			controller.dispose();
		}
	});
});
