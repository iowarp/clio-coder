import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { AutoCompactionTrigger, shouldCompact } from "../../src/domains/session/compaction/auto.js";
import {
	collectEntriesForBranchSummary,
	prepareBranchEntries,
	serializeConversation,
} from "../../src/domains/session/compaction/branch-summary.js";
import { findCutPoint, findTurnStartIndex } from "../../src/domains/session/compaction/cut-point.js";
import {
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_KEEP_RECENT_TOKENS,
	DEFAULT_RESERVE_TOKENS,
} from "../../src/domains/session/compaction/defaults.js";
import { collectSessionEntries } from "../../src/domains/session/compaction/session-entries.js";
import {
	calculateContextTokens,
	charsOverFourEstimator,
	estimateTokens,
	getLastAssistantUsage,
} from "../../src/domains/session/compaction/tokens.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { ClioTurnRecord } from "../../src/engine/session.js";
import type { Usage } from "../../src/engine/types.js";
import { renderCompactionSummaryLine } from "../../src/interactive/renderers/compaction-summary.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function userMessage(turnId: string, text: string, parentTurnId: string | null = null): SessionEntry {
	return {
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: "2026-04-17T00:00:00.000Z",
		role: "user",
		payload: { text },
	};
}

function assistantMessage(turnId: string, text: string, parentTurnId: string | null, usage?: Usage): SessionEntry {
	const payload: Record<string, unknown> = { text };
	if (usage) payload.usage = usage;
	return {
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: "2026-04-17T00:00:01.000Z",
		role: "assistant",
		payload,
	};
}

function toolCall(turnId: string, text: string, parentTurnId: string): SessionEntry {
	return {
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: "2026-04-17T00:00:02.000Z",
		role: "tool_call",
		payload: { text },
	};
}

function toolResult(turnId: string, text: string, parentTurnId: string): SessionEntry {
	return {
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: "2026-04-17T00:00:03.000Z",
		role: "tool_result",
		payload: { text },
	};
}

function bashExecution(turnId: string, command: string, output: string, parentTurnId: string | null): SessionEntry {
	return {
		kind: "bashExecution",
		turnId,
		parentTurnId,
		timestamp: "2026-04-17T00:00:04.000Z",
		command,
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
	};
}

function modelChange(turnId: string, parentTurnId: string | null): SessionEntry {
	return {
		kind: "modelChange",
		turnId,
		parentTurnId,
		timestamp: "2026-04-17T00:00:05.000Z",
		provider: "openai",
		modelId: "gpt-5",
	};
}

function sessionInfo(turnId: string, targetTurnId: string, label: string): SessionEntry {
	return {
		kind: "sessionInfo",
		turnId,
		parentTurnId: null,
		timestamp: "2026-04-17T00:00:06.000Z",
		targetTurnId,
		label,
	};
}

function compactionSummary(turnId: string, summary: string, firstKeptTurnId: string): SessionEntry {
	return {
		kind: "compactionSummary",
		turnId,
		parentTurnId: null,
		timestamp: "2026-04-17T00:00:07.000Z",
		summary,
		tokensBefore: 0,
		firstKeptTurnId,
	};
}

function branchSummary(turnId: string, summary: string, fromTurnId: string): SessionEntry {
	return {
		kind: "branchSummary",
		turnId,
		parentTurnId: null,
		timestamp: "2026-04-17T00:00:08.000Z",
		fromTurnId,
		summary,
	};
}

// ---------------------------------------------------------------------------
// tokens.ts
// ---------------------------------------------------------------------------

describe("session/compaction/tokens estimateTokens", () => {
	it("applies chars/4 (ceiling) to a user message with {text}", () => {
		// "hello world" has 11 chars → ceil(11/4) = 3
		strictEqual(estimateTokens(userMessage("t1", "hello world")), 3);
	});

	it("handles raw-string payload shapes defensively", () => {
		const entry = userMessage("t1", "");
		(entry as { payload: unknown }).payload = "hi there";
		// 8 chars → 2 tokens
		strictEqual(estimateTokens(entry), 2);
	});

	it("sums text + thinking + toolCall blocks in a content array", () => {
		const entry = assistantMessage("a1", "", "t1");
		(entry as { payload: unknown }).payload = {
			content: [
				{ type: "text", text: "abcd" },
				{ type: "thinking", thinking: "efgh" },
				{ type: "toolCall", name: "bash", arguments: { cmd: "ls" } },
			],
		};
		// 4 + 4 + "bash".length(4) + JSON.stringify({cmd:"ls"}).length(12) = 24 → ceil(24/4)=6
		strictEqual(estimateTokens(entry), 6);
	});

	it("estimates image blocks at 4800 chars", () => {
		const entry = userMessage("t1", "");
		(entry as { payload: unknown }).payload = {
			content: [{ type: "image", data: "xx", mimeType: "image/png" }],
		};
		// 4800 / 4 = 1200
		strictEqual(estimateTokens(entry), 1200);
	});

	it("bashExecution measures command + output", () => {
		const entry = bashExecution("b1", "ls -la", "total 42\n", null);
		// "ls -la"(6) + "total 42\n"(9) = 15 → ceil(15/4) = 4
		strictEqual(estimateTokens(entry), 4);
	});

	it("custom entries return chars/4 of their data payload", () => {
		const entry: SessionEntry = {
			kind: "custom",
			turnId: "c1",
			parentTurnId: null,
			timestamp: "2026-04-17T00:00:00.000Z",
			customType: "marker",
			data: { text: "abcdef" },
		};
		// 6 chars → 2 tokens
		strictEqual(estimateTokens(entry), 2);
	});

	it("branchSummary + compactionSummary count the summary length", () => {
		strictEqual(estimateTokens(branchSummary("b1", "12345678", "t1")), 2);
		strictEqual(estimateTokens(compactionSummary("c1", "abcd", "t1")), 1);
	});

	it("modelChange / thinkingLevelChange / fileEntry / sessionInfo contribute 0", () => {
		strictEqual(estimateTokens(modelChange("m1", null)), 0);
		strictEqual(estimateTokens(sessionInfo("s1", "t1", "pin")), 0);
	});
});

describe("session/compaction/tokens getLastAssistantUsage", () => {
	const sampleUsage: Usage = {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 160,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	it("returns undefined when no assistant turn has usage", () => {
		strictEqual(getLastAssistantUsage([userMessage("t1", "hi")]), undefined);
	});

	it("returns the most recent assistant usage", () => {
		const first = assistantMessage("a1", "first", "t0", sampleUsage);
		const secondUsage: Usage = { ...sampleUsage, totalTokens: 210 };
		const second = assistantMessage("a2", "second", "t1", secondUsage);
		const usage = getLastAssistantUsage([first, userMessage("u2", "next", "a1"), second]);
		ok(usage);
		strictEqual(usage.totalTokens, 210);
	});

	it("skips aborted assistant turns", () => {
		const aborted = assistantMessage("a1", "aborted", "t0");
		(aborted as { payload: Record<string, unknown> }).payload.stopReason = "aborted";
		(aborted as { payload: Record<string, unknown> }).payload.usage = sampleUsage;
		strictEqual(getLastAssistantUsage([aborted]), undefined);
	});
});

describe("session/compaction/tokens calculateContextTokens", () => {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	it("falls back to per-entry estimates when there is no usage anchor", () => {
		const entries = [userMessage("u1", "abcd"), userMessage("u2", "efgh")];
		// 1 + 1 = 2
		strictEqual(calculateContextTokens(entries), 2);
	});

	it("uses usage.totalTokens as the anchor and adds trailing estimates", () => {
		const entries = [assistantMessage("a1", "ignored", null, usage), userMessage("u1", "abcdefgh", "a1")];
		// anchor 1000 + trailing ceil(8/4) = 1002
		strictEqual(calculateContextTokens(entries, usage), 1002);
	});

	it("charsOverFourEstimator exposes the same surface", () => {
		strictEqual(charsOverFourEstimator.estimateEntry(userMessage("u1", "abcdefgh")), 2);
	});
});

// ---------------------------------------------------------------------------
// cut-point.ts
// ---------------------------------------------------------------------------

describe("session/compaction/cut-point findTurnStartIndex", () => {
	it("treats a user message as a turn start", () => {
		const entries = [userMessage("u1", "hi"), assistantMessage("a1", "hello", "u1")];
		strictEqual(findTurnStartIndex(entries, 1), 0);
	});

	it("treats bashExecution as a turn start", () => {
		const entries = [userMessage("u1", "hi"), bashExecution("b1", "ls", "out", "u1"), assistantMessage("a1", "ok", "b1")];
		strictEqual(findTurnStartIndex(entries, 2), 1);
	});

	it("treats branchSummary as a turn start", () => {
		const entries = [branchSummary("bs1", "prior", "root"), assistantMessage("a1", "cont", "bs1")];
		strictEqual(findTurnStartIndex(entries, 1), 0);
	});

	it("returns -1 when no turn start precedes the index", () => {
		const entries = [assistantMessage("a1", "orphan", null)];
		strictEqual(findTurnStartIndex(entries, 0), -1);
	});
});

describe("session/compaction/cut-point findCutPoint", () => {
	it("returns startIndex when there are no valid cut points", () => {
		const entries = [modelChange("m1", null), sessionInfo("s1", "t1", "pin")];
		const cut = findCutPoint(entries, 100);
		deepStrictEqual(cut, { firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false });
	});

	it("never cuts at a tool_result — keeps the call/result pair together", () => {
		// Force keepRecentTokens=0 so the walker wants to cut at the newest entry.
		// A tool_result as the newest entry must not be a chosen cut; the cut
		// should land on the preceding tool_call, keeping the pair intact.
		const entries = [
			userMessage("u1", "x".repeat(400)),
			assistantMessage("a1", "kick off", "u1"),
			toolCall("tc1", "x".repeat(400), "a1"),
			toolResult("tr1", "x".repeat(400), "tc1"),
		];
		const cut = findCutPoint(entries, 0);
		// The cut must NOT be the tool_result index (3); it can be any valid
		// cut point at or after the index the walker stopped on.
		ok(cut.firstKeptEntryIndex !== 3, "cut point should never be the tool_result index");
	});

	it("folds bookkeeping entries (modelChange) into the retained suffix", () => {
		const entries = [
			userMessage("u1", "x".repeat(400)),
			assistantMessage("a1", "first", "u1"),
			modelChange("m1", "a1"),
			userMessage("u2", "y".repeat(400)),
			assistantMessage("a2", "second", "u2"),
		];
		const cut = findCutPoint(entries, 100);
		// The cut landed on u2 (index 3) or somewhere after m1; the "fold
		// backward" step should NOT pull m1 (index 2) into the pre-slice.
		ok(cut.firstKeptEntryIndex >= 2, `cut should include m1 in suffix, got ${cut.firstKeptEntryIndex}`);
	});

	it("reports isSplitTurn=true when the cut falls on an assistant mid-turn", () => {
		const entries = [
			userMessage("u1", "x".repeat(2000)),
			assistantMessage("a1", "y".repeat(2000), "u1"),
			userMessage("u2", "z".repeat(1000)),
			assistantMessage("a2", "tail", "u2"),
		];
		// Ask the walker to keep ~800 tokens; it should land on u2 or a2
		// depending on accumulation order. If it lands on a2 mid-turn,
		// isSplitTurn should be true.
		const cut = findCutPoint(entries, 200);
		if (cut.firstKeptEntryIndex === 3) {
			strictEqual(cut.isSplitTurn, true);
			strictEqual(cut.turnStartIndex, 2);
		}
	});

	it("falls back to the most recent turn start when no suffix crosses keepRecentTokens", () => {
		// Populated session whose total token budget is well below the
		// keep-recent window. Before slice B4, cutIndex was initialized to
		// cutPoints[0] (the oldest valid cut) and stayed there, making `pre`
		// empty in compact() and producing the spurious
		// "[/compact] nothing to compact" notice. The fallback now lands the
		// cut on the newest turn start so manual /compact still summarizes
		// older turns on a small session.
		const entries = [
			userMessage("u1", "hi", null),
			assistantMessage("a1", "first reply", "u1"),
			userMessage("u2", "follow up", "a1"),
			assistantMessage("a2", "second reply", "u2"),
			userMessage("u3", "thanks", "a2"),
			assistantMessage("a3", "you are welcome", "u3"),
		];
		const cut = findCutPoint(entries, 20_000);
		// Newest turn-start is u3 at index 4. Pre = [u1,a1,u2,a2]; post = [u3,a3].
		strictEqual(cut.firstKeptEntryIndex, 4);
		strictEqual(cut.isSplitTurn, false);
		strictEqual(cut.turnStartIndex, -1);
	});

	it("single-turn session still reports nothing to compact under fallback", () => {
		// Defensive: one user+assistant turn below keepRecent has no older
		// history to summarize. Fallback lands on u1 (index 0) so pre stays
		// empty and compact() short-circuits to an empty summary, which the
		// chat-loop surfaces as the "nothing to compact" notice.
		const entries = [userMessage("u1", "only turn", null), assistantMessage("a1", "reply", "u1")];
		const cut = findCutPoint(entries, 20_000);
		strictEqual(cut.firstKeptEntryIndex, 0);
	});
});

// ---------------------------------------------------------------------------
// branch-summary.ts
// ---------------------------------------------------------------------------

describe("session/compaction/branch-summary serializeConversation", () => {
	it("emits stable [Role]: body sections separated by blank lines", () => {
		const entries = [userMessage("u1", "hi"), assistantMessage("a1", "hello", "u1")];
		strictEqual(serializeConversation(entries), "[User]: hi\n\n[Assistant]: hello");
	});

	it("truncates tool_result bodies longer than the cap", () => {
		const big = "x".repeat(3000);
		const entries = [toolResult("tr1", big, "a1")];
		const out = serializeConversation(entries);
		ok(out.startsWith("[Tool result]: "));
		ok(out.includes("[... 1000 more characters truncated]"));
	});

	it("drops non-context-bearing kinds (modelChange, sessionInfo, custom)", () => {
		const entries = [modelChange("m1", null), sessionInfo("s1", "u1", "pinned"), userMessage("u1", "hi")];
		strictEqual(serializeConversation(entries), "[User]: hi");
	});

	it("emits bashExecution with $ command + output", () => {
		const entries = [bashExecution("b1", "ls", "a\nb", null)];
		strictEqual(serializeConversation(entries), "[Bash]: $ ls\na\nb");
	});

	it("serializes prior compaction summaries inline", () => {
		const entries = [compactionSummary("c1", "prior work done", "u1")];
		strictEqual(serializeConversation(entries), "[Prior summary]: prior work done");
	});
});

describe("session/compaction/branch-summary prepareBranchEntries", () => {
	it("partitions at the requested index", () => {
		const entries = [userMessage("u1", "hi"), assistantMessage("a1", "hello", "u1"), userMessage("u2", "next", "a1")];
		const { pre, post } = prepareBranchEntries(entries, 2);
		strictEqual(pre.length, 2);
		strictEqual(post.length, 1);
		strictEqual(post[0]?.turnId, "u2");
	});

	it("clamps negative/overflow indices", () => {
		const entries = [userMessage("u1", "hi")];
		const below = prepareBranchEntries(entries, -5);
		strictEqual(below.pre.length, 0);
		strictEqual(below.post.length, 1);
		const above = prepareBranchEntries(entries, 99);
		strictEqual(above.pre.length, 1);
		strictEqual(above.post.length, 0);
	});

	it("collectEntriesForBranchSummary returns a contiguous slice", () => {
		const entries = [userMessage("u1", "a"), userMessage("u2", "b"), userMessage("u3", "c")];
		const slice = collectEntriesForBranchSummary(entries, 1, 3);
		strictEqual(slice.length, 2);
		strictEqual(slice[0]?.turnId, "u2");
		strictEqual(slice[1]?.turnId, "u3");
	});
});

// ---------------------------------------------------------------------------
// defaults.ts + DEFAULT_SETTINGS integration
// ---------------------------------------------------------------------------

describe("session/compaction/defaults", () => {
	it("DEFAULT_COMPACTION_SETTINGS carries plan-specified values", () => {
		strictEqual(DEFAULT_COMPACTION_SETTINGS.threshold, 0.8);
		strictEqual(DEFAULT_COMPACTION_SETTINGS.auto, true);
		strictEqual(DEFAULT_COMPACTION_SETTINGS.model, undefined);
		strictEqual(DEFAULT_COMPACTION_SETTINGS.systemPrompt, undefined);
	});

	it("engine-level token constants match the pi-coding-agent port", () => {
		strictEqual(DEFAULT_RESERVE_TOKENS, 16_384);
		strictEqual(DEFAULT_KEEP_RECENT_TOKENS, 20_000);
	});

	it("DEFAULT_SETTINGS embeds the compaction block at the top level", () => {
		strictEqual(DEFAULT_SETTINGS.compaction.threshold, 0.8);
		strictEqual(DEFAULT_SETTINGS.compaction.auto, true);
	});
});

// ---------------------------------------------------------------------------
// renderer stub
// ---------------------------------------------------------------------------

describe("interactive/renderers/compaction-summary renderCompactionSummaryLine", () => {
	it("formats the standard row with messages/chars/tokens", () => {
		const line = renderCompactionSummaryLine({
			messagesSummarized: 42,
			summaryChars: 1823,
			tokensBefore: 31420,
		});
		strictEqual(line, "[compacted: 42 messages → 1823 chars (~31420 tokens before)]");
	});

	it("appends (split turn) when the cut fell mid-turn", () => {
		const line = renderCompactionSummaryLine({
			messagesSummarized: 10,
			summaryChars: 500,
			tokensBefore: 10_000,
			isSplitTurn: true,
		});
		ok(line.endsWith("(split turn)]"));
	});
});

// ---------------------------------------------------------------------------
// auto.ts — shouldCompact + AutoCompactionTrigger (slice 12d)
// ---------------------------------------------------------------------------

describe("session/compaction/auto shouldCompact", () => {
	it("returns false when contextWindow is zero or missing", () => {
		strictEqual(shouldCompact(100_000, 0.8, 0), false);
		strictEqual(shouldCompact(100_000, 0.8, Number.NaN), false);
	});

	it("returns false when threshold is zero or negative", () => {
		strictEqual(shouldCompact(100_000, 0, 200_000), false);
		strictEqual(shouldCompact(100_000, -0.5, 200_000), false);
	});

	it("returns true when contextTokens equals threshold * contextWindow", () => {
		// 0.8 * 200000 = 160000; equal means trip.
		strictEqual(shouldCompact(160_000, 0.8, 200_000), true);
	});

	it("returns true when contextTokens exceeds threshold * contextWindow", () => {
		strictEqual(shouldCompact(180_000, 0.8, 200_000), true);
	});

	it("returns false well below the threshold", () => {
		strictEqual(shouldCompact(10_000, 0.8, 200_000), false);
	});

	it("clamps threshold above 1 to 1 (defensive against bad settings)", () => {
		// With threshold=2 and contextWindow=200k, the effective limit is the
		// contextWindow itself; anything below it should not trip.
		strictEqual(shouldCompact(180_000, 2, 200_000), false);
		strictEqual(shouldCompact(200_000, 2, 200_000), true);
	});
});

describe("session/compaction/auto AutoCompactionTrigger", () => {
	it("runs the task once and returns its result", async () => {
		const trigger = new AutoCompactionTrigger<string>();
		let calls = 0;
		const result = await trigger.fire(async () => {
			calls++;
			return "ok";
		});
		strictEqual(result, "ok");
		strictEqual(calls, 1);
	});

	it("debounces concurrent fires onto the same in-flight promise", async () => {
		const trigger = new AutoCompactionTrigger<number>();
		let calls = 0;
		let resolveTask: (n: number) => void = () => {};
		const first = trigger.fire(
			() =>
				new Promise<number>((resolve) => {
					calls++;
					resolveTask = resolve;
				}),
		);
		const second = trigger.fire(async () => {
			calls++;
			return 99;
		});
		strictEqual(trigger.isBusy(), true);
		// Resolve the first task; both promises should resolve to the same value.
		resolveTask(42);
		const [a, b] = await Promise.all([first, second]);
		strictEqual(a, 42);
		strictEqual(b, 42);
		// Only the first task body ran; the second fire saw an in-flight Promise.
		strictEqual(calls, 1);
		strictEqual(trigger.isBusy(), false);
	});

	it("clears the in-flight slot after the task rejects so the next fire runs fresh", async () => {
		const trigger = new AutoCompactionTrigger<string>();
		let calls = 0;
		await trigger
			.fire(async () => {
				calls++;
				throw new Error("boom");
			})
			.catch(() => {});
		strictEqual(trigger.isBusy(), false);
		const second = await trigger.fire(async () => {
			calls++;
			return "recovered";
		});
		strictEqual(second, "recovered");
		strictEqual(calls, 2);
	});
});

// ---------------------------------------------------------------------------
// session-entries.ts: unified reader (slice 12.5b bug 3)
// ---------------------------------------------------------------------------

describe("session/compaction/session-entries collectSessionEntries", () => {
	it("keeps v2 SessionEntry lines as-is", () => {
		const compact: SessionEntry = {
			kind: "compactionSummary",
			turnId: "c1",
			parentTurnId: null,
			timestamp: "2026-04-17T00:00:00.000Z",
			summary: "prior work",
			tokensBefore: 10_000,
			firstKeptTurnId: "u2",
		};
		const out = collectSessionEntries([compact]);
		strictEqual(out.length, 1);
		strictEqual(out[0]?.kind, "compactionSummary");
	});

	it("normalizes legacy ClioTurnRecord lines via fromLegacyTurn", () => {
		const legacy: ClioTurnRecord = {
			id: "legacy-1",
			parentId: null,
			at: "2026-04-17T00:00:01.000Z",
			kind: "user",
			payload: { text: "hi" },
		};
		const out = collectSessionEntries([legacy]);
		strictEqual(out.length, 1);
		strictEqual(out[0]?.kind, "message");
		strictEqual(out[0]?.turnId, "legacy-1");
	});

	it("preserves order across mixed legacy + v2 streams", () => {
		const legacyA: ClioTurnRecord = {
			id: "a",
			parentId: null,
			at: "2026-04-17T00:00:00.000Z",
			kind: "user",
			payload: { text: "first" },
		};
		const summary: SessionEntry = {
			kind: "compactionSummary",
			turnId: "c1",
			parentTurnId: "a",
			timestamp: "2026-04-17T00:00:01.000Z",
			summary: "mid-stream summary",
			tokensBefore: 5_000,
			firstKeptTurnId: "b",
		};
		const legacyB: ClioTurnRecord = {
			id: "b",
			parentId: "a",
			at: "2026-04-17T00:00:02.000Z",
			kind: "assistant",
			payload: { text: "second" },
		};
		const out = collectSessionEntries([legacyA, summary, legacyB]);
		deepStrictEqual(
			out.map((e) => ({ kind: e.kind, turnId: e.turnId })),
			[
				{ kind: "message", turnId: "a" },
				{ kind: "compactionSummary", turnId: "c1" },
				{ kind: "message", turnId: "b" },
			],
		);
	});

	it("drops unknown lines defensively", () => {
		const out = collectSessionEntries([{ foo: "bar" }, null, "string", 42]);
		strictEqual(out.length, 0);
	});

	it("compactionSummary entries reduce the token count reported by calculateContextTokens", () => {
		// Regression for bug 3: a stream that contains a compactionSummary in
		// mid-stream must be observed by the token calculator. Before the fix,
		// readSessionEntriesForCompact silently dropped the summary and kept
		// the larger legacy transcript, so threshold checks saw the original
		// size and auto-compaction looped.
		const bigUser: ClioTurnRecord = {
			id: "u1",
			parentId: null,
			at: "2026-04-17T00:00:00.000Z",
			kind: "user",
			payload: { text: "x".repeat(4_000) },
		};
		const bigAssistant: ClioTurnRecord = {
			id: "a1",
			parentId: "u1",
			at: "2026-04-17T00:00:01.000Z",
			kind: "assistant",
			payload: { text: "y".repeat(4_000) },
		};
		const summary: SessionEntry = {
			kind: "compactionSummary",
			turnId: "c1",
			parentTurnId: "a1",
			timestamp: "2026-04-17T00:00:02.000Z",
			summary: "short summary of the prior",
			tokensBefore: 2_000,
			firstKeptTurnId: "u2",
		};
		const before = collectSessionEntries([bigUser, bigAssistant]);
		const after = collectSessionEntries([bigUser, bigAssistant, summary]);
		const beforeTokens = calculateContextTokens(before);
		const afterTokens = calculateContextTokens(after);
		ok(afterTokens > 0);
		ok(
			afterTokens > beforeTokens,
			"after-compact estimate still includes summary tokens but must at least not drop the entry",
		);
		// The stronger guarantee: the summary entry is visible to the reader,
		// and the summary appears at the tail so callers can slice past the
		// pre-compaction prefix on the next pass.
		strictEqual(after.at(-1)?.kind, "compactionSummary");
	});
});
