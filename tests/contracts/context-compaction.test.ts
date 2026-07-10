import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_COMPACTION_THRESHOLD, shouldCompact } from "../../src/domains/session/compaction/auto.js";
import { compact, textFromAssistant } from "../../src/domains/session/compaction/compact.js";
import { maskStaleObservations } from "../../src/domains/session/compaction/mask-observations.js";
import { estimateAgentContextTokens } from "../../src/domains/session/context-accounting.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import { fauxAssistantMessage, registerFauxProvider } from "../../src/engine/ai.js";
import type { Model } from "../../src/engine/types.js";
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

function compactionPromptText(context: unknown): string {
	if (!context || typeof context !== "object") return "";
	const messages = (context as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return "";
	const first = messages[0];
	if (!first || typeof first !== "object") return "";
	const content = (first as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				!!block &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function replayText(messages: ReadonlyArray<unknown>): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			parts.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
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

	it("accepts plain string assistant summaries from compaction models", () => {
		strictEqual(textFromAssistant({ content: "## Goal\nKeep the useful summary." }), "## Goal\nKeep the useful summary.");
	});
});

describe("contracts/context compaction cumulative replay", () => {
	it("carries the prior checkpoint and retained suffix through both branches of a deterministic second pass", async () => {
		const modelId = "cumulative-compaction-model";
		const faux = registerFauxProvider({
			provider: "cumulative-compaction-provider",
			models: [{ id: modelId }],
			tokensPerSecond: 0,
		});
		const prompts: string[] = [];
		const earlyConstraint = "EARLY-CONSTRAINT: preserve deterministic ordering.";
		const skillRule = "Retain the active-skill workflow across compaction.";
		const firstCheckpoint = [
			"## Goal",
			"Complete the cumulative compaction contract.",
			"",
			"## Constraints & Preferences",
			`- ${earlyConstraint}`,
			"",
			"## Progress",
			"### Done",
			"- [x] Captured the original request.",
			"",
			"### In Progress",
			"- [ ] Continue after compaction.",
			"",
			"### Blocked",
			"- (none)",
			"",
			"## Key Decisions",
			"- **Ordering**: Keep it deterministic.",
			"",
			"## Next Steps",
			"1. Continue the implementation.",
			"",
			"## Critical Context",
			"- The early constraint remains binding.",
		].join("\n");
		const secondCheckpoint = [
			"## Goal",
			"Complete the cumulative compaction contract.",
			"",
			"## Constraints & Preferences",
			`- ${earlyConstraint}`,
			`- Active skill active-skill: ${skillRule}`,
			"",
			"## Progress",
			"### Done",
			"- [x] Captured the original and newer history.",
			"",
			"### In Progress",
			"- [ ] Finish the active split turn.",
			"",
			"### Blocked",
			"- (none)",
			"",
			"## Key Decisions",
			"- **Skill retention**: Keep active-skill in force.",
			"",
			"## Next Steps",
			"1. Finish the active turn.",
			"",
			"## Critical Context",
			"- Prior checkpoint and retained suffix were merged.",
		].join("\n");
		const splitCheckpoint = "Continue the active split turn after the retained assistant suffix.";

		faux.setResponses([
			(context) => {
				prompts.push(compactionPromptText(context));
				return fauxAssistantMessage(firstCheckpoint);
			},
			(context) => {
				prompts.push(compactionPromptText(context));
				return fauxAssistantMessage(secondCheckpoint);
			},
			(context) => {
				prompts.push(compactionPromptText(context));
				return fauxAssistantMessage(splitCheckpoint);
			},
		]);

		try {
			const firstEntries: SessionEntry[] = [
				user("01", `Implement the feature. ${earlyConstraint}`),
				{
					kind: "fileEntry",
					...entryBase("02", "01"),
					path: "src/early.ts",
					operation: "read",
				},
				assistant("03", [{ type: "text", text: "The original request is understood." }], "01"),
				user("04", `<skill name="active-skill">${skillRule}</skill>\n\nContinue with the active skill.`, "03"),
				{
					kind: "skillActivation",
					...entryBase("05", "04"),
					activation: {
						name: "active-skill",
						filePath: "/repo/.clio/skills/active-skill/SKILL.md",
						hash: "a".repeat(64),
						source: "clio",
						triggeredBy: "slash-command",
						turnId: "04",
					},
				},
				{
					kind: "fileEntry",
					...entryBase("06", "04"),
					path: "src/skill-state.ts",
					operation: "edit",
				},
				assistant("07", [{ type: "text", text: "The active skill is loaded." }], "04"),
			];

			const model = faux.getModel(modelId) as unknown as Model<never>;
			const first = await compact({ entries: firstEntries, model, keepRecentTokens: 1 });
			strictEqual(first.firstKeptTurnId, "04");
			strictEqual(first.isSplitTurn, false, "skill protection widens the first cut to the skill turn");
			ok(first.summary.includes(earlyConstraint));
			ok(first.summary.includes("<read-files>\nsrc/early.ts\n</read-files>"));

			const firstSummary: SessionEntry = {
				kind: "compactionSummary",
				...entryBase("08", first.firstKeptTurnId),
				summary: first.summary,
				tokensBefore: first.tokensBefore,
				firstKeptTurnId: first.firstKeptTurnId ?? "",
				messagesSummarized: first.messagesSummarized,
				isSplitTurn: first.isSplitTurn,
				trigger: "auto",
			};
			const secondEntries: SessionEntry[] = [
				...firstEntries,
				firstSummary,
				user("09", "Add the newer history before the active turn.", "07"),
				{
					kind: "fileEntry",
					...entryBase("10", "09"),
					path: "src/new.ts",
					operation: "read",
				},
				assistant("11", [{ type: "text", text: "The newer history is complete." }], "09"),
				user("12", "Finish the active split turn.", "11"),
				assistant("13", [{ type: "text", text: "This recent assistant suffix remains verbatim." }], "12"),
			];

			const second = await compact({ entries: secondEntries, model, keepRecentTokens: 1 });
			strictEqual(second.firstKeptTurnId, "13");
			strictEqual(second.isSplitTurn, true);
			strictEqual(prompts.length, 3, "first pass plus both second-pass prompt branches should run");
			ok(prompts[0]?.startsWith("<conversation>"));

			const normalHistoryPrompt = prompts[1] ?? "";
			const splitTurnPrompt = prompts[2] ?? "";
			for (const prompt of [normalHistoryPrompt, splitTurnPrompt]) {
				ok(prompt.startsWith("<previous-context>"));
				ok(prompt.includes(`[Prior summary]: ${firstCheckpoint}`));
				ok(prompt.includes("[Skill activation]: active-skill"));
				ok(prompt.includes(skillRule));
			}
			ok(normalHistoryPrompt.includes("Add the newer history before the active turn."));
			ok(normalHistoryPrompt.includes("Create a structured context checkpoint"));
			ok(!normalHistoryPrompt.includes("Finish the active split turn."));
			ok(splitTurnPrompt.includes("Finish the active split turn."));
			ok(splitTurnPrompt.includes("beginning of the currently active user turn"));
			ok(!splitTurnPrompt.includes("Add the newer history before the active turn."));

			ok(second.summary.includes(earlyConstraint));
			ok(second.summary.includes(`Active skill active-skill: ${skillRule}`));
			ok(second.summary.includes(splitCheckpoint));
			ok(second.summary.includes("<read-files>\nsrc/early.ts\nsrc/new.ts\n</read-files>"));
			ok(second.summary.includes("<modified-files>\nsrc/skill-state.ts\n</modified-files>"));

			const secondSummary: SessionEntry = {
				kind: "compactionSummary",
				...entryBase("14", second.firstKeptTurnId),
				summary: second.summary,
				tokensBefore: second.tokensBefore,
				firstKeptTurnId: second.firstKeptTurnId ?? "",
				messagesSummarized: second.messagesSummarized,
				isSplitTurn: second.isSplitTurn,
				trigger: "auto",
			};
			const twiceCompacted = [...secondEntries, secondSummary];
			const selected = selectReplayEntries(twiceCompacted);
			strictEqual(
				selected.filter((entry) => entry.kind === "compactionSummary").length,
				1,
				"final replay selects only the cumulative second summary",
			);
			ok(!selected.some((entry) => entry.turnId === "01" || entry.turnId === "04" || entry.turnId === "05"));
			ok(
				selected.some((entry) => entry.turnId === "13"),
				"the newest retained suffix remains verbatim",
			);

			const finalReplayText = replayText(buildReplayAgentMessagesFromTurns(twiceCompacted));
			ok(finalReplayText.includes(earlyConstraint));
			ok(finalReplayText.includes(`Active skill active-skill: ${skillRule}`));
			ok(finalReplayText.includes("src/early.ts"));
			ok(finalReplayText.includes("src/new.ts"));
			ok(finalReplayText.includes("src/skill-state.ts"));
			ok(finalReplayText.includes("This recent assistant suffix remains verbatim."));
		} finally {
			faux.unregister();
		}
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

	it("drops thinking from stale assistant messages, stamps mask_thinking, and preserves text and tool calls", () => {
		const staleThinking = "let me reason step by step ".repeat(200);
		const entries: SessionEntry[] = [
			user("01", "old question"),
			assistant(
				"02",
				[
					{ type: "thinking", thinking: staleThinking, thinkingSignature: "reasoning_content" },
					{ type: "text", text: "old answer" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/huge.ts" } },
				],
				"01",
			),
			user("03", "recent protected turn", "02"),
			assistant(
				"04",
				[
					{ type: "thinking", thinking: "recent reasoning" },
					{ type: "text", text: "recent answer" },
				],
				"03",
				10,
			),
		];

		const result = maskStaleObservations(entries, 1);
		strictEqual(result.changed, true);
		strictEqual(result.maskedObservations, 0);
		strictEqual(result.maskedThinkingBlocks, 1);
		strictEqual(result.maskedThinkingChars, staleThinking.length);

		const stale = result.entries[1] as MessageEntry;
		const stalePayload = stale.payload as {
			content?: Array<{ type?: string; text?: string; id?: string }>;
			contextCompaction?: { stage?: string; maskedThinkingChars?: number };
		};
		strictEqual(
			stalePayload.content?.some((block) => block.type === "thinking"),
			false,
		);
		ok(stalePayload.content?.some((block) => block.type === "text" && block.text === "old answer"));
		ok(stalePayload.content?.some((block) => block.type === "toolCall" && block.id === "call-1"));
		strictEqual(stalePayload.contextCompaction?.stage, "mask_thinking");
		strictEqual(stalePayload.contextCompaction?.maskedThinkingChars, staleThinking.length);

		const recent = result.entries[3] as MessageEntry;
		const recentPayload = recent.payload as { content?: Array<{ type?: string; thinking?: string }> };
		ok(recentPayload.content?.some((block) => block.type === "thinking" && block.thinking === "recent reasoning"));

		const replay = buildReplayAgentMessagesFromTurns(result.entries) as Array<{ content?: unknown }>;
		const replayedThinking = replay.flatMap((message) =>
			Array.isArray(message.content)
				? message.content.filter((block) => !!block && (block as { type?: string }).type === "thinking")
				: [],
		);
		strictEqual(replayedThinking.length, 1, "only the protected recent thinking block survives replay");

		const second = maskStaleObservations(result.entries, 1);
		strictEqual(second.changed, false);
		strictEqual(second.maskedThinkingBlocks, 0);
		strictEqual(second.maskedThinkingChars, 0);
	});

	it("masks the payload-level thinking string form", () => {
		const entries: SessionEntry[] = [
			user("01", "old"),
			{
				kind: "message",
				...entryBase("02"),
				parentTurnId: "01",
				role: "assistant",
				payload: { text: "old answer", thinking: "legacy string reasoning", stopReason: "stop" },
			},
			user("03", "recent", "02"),
		];

		const result = maskStaleObservations(entries, 1);
		strictEqual(result.changed, true);
		strictEqual(result.maskedThinkingBlocks, 1);
		strictEqual(result.maskedThinkingChars, "legacy string reasoning".length);
		const payload = (result.entries[1] as MessageEntry).payload as { thinking?: unknown; text?: string };
		strictEqual(payload.thinking, undefined);
		strictEqual(payload.text, "old answer");
		strictEqual(maskStaleObservations(result.entries, 1).changed, false);
	});

	it("leaves assistant messages inside the protected horizon and thinking-free sessions untouched", () => {
		const entries: SessionEntry[] = [
			user("01", "question"),
			assistant(
				"02",
				[
					{ type: "thinking", thinking: "protected" },
					{ type: "text", text: "answer" },
				],
				"01",
				10,
			),
		];
		const protectedResult = maskStaleObservations(entries, 1);
		strictEqual(protectedResult.changed, false);
		strictEqual(protectedResult.maskedThinkingBlocks, 0);
		strictEqual(protectedResult.entries[1], entries[1], "protected entries pass through by reference");

		const noThinking: SessionEntry[] = [
			user("01", "old"),
			assistant("02", [{ type: "text", text: "plain answer" }], "01"),
			user("03", "recent", "02"),
		];
		const untouched = maskStaleObservations(noThinking, 1);
		strictEqual(untouched.changed, false);
		strictEqual(untouched.entries[1], noThinking[1], "thinking-free stale entries pass through by reference");
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
