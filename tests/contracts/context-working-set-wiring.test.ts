import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BusChannels, type ContextPrunedPayload } from "../../src/core/bus-events.js";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { EvictionPlan } from "../../src/domains/context/working-set/contract.js";
import type { CompactResult } from "../../src/domains/session/compaction/compact.js";
import type { SessionContract, SessionEntryInput, SessionMeta } from "../../src/domains/session/contract.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { createTurnContext } from "../../src/interactive/turn-context.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";

const priorLegacyMask = process.env.CLIO_CODER_LEGACY_MASK;

afterEach(() => {
	if (priorLegacyMask === undefined) delete process.env.CLIO_CODER_LEGACY_MASK;
	else process.env.CLIO_CODER_LEGACY_MASK = priorLegacyMask;
});

function fixtureEntries(): SessionEntry[] {
	const staleBody = `${"large observation line\n".repeat(300)}done`;
	return [
		{
			kind: "message",
			turnId: "user-old",
			parentTurnId: null,
			timestamp: "2026-08-21T00:00:00.000Z",
			role: "user",
			payload: { text: "read the large fixture" },
		} satisfies MessageEntry,
		{
			kind: "message",
			turnId: "result-old",
			parentTurnId: "user-old",
			timestamp: "2026-08-21T00:00:01.000Z",
			role: "tool_result",
			payload: {
				toolCallId: "call-read",
				toolName: "read",
				result: { content: [{ type: "text", text: staleBody }] },
				isError: false,
			},
		} satisfies MessageEntry,
		{
			kind: "message",
			turnId: "user-recent",
			parentTurnId: "result-old",
			timestamp: "2026-08-21T00:00:02.000Z",
			role: "user",
			payload: { text: "continue" },
		} satisfies MessageEntry,
	];
}

function testSettings(enabled = true): ClioSettings {
	const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	settings.compaction.threshold = 0.5;
	settings.compaction.excludeLastTurns = 1;
	settings.context.workingSet.enabled = enabled;
	return settings;
}

function fakeRuntime(): AgentRuntime {
	return {
		targetId: "test-target",
		runtimeId: "test-runtime",
		wireModelId: "test-model",
		agent: {
			sessionId: undefined,
			state: {
				systemPrompt: "",
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "x".repeat(5_000) }],
						timestamp: Date.now(),
					} as AgentMessage,
				],
				tools: [],
				model: undefined,
				thinkingLevel: "off",
			},
		} as never,
		runtimeResolution: {
			contextWindowDetails: {
				desiredContextWindow: 1_000,
				effectiveContextWindow: 1_000,
				contextWindowSource: "descriptor-default",
			},
		} as never,
	};
}

function fakeSession(entries: SessionEntry[]): {
	contract: SessionContract;
	appended: SessionEntry[];
	replaceCalls: () => number;
} {
	const appended: SessionEntry[] = [];
	let replaces = 0;
	let nextId = 0;
	const meta = {
		id: "session-working-set",
		createdAt: "2026-08-21T00:00:00.000Z",
		cwd: process.cwd(),
	} as SessionMeta;
	const contract = {
		current: () => meta,
		appendEntry(input: SessionEntryInput) {
			const entry = {
				...input,
				turnId: input.turnId ?? `sidecar-${++nextId}`,
				timestamp: input.timestamp ?? "2026-08-21T00:00:03.000Z",
			} as SessionEntry;
			entries.push(entry);
			appended.push(entry);
			return entry;
		},
		replaceEntries(next: ReadonlyArray<SessionEntry>) {
			replaces += 1;
			entries.splice(0, entries.length, ...next);
		},
	} as SessionContract;
	return { contract, appended, replaceCalls: () => replaces };
}

function fakePlan(): EvictionPlan {
	return {
		policyId: "age-horizon",
		items: [
			{
				ref: { entry: "result-old" },
				reason: "age_horizon",
				tokensFreed: 1_000,
				marker: "[working-set ref=result-old]",
			},
		],
		tokensBefore: 1_250,
		tokensAfter: 250,
	};
}

function harness(
	enabled = true,
	withSummary = true,
	tier: "local-native" | "cloud" = "local-native",
	plan: EvictionPlan | null = fakePlan(),
) {
	const entries = fixtureEntries();
	const session = fakeSession(entries);
	const settings = testSettings(enabled);
	const bus = createSafeEventBus();
	const pruned: ContextPrunedPayload[] = [];
	bus.on(BusChannels.ContextPruned, (payload) => {
		pruned.push(payload);
	});
	const hookStages: string[] = [];
	const hookTriggers: string[] = [];
	let summaryCalls = 0;
	let plannerCalls = 0;
	const state = createTurnState("off");
	state.lastTurnId = "user-recent";
	const runtime = fakeRuntime();
	state.runtime = runtime;
	const context = createTurnContext({
		state,
		getSettings: () => settings,
		providers: { getRuntime: () => ({ tier }) } as never,
		session: session.contract,
		readSessionEntries: () => entries,
		...(withSummary
			? {
					autoCompact: async (): Promise<CompactResult | null> => {
						summaryCalls += 1;
						return null;
					},
				}
			: {}),
		planEviction: () => {
			plannerCalls += 1;
			return plan;
		},
		bus,
		middleware: {
			fireCompactionHook(stage: string, trigger: string) {
				hookStages.push(stage);
				hookTriggers.push(trigger);
			},
		} as never,
		emitNotice: () => {},
	});
	return {
		context,
		state,
		bus,
		entries,
		runtime,
		session,
		pruned,
		hookStages,
		hookTriggers,
		summaryCalls: () => summaryCalls,
		plannerCalls: () => plannerCalls,
	};
}

describe("contracts/context working-set compaction wiring", () => {
	it("appends one active-path eviction, never rewrites entries, and emits the working-set stage", async () => {
		delete process.env.CLIO_CODER_LEGACY_MASK;
		const h = harness(true);

		await h.context.runAutoCompact(h.runtime, false);

		const evictions = h.session.appended.filter((entry) => entry.kind === "contextEviction");
		strictEqual(evictions.length, 1);
		strictEqual(evictions[0]?.parentTurnId, "user-recent", "eviction sidecar is anchored to the current leaf");
		strictEqual(h.session.replaceCalls(), 0, "normal working-set eviction must keep the ledger append-only");
		strictEqual(h.pruned[0]?.stage, "working_set");
		strictEqual(h.pruned[0]?.policyId, "age-horizon");
		strictEqual(h.pruned[0]?.evictedItems, 1);
		ok(h.hookStages.includes("working_set_evict"));
		strictEqual(h.hookTriggers[h.hookStages.indexOf("working_set_evict")], "pressure");
	});

	it("attributes the next local cold run and context ledger to working-set eviction", async () => {
		delete process.env.CLIO_CODER_LEGACY_MASK;
		const h = harness(true, false);
		await h.context.runAutoCompact(h.runtime, false);

		h.context.consumeExpectedColdReasons("test-runtime");
		const usage = {
			input: 1_000,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_010,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const promptCache = h.context.promptCachePayloadForAssistant(usage);
		deepStrictEqual(promptCache.expectedColdReasons, ["working_set_evict"]);

		h.context.noteRunCacheSummary(
			[{ role: "assistant", content: [], stopReason: "stop", timestamp: Date.now(), usage } as unknown as AgentMessage],
			"cold",
		);
		deepStrictEqual(h.context.contextLedger().promptCache?.expectedColdReasons, ["working_set_evict"]);
	});

	it("stamps working_set_evict on a cloud tier too: the prefix changed, whatever the backend", async () => {
		delete process.env.CLIO_CODER_LEGACY_MASK;
		const h = harness(true, false, "cloud");
		await h.context.runAutoCompact(h.runtime, false);

		h.context.consumeExpectedColdReasons("test-runtime");
		const usage = {
			input: 1_000,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_010,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		deepStrictEqual(h.context.promptCachePayloadForAssistant(usage).expectedColdReasons, ["working_set_evict"]);
	});

	it("keeps the dispatch disturbance gated to local-native tiers", async () => {
		const h = harness(true, false, "cloud");
		h.bus.emit(BusChannels.DispatchStarted, {} as never);
		h.context.consumeExpectedColdReasons("test-runtime");
		const usage = {
			input: 1_000,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_010,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		strictEqual(h.context.promptCachePayloadForAssistant(usage).expectedColdReasons, undefined);
	});

	it("attributes an in-run post-tool eviction to the immediate continuation", async () => {
		delete process.env.CLIO_CODER_LEGACY_MASK;
		const h = harness(true, false);
		h.state.streaming = true;

		await h.context.runAutoCompact(h.runtime, false);

		const usage = {
			input: 1_000,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_010,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const continuationCache = h.context.promptCachePayloadForAssistant(usage);
		deepStrictEqual(continuationCache.expectedColdReasons, ["working_set_evict"]);
		strictEqual(
			h.context.promptCachePayloadForAssistant(usage).expectedColdReasons,
			undefined,
			"the reason is stamped once, on the immediate continuation",
		);
	});

	it("routes successful recall events through on_compaction without adding a new hook", () => {
		const h = harness(true, false);
		h.bus.emit(BusChannels.ContextRecalled, {
			ref: "result-old",
			trigger: "tool",
			tokensReadmitted: 1_000,
			at: Date.now(),
		});

		deepStrictEqual(h.hookStages, ["working_set_recall"]);
		deepStrictEqual(h.hookTriggers, ["tool"]);
	});

	it("keeps the destructive mask path only behind CLIO_CODER_LEGACY_MASK=1", async () => {
		process.env.CLIO_CODER_LEGACY_MASK = "1";
		const h = harness(true);

		await h.context.runAutoCompact(h.runtime, false);

		strictEqual(h.session.replaceCalls(), 1);
		strictEqual(
			h.session.appended.some((entry) => entry.kind === "contextEviction"),
			false,
		);
		strictEqual(h.plannerCalls(), 0);
		strictEqual(h.pruned[0]?.stage, "mask_observations");
		ok(h.hookStages.includes("mask_observations"));
	});

	it("skips eviction and masking when disabled and probes summary compaction", async () => {
		delete process.env.CLIO_CODER_LEGACY_MASK;
		const h = harness(false);

		await h.context.runAutoCompact(h.runtime, false);

		strictEqual(h.plannerCalls(), 0);
		strictEqual(h.session.replaceCalls(), 0);
		deepStrictEqual(h.session.appended, []);
		strictEqual(h.summaryCalls(), 1);
		deepStrictEqual(h.hookStages, [], "an empty automatic summary probe does not publish a lifecycle");
	});

	it("does not publish or repeat an empty automatic attempt within one turn", async () => {
		delete process.env.CLIO_CODER_LEGACY_MASK;
		const h = harness(true, true, "local-native", null);
		h.state.activeUserTurnId = "user-recent";
		let compactionBegins = 0;
		h.bus.on(BusChannels.CompactionBegin, () => {
			compactionBegins += 1;
		});

		await h.context.runAutoCompact(h.runtime, false);
		await h.context.runAutoCompact(h.runtime, false);

		strictEqual(h.plannerCalls(), 1, "the empty planner is probed once per user turn");
		strictEqual(h.summaryCalls(), 1, "the empty summary path is probed once per user turn");
		strictEqual(compactionBegins, 0, "an empty automatic probe is not a compaction lifecycle");
		deepStrictEqual(h.hookStages, []);

		h.context.consumeExpectedColdReasons("test-runtime");
		const usage = {
			input: 1_000,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_010,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		strictEqual(h.context.promptCachePayloadForAssistant(usage).expectedColdReasons, undefined);
	});
});
