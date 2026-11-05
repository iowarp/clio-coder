import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { reduceStatus, type StatusInputEvent } from "../../src/interactive/status/index.js";
import { type AgentStatus, INITIAL_STATUS } from "../../src/session-control/status-types.js";

const STUCK_AFTER_MS = 180_000;

function reducer(start = 1_000_000) {
	let now = start;
	let status: AgentStatus = INITIAL_STATUS;
	const apply = (event: StatusInputEvent | { type: string; [key: string]: unknown }): AgentStatus => {
		status = reduceStatus(status, event as StatusInputEvent, { now, localRuntime: false });
		return status;
	};
	return {
		apply,
		advance(ms: number): AgentStatus {
			for (let spent = 0; spent < ms; spent += 1_000) {
				now += 1_000;
				apply({ type: "watchdog_tick" });
			}
			return status;
		},
		current: () => status,
		now: () => now,
	};
}

function waitingOnModel(machine: ReturnType<typeof reducer>): void {
	machine.apply({ type: "agent_start" });
	machine.apply({ type: "turn_start" });
}

test("an open approval stays human-owned past the stuck threshold and the clock restarts when it resolves", () => {
	const machine = reducer();
	waitingOnModel(machine);
	machine.apply({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
	machine.apply({ type: "overlay_push", overlay: "tool_blocked" });
	const held = machine.advance(STUCK_AFTER_MS + 20_000);
	strictEqual(held.phase, "tool_blocked");
	strictEqual(held.watchdogTier, 0);
	strictEqual(held.watchdogPeak, 0);
	const resolved = machine.apply({ type: "overlay_pop", overlay: "tool_blocked" });
	strictEqual(resolved.phase, "tool_running");
	strictEqual(resolved.lastMeaningfulAt, machine.now());
	strictEqual(machine.advance(9_000).watchdogTier, 0);
	strictEqual(machine.advance(2_000).watchdogTier, 1);
});

test("an open interview stays human-owned past the stuck threshold and the wait is the operator's, not the turn's", () => {
	const machine = reducer();
	waitingOnModel(machine);
	machine.apply({ type: "tool_execution_start", toolCallId: "c1", toolName: "ask_user", args: {} });
	const held = machine.advance(STUCK_AFTER_MS + 20_000);
	strictEqual(held.phase, "tool_running");
	strictEqual(held.watchdogTier, 0);
	machine.apply({ type: "tool_execution_end", toolCallId: "c1", toolName: "ask_user", result: "", isError: false });
	const ended = machine.apply({ type: "agent_end", messages: [] });
	strictEqual(ended.phase, "ended");
	strictEqual(ended.summary?.humanWaitMs, STUCK_AFTER_MS + 20_000);
});

test("a model that goes silent with nobody waiting still reaches stuck", () => {
	const machine = reducer();
	waitingOnModel(machine);
	strictEqual(machine.advance(STUCK_AFTER_MS + 1_000).phase, "stuck");
});

function failedAttempt(attempt: number) {
	const retryPending = { attempt, maxAttempts: 3 };
	const message = {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: '503: {"message":"overloaded"}',
		usage: { input: 0, output: 0, totalTokens: 0 },
	};
	return [
		{ type: "message_start", message },
		{ type: "message_end", message, retryPending },
		{ type: "agent_end", messages: [message], retryPending },
		{
			type: "retry_status",
			status: { phase: "scheduled", attempt, maxAttempts: 3, delayMs: 8_000, retryAfterMs: 8_000 },
		},
	] as const;
}

const retrying = (attempt: number) => ({
	type: "retry_status",
	status: { phase: "retrying", attempt, maxAttempts: 3 },
});
const screen = (panel: ReturnType<typeof createChatPanel>): string =>
	panel.render(100).map(stripTerminalSequences).join("\n");

test("a retry backoff stays retrying with no failed receipt until exhaustion", () => {
	const machine = reducer();
	const panel = createChatPanel({ now: () => machine.now() });
	const both = (event: { type: string; [key: string]: unknown }): void => {
		machine.apply(event);
		panel.applyEvent(event as never);
	};
	panel.appendUser("hello");
	both({ type: "agent_start" });
	both({ type: "turn_start" });
	for (const event of failedAttempt(1)) both(event);
	strictEqual(machine.current().phase, "retrying");
	strictEqual(machine.current().retry?.dueAt, machine.now() + 8_000);
	machine.advance(5_000);
	strictEqual(machine.current().phase, "retrying");
	strictEqual((screen(panel).match(/↻/gu) ?? []).length, 1);
	doesNotMatch(screen(panel), /Failed|✗|\[error\]/u);

	both(retrying(1));
	both({ type: "agent_start" });
	strictEqual(machine.current().retry?.stage, "attempt");
	for (const event of failedAttempt(2)) both(event);
	both(retrying(2));
	both({ type: "agent_start" });
	doesNotMatch(screen(panel), /Failed|✗|\[error\]/u);

	const last = {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: '503: {"message":"overloaded"}',
		usage: { input: 0, output: 0, totalTokens: 0 },
	};
	both({ type: "message_start", message: last });
	both({ type: "message_end", message: last });
	both({ type: "agent_end", messages: [last] });
	both({ type: "retry_status", status: { phase: "exhausted", attempt: 2, maxAttempts: 2 } });
	strictEqual(machine.current().phase, "ended");
	strictEqual(machine.current().summary?.stopReason, "error");
	strictEqual((screen(panel).match(/✗ Failed/gu) ?? []).length, 1);
	strictEqual((screen(panel).match(/\[error\]/gu) ?? []).length, 1);
	match(screen(panel), /✗ Failed · [^\n]*2 retries/u);
});

test("a retried run recovers into one receipt that notes the retries", () => {
	let now = 1_000;
	const panel = createChatPanel({ now: () => now });
	panel.appendUser("hello");
	panel.applyEvent({ type: "agent_start" } as never);
	for (const event of failedAttempt(1)) panel.applyEvent(event as never);
	now += 8_000;
	panel.applyEvent(retrying(1) as never);
	panel.applyEvent({ type: "agent_start" } as never);
	const answer = {
		role: "assistant",
		content: [{ type: "text", text: "Recovered answer." }],
		stopReason: "stop",
		usage: { input: 1, output: 1, totalTokens: 2 },
	};
	panel.applyEvent({ type: "message_start", message: answer } as never);
	panel.applyEvent({ type: "message_end", message: answer } as never);
	panel.applyEvent({ type: "agent_end", messages: [answer] } as never);
	panel.applyEvent({ type: "retry_status", status: { phase: "recovered", attempt: 1, maxAttempts: 3 } } as never);
	const output = screen(panel);
	strictEqual((output.match(/✓ Done/gu) ?? []).length, 1);
	match(output, /✓ Done · 8\.0s · 1 retry/u);
	match(output, /provider retry recovered after 1 attempt/u);
	doesNotMatch(output, /Failed/u);
});

test("Esc during a first-token wait puts the receipt under the cancelled prompt and leaves the last receipt intact", () => {
	let now = 1_000;
	const panel = createChatPanel({ now: () => now });
	panel.appendUser("first prompt");
	panel.applyEvent({ type: "agent_start" } as never);
	const answer = {
		role: "assistant",
		content: [{ type: "text", text: "First answer." }],
		stopReason: "stop",
		usage: { input: 1, output: 1, totalTokens: 2 },
	};
	panel.applyEvent({ type: "message_end", message: answer } as never);
	now += 3_000;
	panel.applyEvent({ type: "agent_end", messages: [answer] } as never);

	panel.appendUser("second prompt");
	panel.applyEvent({ type: "agent_start" } as never);
	now += 15_000;
	// The engine's abort arrives with no message_end: a synthetic window and nothing rendered.
	const aborted = {
		role: "assistant",
		content: [],
		stopReason: "aborted",
		usage: { input: 0, output: 0, totalTokens: 0 },
	};
	panel.applyEvent({ type: "agent_end", messages: [aborted] } as never);

	const output = screen(panel);
	const firstReceipt = output.indexOf("✓ Done · 3.0s");
	const prompt = output.indexOf("second prompt");
	const cancelled = output.indexOf("⊘ Cancelled · 15s");
	ok(firstReceipt >= 0, output);
	ok(prompt > firstReceipt, output);
	ok(cancelled > prompt, output);
});
