import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { rewriteCompactionThresholds } from "../../src/domains/lifecycle/migrations/2026-06-11-compaction-single-threshold.js";
import { DEFAULT_COMPACTION_THRESHOLD, shouldCompact } from "../../src/domains/session/compaction/auto.js";
import { maskStaleObservations } from "../../src/domains/session/compaction/mask-observations.js";
import { estimateAgentContextTokens } from "../../src/domains/session/context-accounting.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import { buildReplayAgentMessagesFromTurns, selectReplayEntries } from "../../src/interactive/chat-renderer.js";
import { renderCompactionSummaryLine } from "../../src/interactive/renderers/compaction-summary.js";

function entryBase(
	id: string,
	parentTurnId: string | null = null,
): Pick<SessionEntry, "turnId" | "parentTurnId" | "timestamp"> {
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

function assistant(
	id: string,
	content: unknown[],
	parentTurnId: string | null = null,
	usageTokens = 100_000,
): MessageEntry {
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

describe("contracts/context compaction trigger", () => {
	it("fires on a single pressure threshold", () => {
		strictEqual(shouldCompact(790, DEFAULT_COMPACTION_THRESHOLD, 1000).shouldCompact, false);
		strictEqual(shouldCompact(800, DEFAULT_COMPACTION_THRESHOLD, 1000).shouldCompact, true);
		strictEqual(shouldCompact(990, DEFAULT_COMPACTION_THRESHOLD, 1000).shouldCompact, true);
		strictEqual(shouldCompact(990, DEFAULT_COMPACTION_THRESHOLD, 0).shouldCompact, false);
		// Disabled thresholds never fire.
		strictEqual(shouldCompact(990, 0, 1000).shouldCompact, false);
		strictEqual(shouldCompact(990, 1.5, 1000).shouldCompact, false);
	});
});

describe("contracts/context compaction mask_observations", () => {
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

		const result = maskStaleObservations(entries, 1);
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

	it("protects recent turns and never re-masks an already masked observation", () => {
		const entries: SessionEntry[] = [
			user("01", "old"),
			toolResult("02", "call-1", "large observation ".repeat(500), "01"),
			user("03", "recent", "02"),
			toolResult("04", "call-2", "recent observation body", "03"),
		];

		const first = maskStaleObservations(entries, 1);
		strictEqual(first.changed, true);
		strictEqual(first.maskedObservations, 1);
		const recent = first.entries[3] as MessageEntry;
		const recentPayload = recent.payload as { result?: { content?: Array<{ text?: string }> } };
		ok((recentPayload.result?.content?.[0]?.text ?? "").includes("recent observation body"));

		const second = maskStaleObservations(first.entries, 1);
		strictEqual(second.changed, false);
		strictEqual(second.maskedObservations, 0);
	});

	it("formats LLM summary notices without a stray closing bracket", () => {
		strictEqual(
			renderCompactionSummaryLine({
				messagesSummarized: 43,
				summaryChars: 3833,
				tokensBefore: 73_901,
				isSplitTurn: true,
			}),
			"[context engine] llm_summary: 43 messages summarized to 3833 chars; ~73901 tokens before (split turn)",
		);
		strictEqual(
			renderCompactionSummaryLine({
				messagesSummarized: 4,
				summaryChars: 512,
				tokensBefore: 12_345,
				isSplitTurn: false,
			}),
			"[context engine] llm_summary: 4 messages summarized to 512 chars; ~12345 tokens before",
		);
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

		const replay = buildReplayAgentMessagesFromTurns(entries) as Array<{
			role?: string;
			toolCallId?: string;
			content?: unknown;
		}>;
		const callIndex = replay.findIndex(
			(message) =>
				message.role === "assistant" &&
				Array.isArray(message.content) &&
				message.content.some(
					(block) => !!block && typeof block === "object" && (block as { id?: unknown }).id === "call-1",
				),
		);
		const resultIndex = replay.findIndex((message) => message.role === "toolResult" && message.toolCallId === "call-1");
		ok(callIndex >= 0 && resultIndex > callIndex, `callIndex=${callIndex} resultIndex=${resultIndex}`);
	});
});

describe("contracts/context compaction settings migration", () => {
	it("rewrites the five-threshold block to a single threshold, preserving comments and custom values", () => {
		const yamlText = [
			"# user settings",
			"compaction:",
			"  auto: true",
			"  excludeLastTurns: 2",
			"  thresholds:",
			"    warning: 0.7",
			"    maskObservations: 0.75",
			"    pruneObservations: 0.85",
			"    maskDialogue: 0.9",
			"    llmSummary: 0.99",
			"retry:",
			"  enabled: true",
			"",
		].join("\n");

		const rewritten = rewriteCompactionThresholds(yamlText);
		ok(rewritten !== null);
		ok(rewritten.includes("# user settings"));
		ok(rewritten.includes("threshold: 0.75"));
		ok(!rewritten.includes("thresholds:"));
		ok(!rewritten.includes("llmSummary"));
		ok(rewritten.includes("excludeLastTurns: 2"));
		ok(rewritten.includes("enabled: true"));

		// Already-migrated and threshold-less files are left untouched.
		strictEqual(rewriteCompactionThresholds(rewritten), null);
		strictEqual(rewriteCompactionThresholds("retry:\n  enabled: true\n"), null);
	});
});
