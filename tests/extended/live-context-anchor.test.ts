import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { planEviction } from "../../src/domains/context/working-set/engine.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import {
	estimateAgentContextBreakdown,
	estimateAgentContextTokens,
	estimateAgentMessageTokens,
} from "../../src/domains/session/context-accounting.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import {
	type ContextEvictionEntry,
	HOST_INSERT_CUSTOM_TYPE,
	type MessageEntry,
	type SessionEntry,
} from "../../src/domains/session/entries.js";
import { createEngineAgent, setEngineSystemPrompt } from "../../src/engine/agent.js";
import type { AgentMessage, Usage } from "../../src/engine/types.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/session-control/model-session-replay.js";
import { createTurnContext, type TurnContextDeps } from "../../src/session-control/turn-context.js";
import type { TurnMiddleware } from "../../src/session-control/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/session-control/turn-state.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

function usage(input = 20281, output = 61): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
function assistant(measured = usage()): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Read the source next." }],
		usage: measured,
		api: "openai-completions",
		provider: "fixture",
		model: "qwen",
		stopReason: "toolUse",
		timestamp: 1,
	};
}
function result(text: string): AgentMessage {
	return {
		role: "toolResult",
		content: [{ type: "text", text }],
		toolCallId: "read1",
		toolName: "read",
		isError: false,
		timestamp: 2,
	};
}
function entry(
	turnId: string,
	parentTurnId: string | null,
	role: MessageEntry["role"],
	payload: unknown,
): MessageEntry {
	return { kind: "message", turnId, parentTurnId, role, payload, timestamp: "2026-09-06T00:00:00.000Z" };
}

describe("live measured context anchor", () => {
	let isolated: IsolatedClioEnv;
	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-coder-live-anchor-");
	});
	afterEach(() => isolated.restore());
	function fixture(overrides: Partial<TurnContextDeps> = {}) {
		const state = createTurnState("medium");
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.context.compaction.threshold = 0.85;
		settings.chat.maxOutputTokens = 8192;
		const runtime = {
			targetId: "dynamo",
			runtimeId: "openai-compat",
			wireModelId: "qwen",
			runtimeResolution: {
				capabilityDecisions: { maxTokens: 8192 },
				contextWindowDetails: {
					desiredContextWindow: 32768,
					effectiveContextWindow: 32768,
					contextWindowSource: "configured",
				},
			},
			agent: createEngineAgent({
				initialState: {
					model: {
						id: "qwen",
						baseUrl: "http://source.invalid",
						maxTokens: 8192,
						contextWindow: 32768,
					} as AgentRuntime["agent"]["state"]["model"],
					systemPrompt: "system".repeat(100),
					messages: [assistant()],
					tools: [
						{
							name: "read",
							label: "Read",
							description: "s".repeat(27000),
							parameters: { type: "object" },
							execute: async () => ({ content: [], details: {} }),
						},
					],
				},
			}).agent,
		} as unknown as AgentRuntime;
		state.runtime = runtime;
		let summaries = 0;
		const context = createTurnContext({
			state,
			getSettings: () => settings,
			providers: {} as ProvidersContract,
			readSessionEntries: () => [],
			autoCompact: async () => {
				summaries += 1;
				return null;
			},
			middleware: { fireCompactionHook: () => {} } as unknown as TurnMiddleware,
			emitNotice: () => {},
			...overrides,
		});
		return { state, runtime, settings, context, summaries: () => summaries };
	}

	it("refreshes tool-result decomposition each API call without inflating definitions or counting output twice", () => {
		const f = fixture();
		f.context.setCurrentSnapshot(f.context.captureRuntimeContextSnapshot(f.runtime, "turn", 0.85));
		f.context.reconcileUsage(usage(20000, 61));
		const before = f.context.contextLedger();
		const definitions = before.groups.find((group) => group.category === "tools")?.tokens;
		f.runtime.agent.state.messages.push(result("read result ".repeat(4000)), assistant(usage(35000, 100)));
		f.context.reconcileUsage(usage(35000, 100));
		const after = f.context.contextLedger();
		strictEqual(after.groups.find((group) => group.category === "tools")?.tokens, definitions);
		ok((after.groups.find((group) => group.category === "toolResults")?.tokens ?? 0) > 10000);
		strictEqual(after.usedTokens, 35100);
		strictEqual(after.groups.find((group) => group.category === "streaming")?.tokens, 100);
		strictEqual(after.toolCount, 1);
	});

	it("counts the measured schema once and avoids the reproduced false pressure without losing pending or trailing text", async () => {
		const f = fixture();
		// The trigger counts the summary's 8192-token output reservation; this request still fits below it.
		f.settings.context.compaction.threshold = 0.95;
		f.context.reconcileUsage(usage());
		const tail = result("source".repeat(660));
		f.runtime.agent.state.messages.push(tail);
		const raw = structuredClone(f.runtime.agent.state.messages);
		const expected = 20342 + estimateAgentMessageTokens(tail);
		strictEqual(f.context.liveContextEstimate(f.runtime).tokens, expected);
		strictEqual(f.context.liveContextEstimate(f.runtime, "pending text").tokens, expected + 20);
		ok(expected + 8192 < 32768 * 0.95);
		strictEqual(await f.context.runAutoCompact(f.runtime, false), false);
		strictEqual(f.summaries(), 0);
		deepStrictEqual(f.runtime.agent.state.messages, raw);
		// /fork and /resume drop the live anchor; the replayed usage must not charge the schema a second time.
		f.context.resetForSession();
		strictEqual(f.context.contextUsage().tokens, expected);
	});

	it("prices independent positive schema and system growth without netting shrinkage or recharging on fresh usage", () => {
		const f = fixture();
		f.context.reconcileUsage(usage());
		const baseline = estimateAgentContextBreakdown(f.runtime.agent.state);
		const tool = f.runtime.agent.state.tools[0];
		ok(tool);
		setEngineSystemPrompt(f.runtime.agent, "");
		tool.description += "g".repeat(400);
		strictEqual(
			f.context.liveContextEstimate(f.runtime).tokens,
			20442,
			"system shrink does not erase 100 tokens of new tools",
		);
		setEngineSystemPrompt(f.runtime.agent, "s".repeat((baseline.systemPromptTokens + 200) * 4));
		strictEqual(f.context.liveContextEstimate(f.runtime).tokens, 20642);
		tool.description = "small";
		strictEqual(f.context.liveContextEstimate(f.runtime).tokens, 20542, "tool shrink does not erase system growth");
		f.context.reconcileUsage(usage(21000, 20));
		strictEqual(f.context.liveContextEstimate(f.runtime).tokens, 21020, "fresh usage includes the changed surface");
	});

	it("keeps the structural floor and retains a measured anchor when forced compaction is empty", async () => {
		const f = fixture();
		f.context.reconcileUsage(usage(100, 20));
		const breakdown = estimateAgentContextBreakdown(f.runtime.agent.state);
		const structural = breakdown.systemPromptTokens + breakdown.messageTokens + breakdown.toolSchemaTokens;
		strictEqual(f.context.liveContextEstimate(f.runtime).tokens, structural);
		strictEqual(await f.context.runAutoCompact(f.runtime, true), false);
		strictEqual(f.summaries(), 1);
		strictEqual(f.context.liveContextEstimate(f.runtime).reconciledTokens, 120);
	});

	for (const change of ["shorter", "replaced", "runtime", "target", "model", "endpoint", "reset"] as const) {
		it(`declines a stale measured anchor after ${change}`, () => {
			const f = fixture();
			f.context.reconcileUsage(usage());
			if (change === "shorter") f.runtime.agent.state.messages = [];
			if (change === "replaced") f.runtime.agent.state.messages = [assistant(usage(100, 5))];
			if (change === "runtime") f.state.runtime = { ...f.runtime };
			if (change === "target") f.runtime.targetId = "mini";
			const model = f.runtime.agent.state.model;
			ok(model);
			if (change === "model") f.runtime.agent.state.model = { ...model, id: "other" };
			if (change === "endpoint") model.baseUrl = "http://another.invalid";
			if (change === "reset") f.context.resetForSession();
			const current = f.state.runtime;
			ok(current);
			strictEqual(f.context.liveContextEstimate(current).reconciledTokens, null);
			strictEqual(f.context.liveContextEstimate(current).tokens, estimateAgentContextTokens(current.agent.state));
		});
	}

	it("carries the retained post-reconcile tail and static growth once through actual eviction replay", async () => {
		const entries: SessionEntry[] = [
			entry("u", null, "user", { text: "Inspect sources" }),
			entry("old", "u", "tool_result", {
				toolCallId: "old-read",
				toolName: "read",
				result: { content: [{ type: "text", text: "old".repeat(2000) }] },
			}),
			entry("a", "old", "assistant", {
				content: [{ type: "toolCall", id: "read1", name: "read", arguments: { path: "current.ts" } }],
				usage: usage(24000, 100),
			}),
		];
		const meta = { id: "anchor-session", cwdHash: "anchor-fixture", cwd: isolated.dir } as SessionMeta;
		let evictions = 0;
		const f = fixture({
			readSessionEntries: () => entries,
			session: {
				current: () => meta,
				appendEntry: (fields: object) => {
					const event = { ...fields, turnId: "eviction", timestamp: "2026-09-06T00:00:01.000Z" } as SessionEntry;
					entries.push(event);
					f.state.lastTurnId = event.turnId;
				},
			} as unknown as SessionContract,
			planEviction: () => {
				evictions += 1;
				return {
					policyId: "age-horizon",
					tokensBefore: 1600,
					tokensAfter: 600,
					items: [{ ref: { entry: "old" }, reason: "age_horizon", tokensFreed: 1000, marker: "[evicted ref=old]" }],
				};
			},
		});
		f.settings.context.workingSet.enabled = true;
		f.state.lastTurnId = "a";
		f.runtime.agent.state.messages = buildModelReplayAgentMessagesFromTurns(entries);
		f.context.reconcileUsage(usage(24000, 100));
		entries.push(
			entry("tail", "a", "tool_result", {
				toolCallId: "read1",
				toolName: "read",
				result: { content: [{ type: "text", text: "retained".repeat(300) }] },
			}),
		);
		const tail = buildModelReplayAgentMessagesFromTurns(entries).at(-1);
		ok(tail);
		f.runtime.agent.state.messages.push(tail);
		f.state.lastTurnId = "tail";
		const tool = f.runtime.agent.state.tools[0];
		ok(tool);
		tool.description += "g".repeat(400);
		const original = structuredClone(entries);
		const expected = 24100 + estimateAgentMessageTokens(tail) + 100 - 1000;
		// The summary's 8192-token reservation exceeds the 0.85 threshold's headroom, so the trigger is
		// 32768 - 8192 tokens, and the eviction alone clears it.
		ok(expected + 1000 >= 32768 - 8192 && expected < 32768 - 8192);
		strictEqual(await f.context.runAutoCompact(f.runtime, false), true);
		strictEqual(evictions, 1);
		strictEqual(f.summaries(), 0);
		strictEqual(f.context.liveContextEstimate(f.runtime).reconciledTokens, expected);
		strictEqual(f.context.liveContextEstimate(f.runtime).tokens, expected);
		strictEqual(f.context.liveContextEstimate(f.runtime, "pending text").tokens, expected + 20);
		deepStrictEqual(entries.slice(0, original.length), original, "raw observations and usage stay unchanged");
		ok(JSON.stringify(f.runtime.agent.state.messages).includes("retained"));
		ok(!JSON.stringify(f.runtime.agent.state.messages).includes("oldoldold"));
	});

	// r1 sits alone between two measured calls, so the provider measured it at 20650 - 18050 = 2600 tokens.
	const U1 = usage(18000, 50);
	const U2 = usage(20650, 50);
	const callRow = (id: string, measured: Usage) => ({
		content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }],
		usage: measured,
	});
	const readRow = (id: string, text: string) => ({
		toolCallId: id,
		toolName: "read",
		result: { content: [{ type: "text", text }] },
	});

	/** A live session that measured U2 at a2, appended r2, and folded `evict` on its next pressure check. */
	async function foldScenario(options: { evict: string[]; insert?: boolean; resumed?: boolean }) {
		const entries: SessionEntry[] = [
			entry("u", null, "user", { text: "Inspect sources" }),
			entry("c1", "u", "assistant", callRow("read1", U1)),
			entry("r1", "c1", "tool_result", readRow("read1", "alpha ".repeat(1000))),
		];
		if (options.insert)
			entries.push({
				kind: "custom",
				turnId: "ins",
				parentTurnId: "r1",
				customType: HOST_INSERT_CUSTOM_TYPE,
				data: {
					version: 1,
					id: "ins1",
					source: "reminder",
					elements: [{ role: "user", content: "Keep the tests green.", timestamp: 3 }],
					place: { after: "r1" },
				},
				timestamp: "2026-09-06T00:00:00.000Z",
			} as SessionEntry);
		entries.push(entry("a2", options.insert ? "ins" : "r1", "assistant", callRow("read2", U2)));
		let meta = { id: "fold-session", cwdHash: "fold-fixture", cwd: isolated.dir } as SessionMeta;
		let appended = 0;
		let plans = 0;
		const f = fixture({
			readSessionEntries: () => entries,
			session: {
				current: () => meta,
				appendEntry: (fields: object) => {
					appended += 1;
					const row = { ...fields, turnId: `ev${appended}`, timestamp: "2026-09-06T00:00:01.000Z" } as SessionEntry;
					entries.push(row);
					f.state.lastTurnId = row.turnId;
					return row;
				},
			} as unknown as SessionContract,
			planEviction: (_policy, input) => {
				plans += 1;
				const refs = options.evict.map((id) => ({ ref: { entry: id }, reason: "age_horizon" as const }));
				return planEviction({ id: "age-horizon", select: () => refs }, input);
			},
		});
		f.settings.context.workingSet.enabled = true;
		const render = () =>
			buildModelReplayAgentMessagesFromTurns(entries, {
				...(f.state.lastTurnId ? { activeLeafTurnId: f.state.lastTurnId } : {}),
			});
		const navigate = (leaf: string) => {
			f.state.lastTurnId = leaf;
			f.runtime.agent.state.messages = render();
			f.context.resetForSession();
		};
		const resultMessage = (id: string) => {
			const found = render().find((message) => message.role === "toolResult" && message.toolCallId === id);
			ok(found);
			return found;
		};
		f.state.lastTurnId = "a2";
		f.runtime.agent.state.messages = render();
		if (!options.resumed) f.context.reconcileUsage(U2);
		entries.push(entry("r2", "a2", "tool_result", readRow("read2", "beta ".repeat(3800))));
		f.state.lastTurnId = "r2";
		if (options.resumed) navigate("r2");
		else f.runtime.agent.state.messages.push(render().at(-1) as AgentMessage);
		const before = {
			r1: estimateAgentMessageTokens(resultMessage("read1")),
			r2: estimateAgentMessageTokens(resultMessage("read2")),
		};
		const structuralBefore = estimateAgentContextTokens(f.runtime.agent.state);
		const fired = await f.context.runAutoCompact(f.runtime, false);
		const record = entries.find((row): row is ContextEvictionEntry => row.kind === "contextEviction");
		ok(fired && record, "the fixture's eviction commits");
		strictEqual(f.summaries(), 0, "the eviction alone clears the trigger");
		const markers = {
			r1: estimateAgentMessageTokens(resultMessage("read1")),
			r2: estimateAgentMessageTokens(resultMessage("read2")),
		};
		return {
			f,
			entries,
			record,
			before,
			markers,
			structuralBefore,
			plans: () => plans,
			navigate,
			setSession: (id: string) => {
				meta = { ...meta, id };
			},
		};
	}

	const anchorCases = [
		{
			name: "a mixed batch spanning the attestation credits the measured result and the structural tail",
			evict: ["r1", "r2"],
			// r1 is inside the measured prefix at its measured size; r2 is after it, priced structurally, so its marker replaces it.
			expected: (s: Awaited<ReturnType<typeof foldScenario>>) => U2.totalTokens - 2600 + s.markers.r1 + s.markers.r2,
		},
		{
			name: "an isolated expensive result credits its measured size and its marker is priced structurally",
			evict: ["r1"],
			expected: (s: Awaited<ReturnType<typeof foldScenario>>) => U2.totalTokens - 2600 + s.markers.r1 + s.before.r2,
		},
		{
			name: "the same pair separated by an insert is not isolated",
			evict: ["r1"],
			insert: true,
			expected: (s: Awaited<ReturnType<typeof foldScenario>>) => U2.totalTokens - s.before.r1 + s.markers.r1 + s.before.r2,
		},
	];
	for (const anchorCase of anchorCases) {
		it(`anchors the eviction record live and after reopen: ${anchorCase.name}`, async () => {
			const s = await foldScenario(anchorCase);
			const expected = anchorCase.expected(s);
			ok(s.before.r1 < 2600, "the measured size differs from the structural one");
			strictEqual(s.record.anchor?.tokens, expected);
			strictEqual(s.f.context.liveContextEstimate(s.f.runtime).reconciledTokens, expected);
			s.navigate(s.record.turnId);
			strictEqual(s.f.context.liveContextEstimate(s.f.runtime).reconciledTokens, expected);
			strictEqual(s.f.context.liveContextEstimate(s.f.runtime).tokens, expected);
		});
	}

	it("declines the record's anchor after reopen on another route under the same model id", async () => {
		const s = await foldScenario({ evict: ["r1", "r2"] });
		s.f.runtime.targetId = "mini";
		s.navigate(s.record.turnId);
		const live = s.f.context.liveContextEstimate(s.f.runtime);
		strictEqual(live.reconciledTokens, null);
		strictEqual(live.tokens, estimateAgentContextTokens(s.f.runtime.agent.state));
	});

	for (const when of ["before", "after"] as const) {
		it(`declines the record's anchor after a same-size prefix rewrite ${when} rehydration`, async () => {
			const s = await foldScenario({ evict: ["r1", "r2"] });
			s.f.state.lastTurnId = s.record.turnId;
			s.f.runtime.agent.state.messages = buildModelReplayAgentMessagesFromTurns(s.entries, {
				activeLeafTurnId: s.record.turnId,
			});
			s.f.context.resetForSession();
			if (when === "after") ok(s.f.context.liveContextEstimate(s.f.runtime).reconciledTokens !== null);
			const first = s.f.runtime.agent.state.messages[0];
			ok(first?.role === "user");
			const rewritten = JSON.stringify(first.content).replace("Inspect sources", "Inspect sourcez");
			first.content = JSON.parse(rewritten);
			strictEqual(s.f.context.liveContextEstimate(s.f.runtime).reconciledTokens, null);
		});
	}

	it("gives a trigger between the structural and the anchored figure the same decision live and after reopen", async () => {
		const decisions: boolean[] = [];
		for (const reopen of [false, true, "other route"] as const) {
			const s = await foldScenario({ evict: ["r1", "r2"] });
			const anchored = s.record.anchor?.tokens ?? 0;
			const structural = estimateAgentContextTokens(s.f.runtime.agent.state);
			s.f.settings.context.compaction.threshold = (structural + anchored) / 2 / 32768;
			// No rearm band, so a trigger past the record's own figure asks the planner rather than holding.
			s.f.settings.context.workingSet.rearmFraction = 0;
			ok(structural < anchored - 2000, "the band is wide enough to tell the two bases apart");
			if (reopen === "other route") s.f.runtime.targetId = "mini";
			if (reopen !== false) s.navigate(s.record.turnId);
			const plans = s.plans();
			await s.f.context.runAutoCompact(s.f.runtime, false);
			decisions.push(s.plans() > plans || s.f.summaries() > 0);
		}
		deepStrictEqual(decisions, [true, true, false]);
	});

	it("carries a resumed session's replayed usage through its first eviction", async () => {
		const s = await foldScenario({ evict: ["r1"], resumed: true });
		ok(s.record.anchor, "the commit seeds an anchor from the replayed usage");
		const live = s.f.context.liveContextEstimate(s.f.runtime);
		strictEqual(live.tokens, s.record.tokensAfter);
		strictEqual(live.reconciledTokens, s.record.tokensAfter);
		ok(live.tokens > estimateAgentContextTokens(s.f.runtime.agent.state), "not the structural estimate");
	});

	for (const navigation of ["branch", "fork", "resume"] as const) {
		it(`publishes one context figure and the current path's last reduction after a ${navigation}`, async () => {
			const s = await foldScenario({ evict: ["r1", "r2"] });
			s.entries.push(entry("b", "u", "user", { text: "Try the other path" }));
			if (navigation === "branch") s.navigate("b");
			if (navigation === "fork") {
				s.setSession("fork-session");
				s.navigate(s.record.turnId);
			}
			if (navigation === "resume") {
				s.navigate("b");
				s.navigate(s.record.turnId);
			}
			const ledger = s.f.context.contextLedger();
			const live = s.f.context.liveContextEstimate(s.f.runtime);
			strictEqual(ledger.usedTokens, live.tokens);
			strictEqual(ledger.usedTokens, s.f.context.liveBudget().inputTokens);
			if (navigation === "branch") {
				strictEqual(ledger.lastCompaction, null);
				strictEqual(live.reconciledTokens, null);
				return;
			}
			deepStrictEqual(ledger.lastCompaction, {
				stage: "working_set",
				tokensBefore: s.record.tokensBefore,
				tokensAfter: s.record.tokensAfter,
				trigger: "pressure",
			});
			strictEqual(live.reconciledTokens, s.record.anchor?.tokens);
		});
	}
});
