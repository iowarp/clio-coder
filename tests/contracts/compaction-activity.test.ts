import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels, type ContextActivityPayload } from "../../src/core/bus-events.js";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { CompactResult } from "../../src/domains/session/compaction/compact.js";
import { collectSessionEntries } from "../../src/domains/session/compaction/session-entries.js";
import type { SessionContract, SessionEntryInput, SessionMeta, TurnInput } from "../../src/domains/session/contract.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { fauxAssistantMessage, registerFauxProvider } from "../../src/engine/ai.js";
import { openSession, sessionPaths } from "../../src/engine/session.js";
import type { AgentEvent, AgentMessage, EngineModel } from "../../src/engine/types.js";
import { createProductionAutoCompact } from "../../src/entry/orchestrator.js";
import { type ChatLoopEvent, createChatLoop } from "../../src/interactive/chat-loop.js";
import { buildReplayAgentMessagesFromTurns } from "../../src/interactive/chat-renderer.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// --- Minimal chat-loop harness (mirrors tests/contracts/chat-loop.test.ts). ---

function settings(overrides: Partial<ClioSettings["compaction"]> = {}): ClioSettings {
	const value = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	value.orchestrator.target = "test-target";
	value.orchestrator.model = "model";
	value.targets = [
		{
			id: "test-target",
			runtime: "fake-runtime",
			defaultModel: "model",
			capabilities: { contextWindow: 1000, maxTokens: 256, tools: true, chat: true },
		},
	];
	value.compaction = { ...value.compaction, ...overrides };
	return value;
}

function providers(modelOverride?: EngineModel): ProvidersContract {
	const target: TargetDescriptor = {
		id: "test-target",
		runtime: "fake-runtime",
		defaultModel: "model",
		capabilities: { contextWindow: 1000, maxTokens: 256, tools: true, chat: true },
	};
	const runtime: RuntimeDescriptor = {
		id: "fake-runtime",
		displayName: "Fake Runtime",
		kind: "http",
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 1000, maxTokens: 256 },
		synthesizeModel: () =>
			modelOverride ??
			({
				id: "model",
				name: "model",
				api: "openai-completions",
				provider: "fake-runtime",
				contextWindow: 1000,
				maxTokens: 256,
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} as never),
	};
	const status: TargetStatus = {
		target,
		runtime,
		available: true,
		reason: "test",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...runtime.defaultCapabilities },
		discoveredModels: ["model"],
	};
	return {
		list: () => [status],
		getTarget: (id: string) => (id === target.id ? target : null),
		getRuntime: (id: string) => (id === runtime.id ? runtime : null),
		getDetectedReasoning: () => null,
		probeTarget: async () => status,
		probeReasoningForModel: async () => null,
		knowledgeBase: null,
		auth: {
			statusForTarget: () => ({ kind: "not-required" }) as never,
			resolveForTarget: async () => ({ apiKey: "", source: "none" }) as never,
		} as never,
	} as never;
}

function createSession(entries: SessionEntry[] = []): SessionContract {
	let current: SessionMeta | null = null;
	let counter = 0;
	const nextId = () => `turn-${++counter}`;
	return {
		current: () => current,
		create(input) {
			current = {
				id: "session-1",
				createdAt: new Date().toISOString(),
				cwd: input?.cwd ?? process.cwd(),
				model: input?.model ?? "model",
				target: input?.target ?? "test-target",
			} as SessionMeta;
			return current;
		},
		append(turn: TurnInput) {
			if (!current) this.create();
			const id = turn.id ?? nextId();
			const at = turn.at ?? new Date().toISOString();
			entries.push({
				kind: "message",
				turnId: id,
				parentTurnId: turn.parentId,
				timestamp: at,
				role: turn.kind,
				payload: turn.payload,
			});
			return { ...turn, id, at };
		},
		appendEntry(entry: SessionEntryInput) {
			const withIds = {
				...entry,
				turnId: entry.turnId ?? nextId(),
				parentTurnId: entry.parentTurnId ?? null,
				timestamp: entry.timestamp ?? new Date().toISOString(),
			} as SessionEntry;
			entries.push(withIds);
			return withIds;
		},
		replaceEntries(next) {
			entries.splice(0, entries.length, ...next);
		},
		recordSkillActivation: (activation) => activation,
		checkpoint: async () => {},
		resume: () => current as SessionMeta,
		fork: () => current as SessionMeta,
		tree: () => ({ nodes: [], rootSessionId: "session-1" }) as never,
		switchBranch: () => current as SessionMeta,
		switchTurn: () => current as SessionMeta,
		editLabel: () => {},
		deleteSession: () => {},
		history: () => (current ? [current] : []),
		close: async () => {
			current = null;
		},
	};
}

interface FakeAgent {
	state: {
		systemPrompt: string;
		model: unknown;
		thinkingLevel: string;
		tools: unknown[];
		messages: AgentMessage[];
		errorMessage: string | undefined;
	};
	sessionId: string | undefined;
	maxRetryDelayMs: number | undefined;
	prepareNextTurn: ((signal?: AbortSignal) => Promise<unknown> | unknown) | undefined;
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
	emit(event: AgentEvent): Promise<void>;
	prompt(input: AgentMessage | AgentMessage[]): Promise<void>;
	continue(): Promise<void>;
	followUp(message: AgentMessage): void;
	abort(): void;
	clearAllQueues(): void;
	clearFollowUpQueue(): void;
	clearSteeringQueue(): void;
}

/**
 * Build a fake agent factory. `seedMessages` (when provided) overrides the
 * initial `state.messages` so the pre-submit compaction estimate can be forced
 * over the threshold regardless of the empty replay the loop seeds on the
 * first `ensureRuntime`.
 */
function createFakeAgentFactory(
	promptImpl: (agent: FakeAgent, input: AgentMessage | AgentMessage[]) => Promise<void>,
	seedMessages?: () => AgentMessage[],
	onCreate?: (agent: FakeAgent) => void,
) {
	return ((options: { initialState?: { messages?: AgentMessage[] } } = {}) => {
		const listeners: Array<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void> = [];
		const state = {
			systemPrompt: "",
			model: undefined as unknown,
			thinkingLevel: "off",
			tools: [] as unknown[],
			messages: seedMessages ? seedMessages() : (options.initialState?.messages ?? []),
			errorMessage: undefined as string | undefined,
		};
		const controller = new AbortController();
		const agent: FakeAgent = {
			state,
			sessionId: undefined,
			maxRetryDelayMs: undefined,
			prepareNextTurn: undefined,
			subscribe(listener) {
				listeners.push(listener);
				return () => {};
			},
			async emit(event: AgentEvent) {
				for (const listener of listeners) await listener(event, controller.signal);
			},
			async prompt(input: AgentMessage | AgentMessage[]) {
				await promptImpl(agent, input);
			},
			async continue() {},
			followUp() {},
			abort() {},
			clearAllQueues() {},
			clearFollowUpQueue() {},
			clearSteeringQueue() {},
		};
		onCreate?.(agent);
		return { agent, state: () => state };
	}) as never;
}

function inputMessages(input: AgentMessage | AgentMessage[]): AgentMessage[] {
	return Array.isArray(input) ? input : [input];
}

function compactionActivities(bus: ReturnType<typeof createSafeEventBus>): ContextActivityPayload[] {
	const seen: ContextActivityPayload[] = [];
	bus.on(BusChannels.ContextActivity, (payload) => {
		if ((payload as ContextActivityPayload).kind === "compaction") seen.push(payload as ContextActivityPayload);
	});
	return seen;
}

function summaryEntry(entries: SessionEntry[]): void {
	entries.splice(0, entries.length, {
		kind: "compactionSummary",
		turnId: "summary-1",
		parentTurnId: null,
		timestamp: new Date().toISOString(),
		summary: "compacted older context",
		tokensBefore: 1500,
		firstKeptTurnId: "summary-1",
		trigger: "force",
	} as SessionEntry);
}

type ProductionFailure = "provider-stream" | "session-read" | "summary-append";
type CompactionMode = "forced" | "automatic";

const PRODUCTION_FAILURE_CAUSES: Record<ProductionFailure, string> = {
	"provider-stream": "provider stream exploded",
	"session-read": "session not found",
	"summary-append": "summary append exploded",
};

function persistentSession(bus: ReturnType<typeof createSafeEventBus>): SessionContract {
	const context = {
		bus,
		getContract: () => undefined,
	} as unknown as DomainContext;
	return createSessionBundle(context).contract;
}

function seedPersistentCompactionHistory(session: SessionContract): void {
	const firstUser = session.append({ parentId: null, kind: "user", payload: { text: "old request to summarize" } });
	const firstAssistant = session.append({
		parentId: firstUser.id,
		kind: "assistant",
		payload: { text: "old response to summarize" },
	});
	const recentUser = session.append({
		parentId: firstAssistant.id,
		kind: "user",
		payload: { text: "recent request to retain" },
	});
	session.append({ parentId: recentUser.id, kind: "assistant", payload: { text: "recent response to retain" } });
}

function persistedEntries(session: SessionContract): SessionEntry[] {
	const meta = session.current();
	if (!meta) return [];
	return collectSessionEntries(openSession(meta.id).turns(), sessionPaths(meta).current);
}

function sessionWithProductionFailure(base: SessionContract, failure: ProductionFailure): SessionContract {
	if (failure === "session-read") {
		const current = base.current();
		if (!current) throw new Error("test setup requires a current session");
		return {
			...base,
			current: () => ({ ...current, id: "missing-compaction-session" }),
		};
	}
	if (failure === "summary-append") {
		return {
			...base,
			appendEntry(entry) {
				if (entry.kind === "compactionSummary") throw new Error(PRODUCTION_FAILURE_CAUSES[failure]);
				return base.appendEntry(entry);
			},
		};
	}
	return base;
}

async function runProductionFailureScenario(
	failure: ProductionFailure,
	mode: CompactionMode,
): Promise<{ activities: ContextActivityPayload[]; visible: string }> {
	const isolated = isolateClioEnv(`clio-compaction-${failure}-${mode}-`);
	const bus = createSafeEventBus();
	const activities = compactionActivities(bus);
	const events: ChatLoopEvent[] = [];
	const faux = registerFauxProvider({
		provider: `production-compaction-${failure}-${mode}`,
		models: [{ id: "model" }],
		tokensPerSecond: 0,
	});
	const baseSession = persistentSession(bus);

	try {
		baseSession.create({ cwd: isolated.dir, model: "model", target: "test-target" });
		seedPersistentCompactionHistory(baseSession);
		const session = sessionWithProductionFailure(baseSession, failure);
		faux.setResponses([
			failure === "provider-stream"
				? fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: PRODUCTION_FAILURE_CAUSES[failure],
					})
				: fauxAssistantMessage("## Goal\nPersist the production summary."),
		]);
		const model = faux.getModel("model") as EngineModel;
		const productionProviders = providers(model);
		const currentSettings = settings({ threshold: 0.2 });
		const loop = createChatLoop({
			getSettings: () => currentSettings,
			providers: productionProviders,
			knownTargets: () => new Set(["test-target"]),
			session,
			readSessionEntries: () => persistedEntries(session),
			autoCompact: createProductionAutoCompact(session, () => currentSettings, productionProviders),
			bus,
			createAgent: createFakeAgentFactory(
				async () => {},
				mode === "automatic"
					? () => [
							{
								role: "user",
								content: [{ type: "text", text: "x".repeat(1200) }],
								timestamp: Date.now(),
							} as AgentMessage,
						]
					: undefined,
			),
		} as never);
		loop.onEvent((event) => events.push(event));

		if (mode === "forced") await loop.compact();
		else await loop.submit("continue after automatic compaction");

		return { activities, visible: JSON.stringify(events) };
	} finally {
		await baseSession.close();
		faux.unregister();
		isolated.restore();
	}
}

describe("contracts/compaction context-island activity (S3 Part A)", () => {
	it("a forced /compact emits started -> completed around the LLM stage", async () => {
		const bus = createSafeEventBus();
		const activities = compactionActivities(bus);
		const entries: SessionEntry[] = [];
		const session = createSession(entries);
		session.create({ cwd: process.cwd(), model: "model", target: "test-target" });
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session,
			readSessionEntries: () => entries,
			bus,
			autoCompact: async (): Promise<CompactResult> => {
				summaryEntry(entries);
				return {
					summary: "compacted older context",
					firstKeptEntryIndex: 0,
					firstKeptTurnId: "summary-1",
					tokensBefore: 1500,
					messagesSummarized: 3,
					isSplitTurn: false,
				};
			},
			createAgent: createFakeAgentFactory(async () => {}),
		} as never);

		await loop.compact("summarize the older turns");

		strictEqual(activities.length, 2, "one started + one completed");
		strictEqual(activities[0]?.status, "started");
		strictEqual(activities[0]?.kind, "compaction");
		strictEqual(activities[0]?.phase, "done");
		ok(activities[0]?.message.includes("summary"), "started message names the summary stage");
		strictEqual(activities[1]?.status, "completed");
		ok(activities[1]?.message.includes("tokens"), "completed message reports a token delta");
	});

	it("a throwing compaction model emits a failed activity", async () => {
		const bus = createSafeEventBus();
		const activities = compactionActivities(bus);
		const entries: SessionEntry[] = [];
		const session = createSession(entries);
		session.create({ cwd: process.cwd(), model: "model", target: "test-target" });
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session,
			readSessionEntries: () => entries,
			bus,
			autoCompact: async (): Promise<CompactResult> => {
				throw new Error("summary model exploded");
			},
			createAgent: createFakeAgentFactory(async () => {}),
		} as never);

		await loop.compact();

		strictEqual(activities[0]?.status, "started");
		const failed = activities.find((a) => a.status === "failed");
		ok(failed, "a failed activity is emitted when the summary throws");
		strictEqual(failed?.kind, "compaction");
		strictEqual(
			activities.some((a) => a.status === "completed"),
			false,
			"a throwing compaction never reports completed",
		);
	});

	it("a no-op compaction emits completed with a nothing-to-compact message", async () => {
		const bus = createSafeEventBus();
		const activities = compactionActivities(bus);
		const entries: SessionEntry[] = [];
		const session = createSession(entries);
		session.create({ cwd: process.cwd(), model: "model", target: "test-target" });
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session,
			readSessionEntries: () => entries,
			bus,
			autoCompact: async (): Promise<CompactResult | null> => null,
			createAgent: createFakeAgentFactory(async () => {}),
		} as never);

		await loop.compact();

		strictEqual(activities[0]?.status, "started");
		const completed = activities.find((a) => a.status === "completed");
		ok(completed, "a no-op compaction still reports completed");
		ok(completed?.message.includes("nothing to compact"));
	});

	it("a mask-stage auto compaction emits its own started -> completed pair", async () => {
		const bus = createSafeEventBus();
		const activities = compactionActivities(bus);
		// A stale, maskable tool observation followed by a recent protected turn.
		// Sized so the seeded transcript crosses the 0.5 threshold on a 1000-token
		// window (~1299 tokens) and the mask stage then shrinks it below threshold.
		const huge = `${"line\n".repeat(1000)}stale observation body`;
		const entries: SessionEntry[] = [
			{
				kind: "message",
				turnId: "01",
				parentTurnId: null,
				timestamp: "2026-06-08T00:00:01.000Z",
				role: "user",
				payload: { text: "read the large file" },
			} as MessageEntry,
			{
				kind: "message",
				turnId: "02",
				parentTurnId: "01",
				timestamp: "2026-06-08T00:00:02.000Z",
				role: "tool_result",
				payload: {
					toolCallId: "call-1",
					toolName: "read",
					result: { content: [{ type: "text", text: huge }] },
					isError: false,
					resultSummary: { bytes: huge.length, truncated: false },
				},
			} as MessageEntry,
			{
				kind: "message",
				turnId: "03",
				parentTurnId: "02",
				timestamp: "2026-06-08T00:00:03.000Z",
				role: "user",
				payload: { text: "recent protected turn" },
			} as MessageEntry,
		];
		const session = createSession(entries);
		session.create({ cwd: process.cwd(), model: "model", target: "test-target" });
		// Seed the agent transcript large so the pre-submit estimate crosses the
		// 0.5 threshold on a 1000-token window; the mask stage then shrinks it.
		const seedMessages = (): AgentMessage[] => [
			{ role: "user", content: [{ type: "text", text: "read the large file" }], timestamp: Date.now() } as never,
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: huge }],
				timestamp: Date.now(),
			} as never,
		];
		const loop = createChatLoop({
			getSettings: () => settings({ threshold: 0.5, excludeLastTurns: 1 }),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session,
			readSessionEntries: () => entries,
			bus,
			// autoCompact must be present for the pre-submit trigger to engage at
			// all; it returns null so if the mask stage does not relieve pressure
			// the LLM stage is a no-op. The mask pair is emitted regardless.
			autoCompact: async (): Promise<CompactResult | null> => null,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				agent.state.messages.push(...inputMessages(input));
				const message = {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					stopReason: "stop",
					timestamp: Date.now(),
				} as unknown as AgentMessage;
				await agent.emit({ type: "message_end", message });
				await agent.emit({ type: "agent_end", messages: [message] });
			}, seedMessages),
		} as never);

		await loop.submit("recent protected turn");

		const started = activities.find((a) => a.status === "started" && a.message.includes("mask stage"));
		ok(started, "the mask stage emits a started activity");
		const completed = activities.find((a) => a.status === "completed" && a.message.includes("masked"));
		ok(completed, "the mask stage emits a completed activity naming the masked observations");
	});
});

describe("contracts/production compaction failure wiring", () => {
	for (const mode of ["forced", "automatic"] as const) {
		for (const failure of ["provider-stream", "session-read", "summary-append"] as const) {
			it(`${mode} ${failure} failures stay distinct from a legitimate no-op`, async () => {
				const { activities, visible } = await runProductionFailureScenario(failure, mode);
				const cause = PRODUCTION_FAILURE_CAUSES[failure];
				const failed = activities.find((activity) => activity.status === "failed");

				ok(failed, `expected a failed activity for ${mode} ${failure}`);
				ok(failed?.message.includes(cause), `failed activity should expose ${JSON.stringify(cause)}`);
				strictEqual(
					activities.some((activity) => activity.status === "completed"),
					false,
					"a production failure must never emit a completed compaction activity",
				);
				ok(visible.includes(cause), `operator-visible notice should expose ${JSON.stringify(cause)}`);
				ok(
					visible.includes(mode === "forced" ? "[/compact]" : "auto-compaction failed"),
					"operator-visible wording should identify the failed compaction path",
				);
				ok(!visible.includes("nothing to compact"), "a production failure must not render the no-op notice");
			});
		}
	}

	it("preserves an empty production session as a legitimate no-op", async () => {
		const isolated = isolateClioEnv("clio-compaction-no-op-");
		const bus = createSafeEventBus();
		const activities = compactionActivities(bus);
		const events: ChatLoopEvent[] = [];
		const faux = registerFauxProvider({
			provider: "production-compaction-no-op",
			models: [{ id: "model" }],
			tokensPerSecond: 0,
		});
		const session = persistentSession(bus);

		try {
			session.create({ cwd: isolated.dir, model: "model", target: "test-target" });
			const model = faux.getModel("model") as EngineModel;
			const productionProviders = providers(model);
			const currentSettings = settings();
			const loop = createChatLoop({
				getSettings: () => currentSettings,
				providers: productionProviders,
				knownTargets: () => new Set(["test-target"]),
				session,
				readSessionEntries: () => persistedEntries(session),
				autoCompact: createProductionAutoCompact(session, () => currentSettings, productionProviders),
				bus,
				createAgent: createFakeAgentFactory(async () => {}),
			} as never);
			loop.onEvent((event) => events.push(event));

			await loop.compact();

			strictEqual(
				activities.some((activity) => activity.status === "failed"),
				false,
			);
			ok(
				activities.some((activity) => activity.status === "completed" && activity.message.includes("nothing to compact")),
				"the production wrapper keeps an empty session as a completed no-op",
			);
			ok(JSON.stringify(events).includes("nothing to compact"));
		} finally {
			await session.close();
			faux.unregister();
			isolated.restore();
		}
	});

	it("compacts and replays the selected branch immediately after a tree switch", async () => {
		const isolated = isolateClioEnv("clio-compaction-active-branch-");
		const bus = createSafeEventBus();
		const faux = registerFauxProvider({
			provider: "production-compaction-active-branch",
			models: [{ id: "model" }],
			tokensPerSecond: 0,
		});
		const session = persistentSession(bus);

		try {
			session.create({ cwd: isolated.dir, model: "model", target: "test-target" });
			const rootUser = session.append({ parentId: null, kind: "user", payload: { text: "shared root request" } });
			const rootAssistant = session.append({
				parentId: rootUser.id,
				kind: "assistant",
				payload: { text: "shared root response" },
			});
			const selectedUser = session.append({
				parentId: rootAssistant.id,
				kind: "user",
				payload: { text: "selected branch request" },
			});
			const selectedAssistant = session.append({
				parentId: selectedUser.id,
				kind: "assistant",
				payload: { text: "selected branch response" },
			});
			session.switchTurn(rootAssistant.id);
			const abandonedUser = session.append({
				parentId: rootAssistant.id,
				kind: "user",
				payload: { text: "abandoned branch request" },
			});
			session.append({
				parentId: abandonedUser.id,
				kind: "assistant",
				payload: { text: "abandoned branch response" },
			});
			session.switchTurn(selectedAssistant.id);

			faux.setResponses([fauxAssistantMessage("## Goal\nPreserve the selected branch only.")]);
			const model = faux.getModel("model") as EngineModel;
			const productionProviders = providers(model);
			const currentSettings = settings();
			let liveAgent: FakeAgent | undefined;
			const loop = createChatLoop({
				getSettings: () => currentSettings,
				providers: productionProviders,
				knownTargets: () => new Set(["test-target"]),
				session,
				readSessionEntries: () => persistedEntries(session),
				autoCompact: createProductionAutoCompact(session, () => currentSettings, productionProviders),
				bus,
				createAgent: createFakeAgentFactory(
					async () => {},
					undefined,
					(agent) => {
						liveAgent = agent;
					},
				),
			} as never);
			loop.resetForSession(
				selectedAssistant.id,
				buildReplayAgentMessagesFromTurns(persistedEntries(session), { uptoTurnId: selectedAssistant.id }),
			);

			await loop.compact();

			const summary = persistedEntries(session).find(
				(entry): entry is Extract<SessionEntry, { kind: "compactionSummary" }> => entry.kind === "compactionSummary",
			);
			strictEqual(summary?.firstKeptTurnId, selectedUser.id);
			const replayText = JSON.stringify(liveAgent?.state.messages ?? []);
			ok(replayText.includes("Preserve the selected branch only"), replayText);
			ok(replayText.includes("selected branch request"), replayText);
			ok(!replayText.includes("abandoned branch"), replayText);
		} finally {
			await session.close();
			faux.unregister();
			isolated.restore();
		}
	});
});
