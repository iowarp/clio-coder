import { deepStrictEqual, doesNotMatch, match, ok, rejects, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { projectWorkingSet } from "../../src/domains/context/working-set/project.js";
import { resolveRecall } from "../../src/domains/context/working-set/recall.js";
import { type CompactionCallObservation, compact } from "../../src/domains/session/compaction/compact.js";
import { calculateContextTokens, estimateTokens } from "../../src/domains/session/compaction/tokens.js";
import { estimateAgentContextTokens } from "../../src/domains/session/context-accounting.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/interactive/model-session-replay.js";
import { syntheticCompactionSummary } from "../harness/compaction-summary.js";

const timestamp = "2026-09-06T00:00:00.000Z";
function message(turnId: string, role: MessageEntry["role"], payload: unknown): MessageEntry {
	return { kind: "message", turnId, parentTurnId: null, timestamp, role, payload };
}
function chain(entries: SessionEntry[]): SessionEntry[] {
	return entries.map((entry, index) => ({ ...entry, parentTurnId: entries[index - 1]?.turnId ?? null }));
}
function evictedHistory(): SessionEntry[] {
	return chain([
		message("u1", "user", { text: "Keep the exact constraint CONSTRAINT_42" }),
		message("a1", "assistant", {
			usage: { input: 60000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 60100 },
			content: [
				{ type: "thinking", thinking: `EVICTED_THINKING ${"x".repeat(212000)}` },
				{ type: "text", text: "Visible decision" },
				{ type: "toolCall", id: "call1", name: "read", arguments: { path: "src/evidence.ts" } },
			],
		}),
		message("r1", "tool_result", {
			toolCallId: "call1",
			toolName: "read",
			result: { content: [{ type: "text", text: "EVICTED_TOOL_BODY" }] },
		}),
		{
			kind: "contextEviction",
			turnId: "eviction",
			parentTurnId: null,
			timestamp,
			policyId: "age-horizon",
			trigger: "pressure",
			tokensBefore: 54000,
			tokensAfter: 1000,
			pressureBefore: 0.9,
			snapshotIdBefore: null,
			evicted: ["a1", "r1"].map((entry) => ({
				ref: { entry },
				reason: "age_horizon" as const,
				tokensFreed: 100,
				marker: `[evicted ref=${entry} reason=age_horizon]`,
			})),
		},
		message("u2", "user", { text: "Newest request" }),
	]);
}

describe("compaction working-set provider boundary", () => {
	let faux: ReturnType<typeof registerEngineFauxProvider>;
	let calls: Array<{ text: string; inputTokens: number; maxTokens: number | undefined }>;
	beforeEach(() => {
		calls = [];
		faux = registerEngineFauxProvider({
			api: "compaction-projection-fixture",
			models: [{ id: "summary" }],
			tokensPerSecond: 0,
		});
		faux.setResponses(
			Array.from({ length: 10 }, () => (context, options, _state, resolved) => {
				calls.push({
					text: JSON.stringify(context),
					inputTokens: estimateAgentContextTokens(context),
					maxTokens: options?.maxTokens,
				});
				return {
					role: "assistant",
					content: [{ type: "text", text: syntheticCompactionSummary("Canonical checkpoint") }],
					api: resolved.api,
					provider: resolved.provider,
					model: resolved.id,
					stopReason: "stop",
					timestamp: Date.now(),
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
			}),
		);
	});
	afterEach(() => faux.unregister());
	function model(contextWindow = 32768, maxTokens = 4096) {
		const resolved = faux.getModel("summary");
		ok(resolved);
		return { ...resolved, contextWindow, maxTokens };
	}

	it("retains the entire parallel declaration when the budget crosses a call row", async () => {
		const entries = chain([
			message("task", "user", { text: "Continue the MPI repair; do not change numerical tolerances." }),
			message("earlier", "assistant", { text: "Earlier evidence ".repeat(1000) }),
			message("batch", "assistant", {
				content: [
					{ type: "text", text: "Compare both rank layouts before modifying the exchange." },
					{ type: "toolCall", id: "one", name: "read", arguments: { path: "one.c" } },
					{ type: "toolCall", id: "two", name: "read", arguments: { path: "two.c" } },
				],
			}),
			message("call-one", "tool_call", { toolCallId: "one", name: "read", args: { path: "one.c" } }),
			message("call-two", "tool_call", { toolCallId: "two", name: "read", args: { path: "two.c" } }),
			message("result-one", "tool_result", {
				toolCallId: "one",
				toolName: "read",
				result: { content: [{ type: "text", text: "FIRST_EVIDENCE" }] },
			}),
			message("result-two", "tool_result", {
				toolCallId: "two",
				toolName: "read",
				result: { content: [{ type: "text", text: "SECOND_EVIDENCE" }] },
			}),
		]);
		const result = await compact({
			entries,
			model: model(),
			keepRecentTokens: entries.slice(-2).reduce((sum, entry) => sum + estimateTokens(entry), 0) + 1,
		});
		const replay = buildModelReplayAgentMessagesFromTurns([
			...entries,
			{
				kind: "compactionSummary",
				turnId: "summary",
				parentTurnId: "result-two",
				timestamp,
				summary: result.summary,
				firstKeptTurnId: result.firstKeptTurnId ?? "",
				tokensBefore: result.tokensBefore,
				messagesSummarized: result.messagesSummarized,
				...(result.userContext ? { userContext: result.userContext } : {}),
			},
		]);
		const serialized = JSON.stringify(replay);
		match(serialized, /Compare both rank layouts before modifying the exchange/);
		match(serialized, /FIRST_EVIDENCE/);
		match(serialized, /SECOND_EVIDENCE/);
		const declarations = replay.flatMap((entry) =>
			entry.role === "assistant"
				? entry.content.filter((block) => block.type === "toolCall").map((block) => block.id)
				: [],
		);
		deepStrictEqual(declarations, ["one", "two"]);
		strictEqual(result.firstKeptTurnId, "batch");
		strictEqual(
			result.userContext?.text,
			"Continue the MPI repair; do not change numerical tolerances.",
			"manual compaction preserves the latest operator intent without an explicit active-turn hint",
		);
	});

	for (const cancelBeforeCall of [true, false]) {
		it(`rejects cancellation ${cancelBeforeCall ? "before invocation" : "before accepting a late summary"}`, async () => {
			const controller = new AbortController();
			const observations: CompactionCallObservation[] = [];
			let invoked = 0;
			if (cancelBeforeCall) controller.abort();
			await rejects(
				compact({
					entries: evictedHistory(),
					model: model(),
					signal: controller.signal,
					onCall: (call) => observations.push(call),
					summarize: async () => {
						invoked++;
						controller.abort();
						return { text: syntheticCompactionSummary("Late checkpoint"), usage: { input: 10, output: 5, totalTokens: 15 } };
					},
				}),
				/abort/i,
			);
			strictEqual(invoked, cancelBeforeCall ? 0 : 1);
			strictEqual(observations.length, invoked);
			if (!cancelBeforeCall) {
				strictEqual(observations[0]?.outcome, "aborted");
				strictEqual((observations[0]?.usage as { totalTokens: number }).totalTokens, 15);
			}
		});
	}

	it("invalidates pre-checkpoint usage with eviction while fresh provider usage anchors replay again", () => {
		const entries = chain([
			...evictedHistory(),
			message("retained", "assistant", {
				text: "Retained answer",
				usage: { input: 60000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 60100 },
			}),
			{
				kind: "compactionSummary",
				turnId: "checkpoint",
				parentTurnId: null,
				timestamp,
				summary: "Canonical state",
				firstKeptTurnId: "u2",
				tokensBefore: 60100,
				messagesSummarized: 3,
			},
		]);
		const original = structuredClone(entries);
		const projected = projectWorkingSet(entries, foldWorkingSet(entries));
		const retained = projected.find((entry) => entry.turnId === "retained");
		ok(retained?.kind === "message");
		strictEqual((retained.payload as { contextUsageInvalidated: boolean }).contextUsageInvalidated, true);
		deepStrictEqual(projectWorkingSet(projected, foldWorkingSet(projected)), projected);
		const replay = buildModelReplayAgentMessagesFromTurns(entries);
		ok(estimateAgentContextTokens({ messages: replay }) < 1000);
		deepStrictEqual(entries, original, "projection preserves sealed provider usage and raw observations");
		entries.push({
			...message("fresh", "assistant", {
				text: "Fresh measured response",
				usage: { input: 40000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 40100 },
			}),
			parentTurnId: "retained",
		});
		const freshReplay = buildModelReplayAgentMessagesFromTurns(entries);
		ok(
			estimateAgentContextTokens({ messages: freshReplay }) >= 40100,
			"a genuinely post-checkpoint provider count becomes authoritative again",
		);
	});

	it("does not invalidate the selected branch with an abandoned sibling checkpoint", () => {
		const entries: SessionEntry[] = [
			message("root", "user", { text: "Task" }),
			{
				...message("active", "assistant", {
					text: "Active measured response",
					usage: { input: 40000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 40100 },
				}),
				parentTurnId: "root",
			},
			{ ...message("sibling", "user", { text: "Abandoned" }), parentTurnId: "root" },
			{
				kind: "compactionSummary",
				turnId: "abandoned-checkpoint",
				parentTurnId: "sibling",
				timestamp,
				summary: "Abandoned checkpoint",
				firstKeptTurnId: "sibling",
				tokensBefore: 50000,
				messagesSummarized: 1,
			},
		];
		const replay = buildModelReplayAgentMessagesFromTurns(entries, { activeLeafTurnId: "active" });
		ok(estimateAgentContextTokens({ messages: replay }) >= 40100);
		doesNotMatch(JSON.stringify(replay), /Abandoned/);
	});

	for (const operatorText of [undefined, "", " \n\t"]) {
		it(`preserves legacy text when canonical operator text is ${JSON.stringify(operatorText)}`, async () => {
			const entries = evictedHistory();
			const user = entries[0];
			ok(user?.kind === "message");
			const text = "No edits.\nRun Scout then dependent Documenter.";
			user.payload = { text, ...(operatorText === undefined ? {} : { operatorText }) };
			const result = await compact({ entries, model: model(), keepRecentTokens: 100000, preserveUserTurnId: user.turnId });
			strictEqual(result.userContext?.text, text);
		});
	}

	it("summarizes projected bytes while retaining raw identities, file evidence and exact recall", async (t) => {
		const entries = evictedHistory();
		const original = structuredClone(entries);
		const observations: CompactionCallObservation[] = [];
		const result = await compact({
			entries,
			model: model(),
			keepRecentTokens: 100000,
			onCall: (call) => observations.push(call),
		});
		strictEqual(calls.length, 1);
		const call = calls[0];
		ok(call);
		t.diagnostic(
			JSON.stringify({
				estimatedInputTokens: call.inputTokens,
				maxOutputTokens: call.maxTokens,
				contextWindow: 32768,
				tokensBefore: result.tokensBefore,
				includesEvictedThinking: call.text.includes("EVICTED_THINKING"),
				includesEvictedToolBody: call.text.includes("EVICTED_TOOL_BODY"),
			}),
		);
		doesNotMatch(call.text, /EVICTED_THINKING|EVICTED_TOOL_BODY/);
		match(call.text, /CONSTRAINT_42/);
		match(call.text, /\[evicted ref=r1/);
		ok(call.inputTokens + (call.maxTokens ?? 0) <= 32768);
		strictEqual(result.firstKeptEntryIndex, 3);
		strictEqual(result.firstKeptTurnId, entries[3]?.turnId);
		strictEqual(result.tokensBefore, calculateContextTokens(projectWorkingSet(entries, foldWorkingSet(entries))));
		ok(result.tokensBefore < 1000, "pre-eviction provider usage must not override the projected estimate");
		match(result.summary, /<read-files>\nsrc\/evidence.ts\n<\/read-files>/);
		match(result.summary, /<recallable-refs>[\s\S]*r1/);
		match(result.summary, /Preview only[\s\S]*scope="recall"[\s\S]*nextOffset/);
		strictEqual(observations.length, 1);
		strictEqual(result.usage?.apiCalls, 1);
		deepStrictEqual(entries, original);
		const recalled = resolveRecall(entries, foldWorkingSet(entries), "r1");
		ok(recalled.ok);
		strictEqual(recalled.result.body, "EVICTED_TOOL_BODY");
	});

	it("carries the latest canonical checkpoint and projected retained suffix into both split prompts", async () => {
		const entries = chain([
			...evictedHistory().slice(0, 4),
			{
				kind: "compactionSummary",
				turnId: "prior",
				parentTurnId: null,
				timestamp,
				summary: "CANONICAL_CONSTRAINT",
				firstKeptTurnId: "a1",
				tokensBefore: 54000,
			},
			message("new-history", "user", { text: "New work" }),
			message("active", "user", { text: "Continue current turn" }),
			message("tail", "assistant", { text: "retained tail".repeat(1000) }),
		]);
		const result = await compact({ entries, model: model(), keepRecentTokens: 1000 });
		strictEqual(result.isSplitTurn, true);
		strictEqual(result.firstKeptEntryIndex, 7);
		strictEqual(result.firstKeptTurnId, "tail");
		strictEqual(calls.length, 2);
		strictEqual(result.usage?.apiCalls, 2);
		for (const call of calls) {
			match(call.text, /CANONICAL_CONSTRAINT/);
			match(call.text, /\[evicted ref=r1/);
			doesNotMatch(call.text, /EVICTED_THINKING|EVICTED_TOOL_BODY|CONSTRAINT_42/);
		}
	});

	it("keeps recalled originals evicted and includes only the explicit recall at the tail", async () => {
		const entries = chain([
			...evictedHistory().slice(0, 4),
			{
				kind: "contextRecall",
				turnId: "recall",
				parentTurnId: null,
				timestamp,
				ref: { entry: "r1" },
				trigger: "tool",
				tokensReadmitted: 10,
				toolCallId: "recall-call",
			},
			message("recall-result", "tool_result", {
				toolCallId: "recall-call",
				toolName: "context_recall",
				result: { content: [{ type: "text", text: "EVICTED_TOOL_BODY" }] },
			}),
			message("newest", "user", { text: "Continue" }),
		]);
		const original = structuredClone(entries);
		await compact({ entries, model: model(), keepRecentTokens: 10000 });
		strictEqual(calls[0]?.text.match(/EVICTED_TOOL_BODY/g)?.length, 1);
		match(calls[0]?.text ?? "", /\[evicted ref=r1/);
		deepStrictEqual(entries, original);
		strictEqual(foldWorkingSet(entries).evicted.has("r1"), true);
	});

	it("keeps operator-private commands out of the actual summarization request", async () => {
		const entries = chain([
			message("old", "user", { text: "Visible request" }),
			{
				kind: "bashExecution",
				turnId: "private",
				parentTurnId: null,
				timestamp,
				command: "PRIVATE_COMMAND",
				output: "PRIVATE_OUTPUT",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
			},
			message("new", "user", { text: "Continue" }),
		]);
		await compact({ entries, model: model(), keepRecentTokens: 10000 });
		strictEqual(calls.length, 1);
		doesNotMatch(calls[0]?.text ?? "", /PRIVATE_COMMAND|PRIVATE_OUTPUT/);
	});

	it("caps summary output at the resolved model limit", async () => {
		await compact({ entries: evictedHistory(), model: model(32768, 512), reserveTokens: 16384, keepRecentTokens: 10000 });
		strictEqual(calls[0]?.maxTokens, 512);
	});

	it("protects the latest skill activation turn while compacting older projected history", async () => {
		const entries = chain([
			...evictedHistory().slice(0, 4),
			message("skill-turn", "user", { text: "Activate the testing skill" }),
			{
				kind: "skillActivation",
				turnId: "skill",
				parentTurnId: null,
				timestamp,
				activation: {
					name: "testing",
					source: "project",
					hash: "abc123",
					filePath: "skills/testing/SKILL.md",
					triggeredBy: "slash-command",
				},
			},
			message("newest", "user", { text: "Keep working" }),
			message("tail", "assistant", { text: "tail".repeat(2000) }),
		]);
		const result = await compact({ entries, model: model(), keepRecentTokens: 100 });
		strictEqual(result.firstKeptEntryIndex, 4);
		strictEqual(result.firstKeptTurnId, "skill-turn");
		strictEqual(result.isSplitTurn, false);
		strictEqual(calls.length, 1);
		doesNotMatch(calls[0]?.text ?? "", /EVICTED_THINKING|EVICTED_TOOL_BODY|Activate the testing skill/);
		match(calls[0]?.text ?? "", /CONSTRAINT_42/);
	});

	it("checks the complete request plus output at the estimated window boundary", async () => {
		const entries = chain([
			message("old", "user", { text: "Retain this constraint" }),
			message("new", "user", { text: "Continue" }),
		]);
		await compact({ entries, model: model(), reserveTokens: 1280 });
		const inputTokens = calls[0]?.inputTokens;
		ok(inputTokens);
		await compact({ entries, model: model(inputTokens + 1024), reserveTokens: 1280 });
		strictEqual(calls.length, 2);
		await rejects(compact({ entries, model: model(inputTokens + 1023), reserveTokens: 1280 }), /estimated input/);
		strictEqual(calls.length, 2);
	});

	it("rejects invalid model and output budgets without a provider call", async () => {
		const entries = chain([message("old", "user", { text: "Old" }), message("new", "user", { text: "New" })]);
		for (const invalid of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
			await rejects(compact({ entries, model: model(invalid) }), /positive finite model context window/);
			await rejects(compact({ entries, model: model(32768, invalid) }), /positive finite model output token limit/);
			await rejects(compact({ entries, model: model(), reserveTokens: invalid }), /positive finite reserve token budget/);
		}
		strictEqual(calls.length, 0);
	});

	for (const oversized of ["conversation", "system", "instructions", "previous"] as const) {
		it(`rejects an oversized ${oversized} before invoking or accounting for a provider`, async () => {
			const huge = "PRESERVE_EXACT_CONSTRAINT ".repeat(10000);
			const entries = chain([
				message("old", "user", { text: oversized === "conversation" ? huge : "Old work" }),
				...(oversized === "previous"
					? [
							{
								kind: "compactionSummary" as const,
								turnId: "prior",
								parentTurnId: null,
								timestamp,
								summary: huge,
								firstKeptTurnId: "",
								tokensBefore: 60000,
							},
						]
					: []),
				message("middle", "user", { text: "New work" }),
				message("new", "user", { text: "Continue" }),
			]);
			const original = structuredClone(entries);
			const observations: CompactionCallObservation[] = [];
			await rejects(
				compact({
					entries,
					model: model(),
					keepRecentTokens: 100000,
					...(oversized === "system" ? { systemPrompt: huge } : {}),
					...(oversized === "instructions" ? { instructions: huge } : {}),
					onCall: (call) => observations.push(call),
				}),
				/compaction.*estimated input.*output.*context window/i,
			);
			strictEqual(calls.length, 0);
			strictEqual(observations.length, 0);
			deepStrictEqual(entries, original);
		});
	}
});
