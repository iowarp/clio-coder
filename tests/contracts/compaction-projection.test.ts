import { deepStrictEqual, doesNotMatch, match, ok, rejects, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { projectWorkingSet } from "../../src/domains/context/working-set/project.js";
import { resolveRecall } from "../../src/domains/context/working-set/recall.js";
import { type CompactionCallObservation, compact } from "../../src/domains/session/compaction/compact.js";
import { calculateContextTokens } from "../../src/domains/session/compaction/tokens.js";
import { estimateAgentContextTokens } from "../../src/domains/session/context-accounting.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";

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
					content: [{ type: "text", text: "Canonical checkpoint" }],
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
