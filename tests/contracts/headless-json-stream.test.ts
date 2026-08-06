import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { projectDispatchJsonEvent, projectHeadlessJsonEvent } from "../../src/cli/modes/json-stream.js";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";

function assistantMessage(text: string): unknown {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, cost: { total: 0.5 } },
	};
}

describe("contracts/headless-json-stream", () => {
	it("drops message_update: the growing snapshot is quadratic in a long turn", () => {
		// A single SciCode sub-step wrote 802 MB of stdout, 99.3% of it
		// message_update snapshots of a message whose final form is 44 KB.
		const event = {
			type: "message_update",
			message: assistantMessage("a very long partial answer"),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "r", partial: assistantMessage("par") },
		} as unknown as ChatLoopEvent;
		strictEqual(projectHeadlessJsonEvent(event), null);
	});

	it("streams deltas as increments, never as the growing partial text", () => {
		const projected = projectHeadlessJsonEvent({
			type: "text_delta",
			contentIndex: 0,
			delta: "wor",
			partialText: "hello wor",
		} as unknown as ChatLoopEvent);
		deepStrictEqual(projected, { type: "text_delta", contentIndex: 0, delta: "wor" });

		const thinking = projectHeadlessJsonEvent({
			type: "thinking_delta",
			contentIndex: 1,
			delta: "hm",
			partialThinking: "let me hm",
		} as unknown as ChatLoopEvent);
		deepStrictEqual(thinking, { type: "thinking_delta", contentIndex: 1, delta: "hm" });
	});

	it("summarizes agent_end usage instead of republishing the whole segment", () => {
		const projected = projectHeadlessJsonEvent({
			type: "agent_end",
			messages: [assistantMessage("one"), assistantMessage("two")],
		} as unknown as ChatLoopEvent) as { type: string; messageCount: number; usage: Record<string, unknown> };
		strictEqual(projected.type, "agent_end");
		strictEqual(projected.messageCount, 2);
		strictEqual(projected.usage.totalTokens, 250);
		strictEqual(projected.usage.measured, true);
		strictEqual("messages" in projected, false, "the transcript is not republished");
	});

	it("keeps the assistant message on turn_end and drops tool results already streamed", () => {
		const projected = projectHeadlessJsonEvent({
			type: "turn_end",
			message: assistantMessage("final"),
			toolResults: [{ role: "toolResult", content: "10 MB of file text" }],
		} as unknown as ChatLoopEvent) as Record<string, unknown>;
		strictEqual(projected.type, "turn_end");
		ok(projected.message !== undefined, "stop reason and usage stay reachable");
		strictEqual("toolResults" in projected, false);
	});

	it("drops the segment transcript from a dispatch stream's agent_end", () => {
		// The dispatch surface forwards worker events, and its agent_end carried
		// every message of the segment a second time: each had already crossed as
		// its own message_end. Measured on a two-minute soak run: 24 KB of
		// agent_end against 19 KB for the whole message_end stream it repeated.
		const projected = projectDispatchJsonEvent({
			type: "agent_end",
			messages: [assistantMessage("first"), assistantMessage("second")],
		}) as { type: string; messageCount: number; usage: Record<string, unknown> };

		strictEqual(projected.type, "agent_end");
		strictEqual(projected.messageCount, 2);
		strictEqual(projected.usage.totalTokens, 250);
		strictEqual(projected.usage.measured, true);
		strictEqual("messages" in projected, false, "the transcript is not republished");
	});

	it("leaves a worker's slimmed increments and every other dispatch event alone", () => {
		// A worker publishes increments as message_update deltas, already slimmed
		// of their cumulative snapshots at the worker stdout seam. That is a
		// different name for the same append-oriented promise, not a violation.
		for (const event of [
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "The" } },
			{ type: "message_end", message: assistantMessage("done") },
			{ type: "clio_tool_finish", payload: { tool: "edit", outcome: "ok" } },
			{ type: "attempt_start", attempt: 1 },
			{ type: "agent_end", messageCount: 2, usage: { totalTokens: 250 } },
		]) {
			strictEqual(projectDispatchJsonEvent(event), event);
		}
	});

	it("passes terminal and lifecycle events through unchanged", () => {
		for (const event of [
			{ type: "message_end", message: assistantMessage("done") },
			{ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "a.ts" } },
			{ type: "tool_execution_end", toolCallId: "1", toolName: "read", result: { content: [] }, isError: false },
			{ type: "notice", surface: "transcript", level: "warning", key: "turn.interrupted", text: "cancelled" },
		] as unknown as ChatLoopEvent[]) {
			strictEqual(projectHeadlessJsonEvent(event), event);
		}
	});
});
