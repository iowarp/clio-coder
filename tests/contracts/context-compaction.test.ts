import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_CONTEXT_COMPACTION_THRESHOLDS,
	shouldCompact,
} from "../../src/domains/session/compaction/auto.js";
import { applyProgressiveCompaction } from "../../src/domains/session/compaction/progressive.js";
import { estimateAgentContextTokens } from "../../src/domains/session/context-accounting.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import { buildReplayAgentMessagesFromTurns, selectReplayEntries } from "../../src/interactive/chat-renderer.js";
import { formatProgressiveCompactionNotice } from "../../src/interactive/chat-loop.js";

function entryBase(id: string, parentTurnId: string | null = null): Pick<SessionEntry, "turnId" | "parentTurnId" | "timestamp"> {
	return {
		turnId: id,
		parentTurnId,
		timestamp: `2026-06-08T00:00:${id.padStart(2, "0")}.000Z`,
	};
}

function user(id: string, text: string, parentTurnId: string | null = null): MessageEntry {
	return {
		kind: "message",
		...entryBase(id, parentTurnId),
		role: "user",
		payload: { text },
	};
}

function assistant(id: string, content: unknown[], parentTurnId: string | null = null, usageTokens = 100_000): MessageEntry {
	return {
		kind: "message",
		...entryBase(id, parentTurnId),
		role: "assistant",
		payload: {
			content,
			stopReason: "stop",
			usage: { input: usageTokens, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: usageTokens },
		},
	};
}

function toolCall(id: string, callId: string, parentTurnId: string | null): MessageEntry {
	return {
		kind: "message",
		...entryBase(id, parentTurnId),
		role: "tool_call",
		payload: { toolCallId: callId, name: "read", args: { path: "src/huge.ts" } },
	};
}

function toolResult(id: string, callId: string, text: string, parentTurnId: string | null): MessageEntry {
	return {
		kind: "message",
		...entryBase(id, parentTurnId),
		role: "tool_result",
		payload: {
			toolCallId: callId,
			toolName: "read",
			result: { content: [{ type: "text", text }] },
			isError: false,
			resultSummary: { bytes: text.length, truncated: false },
		},
	};
}

describe("contracts/context compaction stages", () => {
	it("selects the highest crossed graduated stage", () => {
		const thresholds = DEFAULT_CONTEXT_COMPACTION_THRESHOLDS;
		strictEqual(shouldCompact(690, thresholds, 1000).stage, null);
		strictEqual(shouldCompact(700, thresholds, 1000).stage, "warning");
		strictEqual(shouldCompact(800, thresholds, 1000).stage, "mask_observations");
		strictEqual(shouldCompact(850, thresholds, 1000).stage, "prune_observations");
		strictEqual(shouldCompact(900, thresholds, 1000).stage, "mask_dialogue");
		strictEqual(shouldCompact(990, thresholds, 1000).stage, "llm_summary");
		strictEqual(shouldCompact(990, thresholds, 0).stage, null);
	});

	it("masks older tool results while preserving tool metadata and invalidating stale usage", () => {
		const huge = `${"line\n".repeat(120)}final secret body`;
		const entries: SessionEntry[] = [
			user("01", "read the large file"),
			assistant("02", [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/huge.ts" } }], "01"),
			toolCall("03", "call-1", "02"),
			toolResult("04", "call-1", huge, "03"),
			user("05", "recent protected turn", "04"),
			assistant("06", [{ type: "text", text: "recent answer" }], "05", 10),
		];

		const result = applyProgressiveCompaction({ entries, stage: "mask_observations", excludeLastTurns: 1 });
		strictEqual(result.changed, true);
		strictEqual(result.maskedObservations, 1);
		const masked = result.entries[3] as MessageEntry;
		const payload = masked.payload as { toolCallId?: string; result?: { content?: Array<{ text?: string }> } };
		strictEqual(payload.toolCallId, "call-1");
		const text = payload.result?.content?.[0]?.text ?? "";
		ok(text.includes("Observation masked"));
		ok(!text.includes("final secret body"));

		const replayMessages = buildReplayAgentMessagesFromTurns(result.entries);
		const estimated = estimateAgentContextTokens({ messages: replayMessages });
		ok(estimated < 10_000, `expected invalidated usage anchor to fall back to projection, got ${estimated}`);
	});

	it("formats progressive notices with the same live accounting source as the footer", () => {
		const entries: SessionEntry[] = [
			user("01", "old"),
			toolResult("02", "call-1", "large observation ".repeat(500), "01"),
			user("03", "recent", "02"),
		];
		const result = applyProgressiveCompaction({ entries, stage: "prune_observations", excludeLastTurns: 1 });
		const notice = formatProgressiveCompactionNotice(result, { tokensBefore: 58_596, tokensAfter: 7_864 });
		ok(notice.includes("~58596 tokens -> ~7864 tokens"), notice);
	});

	it("repairs tool_result dependencies when a compaction summary starts at a result", () => {
		const entries: SessionEntry[] = [
			user("01", "read something"),
			toolCall("02", "call-1", "01"),
			toolResult("03", "call-1", "observation", "02"),
			{
				kind: "compactionSummary",
				...entryBase("04", "03"),
				summary: "older context summarized",
				tokensBefore: 1234,
				firstKeptTurnId: "03",
				trigger: "auto",
			},
		];
		const selected = selectReplayEntries(entries);
		const selectedIds = selected.map((entry) => entry.turnId);
		ok(selectedIds.indexOf("02") >= 0, `expected matching tool_call to be retained, got ${selectedIds}`);
		ok(selectedIds.indexOf("02") < selectedIds.indexOf("03"));

		const replay = buildReplayAgentMessagesFromTurns(entries) as Array<{ role?: string; toolCallId?: string; content?: unknown }>;
		const callIndex = replay.findIndex(
			(message) =>
				message.role === "assistant" &&
				Array.isArray(message.content) &&
				message.content.some(
					(block) => !!block && typeof block === "object" && (block as { id?: unknown }).id === "call-1",
				),
		);
		const resultIndex = replay.findIndex(
			(message) => message.role === "toolResult" && message.toolCallId === "call-1",
		);
		ok(callIndex >= 0 && resultIndex > callIndex, `callIndex=${callIndex} resultIndex=${resultIndex}`);
	});

	it("prunes older observations and masks dialogue without deleting tool calls", () => {
		const originalAssistantText = `I will inspect the file before answering. ${"verbose implementation detail ".repeat(80)}`;
		const entries: SessionEntry[] = [
			user("01", "original goal stays visible"),
			assistant(
				"02",
				[
					{ type: "text", text: originalAssistantText },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/huge.ts" } },
				],
				"01",
			),
			toolResult("03", "call-1", "very large observation body ".repeat(200), "02"),
			user("04", "recent protected turn", "03"),
			assistant("05", [{ type: "text", text: "recent answer" }], "04", 10),
		];

		const result = applyProgressiveCompaction({ entries, stage: "mask_dialogue", excludeLastTurns: 1 });
		strictEqual(result.changed, true);
		strictEqual(result.prunedObservations, 1);
		strictEqual(result.maskedDialogue, 1);

		const maskedAssistant = result.entries[1] as MessageEntry;
		const assistantPayload = maskedAssistant.payload as { content?: Array<{ type?: string; id?: string; text?: string }> };
		const content = assistantPayload.content ?? [];
		ok(content.some((block) => block.type === "toolCall" && block.id === "call-1"));
		ok(content.some((block) => block.type === "text" && block.text?.includes("Earlier assistant response masked")));
		ok(!JSON.stringify(content).includes("verbose implementation detail verbose implementation detail verbose"));

		const prunedResult = result.entries[2] as MessageEntry;
		const resultPayload = prunedResult.payload as { result?: { content?: Array<{ text?: string }> } };
		const resultText = resultPayload.result?.content?.[0]?.text ?? "";
		ok(resultText.includes("Observation pruned"));
	});
});
