import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import {
	estimateAgentContextBreakdown,
	estimateAgentContextTokens,
	estimateAgentMessageTokens,
} from "../../src/domains/session/context-accounting.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentMessage, Usage } from "../../src/engine/types.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/interactive/model-session-replay.js";
import { createTurnContext, type TurnContextDeps } from "../../src/interactive/turn-context.js";
import type { TurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";
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
				contextWindowDetails: {
					desiredContextWindow: 32768,
					effectiveContextWindow: 32768,
					contextWindowSource: "configured",
				},
			},
			agent: {
				state: {
					model: { id: "qwen", baseUrl: "http://source.invalid", maxTokens: 8192, contextWindow: 32768 },
					systemPrompt: "system".repeat(100),
					messages: [assistant()],
					tools: [{ name: "read", description: "s".repeat(27000), parameters: { type: "object" } }],
				},
			},
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
	it("counts the measured schema once and avoids the reproduced false pressure without losing pending or trailing text", async () => {
		const f = fixture();
		f.context.reconcileUsage(usage());
		const tail = result("source".repeat(660));
		f.runtime.agent.state.messages.push(tail);
		const raw = structuredClone(f.runtime.agent.state.messages);
		const expected = 20342 + estimateAgentMessageTokens(tail);
		ok(
			estimateAgentContextTokens(f.runtime.agent.state) > 32768 * 0.85,
			"legacy duplicate schema charge crosses pressure threshold",
		);
		strictEqual(f.context.liveContextEstimate(f.runtime).tokens, expected);
		strictEqual(f.context.liveContextEstimate(f.runtime, "pending text").tokens, expected + 3);
		ok(expected + 8192 < 32768);
		strictEqual(await f.context.runAutoCompact(f.runtime, false), false);
		strictEqual(f.summaries(), 0);
		deepStrictEqual(f.runtime.agent.state.messages, raw);
	});

	it("prices independent positive schema and system growth without netting shrinkage or recharging on fresh usage", () => {
		const f = fixture();
		f.context.reconcileUsage(usage());
		const baseline = estimateAgentContextBreakdown(f.runtime.agent.state);
		const tool = f.runtime.agent.state.tools[0];
		ok(tool);
		f.runtime.agent.state.systemPrompt = "";
		tool.description += "g".repeat(400);
		strictEqual(
			f.context.liveContextEstimate(f.runtime).tokens,
			20442,
			"system shrink does not erase 100 tokens of new tools",
		);
		f.runtime.agent.state.systemPrompt = "s".repeat((baseline.systemPromptTokens + 200) * 4);
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
				usage: usage(27500, 100),
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
		f.context.reconcileUsage(usage(27500, 100));
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
		const expected = 27600 + estimateAgentMessageTokens(tail) + 100 - 1000;
		strictEqual(await f.context.runAutoCompact(f.runtime, false), true);
		strictEqual(evictions, 1);
		strictEqual(f.summaries(), 0);
		strictEqual(f.context.liveContextEstimate(f.runtime).reconciledTokens, expected);
		strictEqual(f.context.liveContextEstimate(f.runtime).tokens, expected);
		strictEqual(f.context.liveContextEstimate(f.runtime, "pending text").tokens, expected + 3);
		deepStrictEqual(entries.slice(0, original.length), original, "raw observations and usage stay unchanged");
		ok(JSON.stringify(f.runtime.agent.state.messages).includes("retained"));
		ok(!JSON.stringify(f.runtime.agent.state.messages).includes("oldoldold"));
	});
});
