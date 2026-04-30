import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateContextTokens } from "../../src/domains/session/compaction/tokens.js";
import {
	contextUsageSnapshot,
	estimateAgentContextTokens,
	estimateAgentMessageTokens,
	extractReasoningTokens,
} from "../../src/domains/session/context-accounting.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { buildReplayAgentMessagesFromTurns } from "../../src/interactive/chat-renderer.js";

describe("session/context-accounting", () => {
	it("counts the same rich assistant and tool-result shapes that provider replay sends", () => {
		const bigToolResult = "x".repeat(1_000_000);
		const entries: SessionEntry[] = [
			{
				kind: "message",
				turnId: "u1",
				parentTurnId: null,
				timestamp: "2026-04-29T00:00:00.000Z",
				role: "user",
				payload: { text: "read the huge output" },
			},
			{
				kind: "message",
				turnId: "a1",
				parentTurnId: "u1",
				timestamp: "2026-04-29T00:00:01.000Z",
				role: "assistant",
				payload: {
					text: "I will read it.",
					content: [
						{ type: "thinking", thinking: "Need to preserve provider-bound content." },
						{ type: "text", text: "I will read it." },
						{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "huge.log" } },
					],
				},
			},
			{
				kind: "message",
				turnId: "tc1",
				parentTurnId: "a1",
				timestamp: "2026-04-29T00:00:02.000Z",
				role: "tool_call",
				payload: { toolCallId: "call-1", name: "read", args: { path: "huge.log" } },
			},
			{
				kind: "message",
				turnId: "tr1",
				parentTurnId: "tc1",
				timestamp: "2026-04-29T00:00:03.000Z",
				role: "tool_result",
				payload: {
					toolCallId: "call-1",
					toolName: "read",
					result: { content: [{ type: "text", text: bigToolResult }] },
					isError: false,
				},
			},
		];

		const replayMessages = buildReplayAgentMessagesFromTurns(entries);
		const replayEstimate = estimateAgentContextTokens({
			systemPrompt: "You are Clio.",
			messages: replayMessages,
			pendingUserText: "continue the active task",
		});
		const sessionEstimate = calculateContextTokens(entries);
		ok(replayEstimate > 250_000, `expected huge provider-bound replay estimate, got ${replayEstimate}`);
		ok(
			replayEstimate >= sessionEstimate,
			`provider-bound projection must not undercount the persisted transcript: replay=${replayEstimate} session=${sessionEstimate}`,
		);
	});

	it("uses usage anchors conservatively without hiding a larger text projection", () => {
		const hugeMessage = {
			role: "toolResult",
			content: [{ type: "text", text: "x".repeat(120_000) }],
			toolCallId: "call-1",
			toolName: "read",
			isError: false,
			timestamp: 0,
		} as AgentMessage;
		const anchored = estimateAgentContextTokens({
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "small" }],
					stopReason: "stop",
					timestamp: 0,
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
				} as AgentMessage,
				hugeMessage,
			],
		});
		const hugeOnly = estimateAgentMessageTokens(hugeMessage);
		ok(anchored >= hugeOnly, `usage anchor must not mask larger trailing payload: ${anchored} < ${hugeOnly}`);
	});

	it("extracts reasoning token usage only when a provider exposes it", () => {
		strictEqual(extractReasoningTokens({ outputDetails: { reasoningTokens: 42 } }), 42);
		strictEqual(extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: 13 } }), 13);
		strictEqual(extractReasoningTokens({ input: 1, output: 2 }), null);
	});
});

describe("contextUsageSnapshot", () => {
	it("returns percent=null when window is zero and tokens are positive", () => {
		const snap = contextUsageSnapshot(500, 0);
		strictEqual(snap.percent, null);
		strictEqual(snap.tokens, 500);
		strictEqual(snap.contextWindow, 0);
	});

	it("returns percent=null when both inputs are null/undefined", () => {
		const snap = contextUsageSnapshot(null, null);
		strictEqual(snap.percent, null);
	});

	it("clamps percent to 100 when tokens exceed window", () => {
		const snap = contextUsageSnapshot(1500, 500);
		strictEqual(snap.percent, 100);
	});

	it("computes the expected mid-percent for normal inputs", () => {
		const snap = contextUsageSnapshot(50, 200);
		strictEqual(snap.percent, 25);
	});
});
