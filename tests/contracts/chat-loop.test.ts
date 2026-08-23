import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import { BusChannels, type LoopBlockedPayload } from "../../src/core/bus-events.js";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import type { CompactResult } from "../../src/domains/session/compaction/compact.js";
import type { SessionContract, SessionEntryInput, SessionMeta, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { lockedSynthesisFallbackText } from "../../src/engine/loop-guard.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { type ChatLoopEvent, createChatLoop } from "../../src/interactive/chat-loop.js";
import { backendCacheVerdict } from "../../src/interactive/chat-loop-messages.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { createStatusController } from "../../src/interactive/status/controller.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";

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

function providers(tier?: "local-native"): ProvidersContract {
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
		...(tier ? { tier } : {}),
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 1000, maxTokens: 256 },
		synthesizeModel: () =>
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
			}) as never,
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
		setName: () => {},
		deleteSession: () => {},
		history: () => (current ? [current] : []),
		close: async () => {
			current = null;
		},
	};
}

type FakeAgentOptions = {
	initialState?: {
		systemPrompt?: string;
		model?: unknown;
		thinkingLevel?: string;
		tools?: unknown[];
		messages?: AgentMessage[];
	};
	prepareNextTurn?: (signal?: AbortSignal) => Promise<unknown> | unknown;
};

function createFakeAgentFactory(promptImpl: (agent: FakeAgent, input: AgentMessage | AgentMessage[]) => Promise<void>) {
	return ((options: FakeAgentOptions = {}) => {
		const listeners: Array<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void> = [];
		const state = {
			systemPrompt: options.initialState?.systemPrompt ?? "",
			model: options.initialState?.model,
			thinkingLevel: options.initialState?.thinkingLevel ?? "off",
			tools: options.initialState?.tools ?? [],
			messages: options.initialState?.messages ?? [],
			errorMessage: undefined as string | undefined,
		};
		const controller = new AbortController();
		const agent: FakeAgent = {
			state,
			sessionId: undefined,
			maxRetryDelayMs: undefined,
			prepareNextTurn: options.prepareNextTurn,
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
		return { agent, state: () => state };
	}) as never;
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

function inputMessages(input: AgentMessage | AgentMessage[]): AgentMessage[] {
	return Array.isArray(input) ? input : [input];
}

function isAssistantMessageEntry(entry: SessionEntry): entry is Extract<SessionEntry, { kind: "message" }> {
	return entry.kind === "message" && entry.role === "assistant";
}

describe("contracts/chat-loop compaction and terminal notices", () => {
	it("probes the selected live model at boot before the first submit", async () => {
		const configured = settings();
		const targetProviders = providers("local-native");
		const status = targetProviders.list()[0];
		ok(status);
		if (status.target.capabilities) delete status.target.capabilities.contextWindow;
		let probeCalls = 0;
		let probeLanded: (() => void) | null = null;
		const landed = new Promise<void>((resolve) => {
			probeLanded = resolve;
		});
		targetProviders.probeTarget = async () => {
			probeCalls += 1;
			status.capabilities = { ...status.capabilities, contextWindow: 196_608 };
			status.probeCapabilities = { contextWindow: 196_608 };
			status.probeModelId = "model";
			status.discoveredModelStates = {
				model: { state: "loaded", contextSlots: { totalContextSize: 786_432, slots: 4 } },
			};
			probeLanded?.();
			return status;
		};

		const loop = createChatLoop({
			getSettings: () => configured,
			providers: targetProviders,
			knownTargets: () => new Set(["test-target"]),
			createAgent: createFakeAgentFactory(async () => {
				throw new Error("no turn should run in a boot probe contract");
			}),
		} as never);
		await landed;

		strictEqual(probeCalls, 1, "boot starts one live target probe");
		const ledger = loop.contextLedger();
		strictEqual(ledger.contextWindow, 196_608);
		strictEqual(ledger.contextWindowSource, "probe");
		deepStrictEqual(ledger.contextWindowSlots, { totalContextSize: 786_432, slots: 4 });
		loop.dispose();
	});

	it("emits an out-of-run notice as a typed notice event without fabricating agent_end", async () => {
		const events: ChatLoopEvent[] = [];
		const unconfigured = settings();
		unconfigured.orchestrator.target = "";
		unconfigured.orchestrator.model = "";
		const loop = createChatLoop({
			getSettings: () => unconfigured,
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(),
			readSessionEntries: () => [],
			createAgent: createFakeAgentFactory(async () => {
				throw new Error("agent factory should not run for an unconfigured notice");
			}),
		} as never);
		loop.onEvent((event: ChatLoopEvent) => events.push(event));

		await loop.submit("hello");

		const notices = events.filter(
			(event): event is Extract<ChatLoopEvent, { type: "notice" }> =>
				event.type === "notice" && event.surface === "transcript" && event.text.includes("orchestrator not configured"),
		);
		strictEqual(notices.length, 1, "the notice reaches consumers as a typed notice event");
		strictEqual(
			events.filter((event) => event.type === "message_end").length,
			0,
			"a notice is never a fake assistant message_end",
		);
		strictEqual(events.filter((event) => event.type === "agent_end").length, 0, "notices never synthesize agent_end");
	});

	// Both halves of a null runtime render the same operator notice, but the
	// machine-readable reason has to tell them apart: a protocol surface reports
	// it as the admission code, and sending a client with a configured target to
	// "configure an orchestrator" points at the wrong half of the settings.
	it("distinguishes a missing orchestrator model from a missing orchestrator target", async () => {
		const admissionReasonFor = async (target: string, model: string): Promise<string | undefined> => {
			const events: ChatLoopEvent[] = [];
			const unconfigured = settings();
			unconfigured.orchestrator.target = target;
			unconfigured.orchestrator.model = model;
			const loop = createChatLoop({
				getSettings: () => unconfigured,
				providers: providers(),
				knownTargets: () => new Set(["test-target"]),
				session: createSession(),
				readSessionEntries: () => [],
				createAgent: createFakeAgentFactory(async () => {
					throw new Error("agent factory should not run for an unconfigured notice");
				}),
			} as never);
			loop.onEvent((event: ChatLoopEvent) => events.push(event));

			await loop.submit("hello");

			const notices = events.filter(
				(event): event is Extract<ChatLoopEvent, { type: "notice" }> =>
					event.type === "notice" && event.surface === "transcript" && event.text.includes("orchestrator not configured"),
			);
			strictEqual(notices.length, 1, `expected one admission notice for target=${target} model=${model}`);
			return notices[0]?.admission?.reason;
		};

		strictEqual(await admissionReasonFor("test-target", ""), "model-not-configured");
		strictEqual(await admissionReasonFor("test-target", "   "), "model-not-configured", "a blank model is no model");
		strictEqual(await admissionReasonFor("", ""), "orchestrator-not-configured");
		strictEqual(await admissionReasonFor("", "model"), "orchestrator-not-configured", "no target is the wider failure");
	});

	it("runs post-tool compaction guard before an oversized continuation", async () => {
		const entries: SessionEntry[] = [];
		let compactTrigger: string | undefined;
		let prepareUpdate: unknown;
		const loop = createChatLoop({
			getSettings: () => settings({ threshold: 0.5 }),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			autoCompact: async (_instructions: string | undefined, trigger: string | undefined): Promise<CompactResult> => {
				compactTrigger = trigger;
				entries.splice(0, entries.length, {
					kind: "compactionSummary",
					turnId: "summary-1",
					parentTurnId: null,
					timestamp: new Date().toISOString(),
					summary: "compacted tool observations",
					tokensBefore: 1500,
					firstKeptTurnId: "summary-1",
					trigger: "auto",
				});
				return {
					summary: "compacted tool observations",
					firstKeptEntryIndex: 0,
					firstKeptTurnId: "summary-1",
					tokensBefore: 1500,
					messagesSummarized: 3,
					isSplitTurn: false,
				};
			},
			createAgent: createFakeAgentFactory(async (agent, input) => {
				agent.state.messages.push(...inputMessages(input));
				agent.state.messages.push({
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "huge.txt" } }],
					stopReason: "toolUse",
					timestamp: Date.now(),
				} as unknown as AgentMessage);
				agent.state.messages.push({
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "x".repeat(7000) }],
					timestamp: Date.now(),
				} as unknown as AgentMessage);
				prepareUpdate = await agent.prepareNextTurn?.(new AbortController().signal);
				const context = (prepareUpdate as { context?: { messages?: AgentMessage[] } } | undefined)?.context;
				if (context?.messages) agent.state.messages = context.messages;
			}),
		} as never);

		await loop.submit("read huge file");

		strictEqual(compactTrigger, "auto");
		const context = (prepareUpdate as { context?: { messages?: AgentMessage[] } } | undefined)?.context;
		ok(context?.messages && context.messages.length > 0, "expected compacted continuation context");
		ok(!JSON.stringify(context.messages).includes("xxxx"), "oversized tool observation should not survive guard");
	});

	it("renders and persists provider length stops with explicit exhaustion metadata", async () => {
		const entries: SessionEntry[] = [];
		const panel = createChatPanel();
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			createAgent: createFakeAgentFactory(async (agent) => {
				const message = {
					role: "assistant",
					content: [],
					stopReason: "length",
					usage: { input: 1100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1101 },
					timestamp: Date.now(),
				} as unknown as AgentMessage;
				agent.state.messages.push(message);
				await agent.emit({ type: "message_start", message });
				await agent.emit({ type: "message_end", message });
				await agent.emit({ type: "agent_end", messages: [message] });
			}),
		} as never);
		loop.onEvent((event: ChatLoopEvent) => panel.applyEvent(event));

		await loop.submit("trigger length stop");

		const assistant = entries.find((entry) => entry.kind === "message" && entry.role === "assistant");
		ok(assistant && assistant.kind === "message");
		const payload = assistant.payload as {
			contextExhaustion?: { kind?: string; contextWindow?: number };
			timing?: { ttftMs: number | null; apiMs: number };
			promptCache?: { input: number; cacheRead: number; backendVerdict: string };
		};
		strictEqual(payload.contextExhaustion?.kind, "provider_length_stop");
		strictEqual(payload.contextExhaustion?.contextWindow, 1000);
		// Per-call telemetry (T3.2) rides every persisted assistant entry.
		ok(payload.timing && payload.timing.apiMs >= 0, "expected persisted apiMs");
		strictEqual(payload.timing?.ttftMs, null);
		strictEqual(payload.promptCache?.input, 1100);
		strictEqual(payload.promptCache?.backendVerdict, "small");
		ok(panel.render(120).join("\n").includes("generation/output limit"));
	});
});

describe("contracts/chat-loop synthesis lock release on continuation", () => {
	it("clears the lock for the middleware continuation and chains its tool calls to the new user turn", async () => {
		const entries: SessionEntry[] = [];
		const bus = createSafeEventBus();
		type OnPayload = (payload: Record<string, unknown>, model: unknown) => Promise<Record<string, unknown> | undefined>;
		let capturedOnPayload: OnPayload | null = null;
		let turnIndex = 0;
		const baseFactory = createFakeAgentFactory(async (agent) => {
			turnIndex += 1;
			const callId = `call-t${turnIndex}`;
			await agent.emit({
				type: "tool_execution_start",
				toolCallId: callId,
				toolName: "read",
				args: { path: `t${turnIndex}.md` },
			} as AgentEvent);
			await agent.emit({
				type: "tool_execution_end",
				toolCallId: callId,
				toolName: "read",
				result: "contents",
				isError: false,
			} as AgentEvent);
			const message = {
				role: "assistant",
				content: [{ type: "text", text: `turn ${turnIndex} answer` }],
				stopReason: "stop",
				timestamp: Date.now(),
			} as unknown as AgentMessage;
			agent.state.messages.push(message);
			await agent.emit({ type: "message_end", message } as AgentEvent);
			await agent.emit({ type: "agent_end", messages: [message] } as AgentEvent);
		});
		const factory = ((options: FakeAgentOptions & { onPayload?: OnPayload }) => {
			capturedOnPayload = options.onPayload ?? null;
			return (baseFactory as unknown as (o: FakeAgentOptions) => unknown)(options);
		}) as never;
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			bus,
			createAgent: factory,
		} as never);

		await loop.submit("explore the repo");
		ok(capturedOnPayload !== null, "the chat loop hands createAgent its payload hook");
		const onPayload = capturedOnPayload as OnPayload;
		const model = {
			id: "model",
			api: "openai-completions",
			provider: "fake-runtime",
			reasoning: false,
		} as never;

		// The loop guard locks the turn to synthesis: the next provider payload
		// must be text-only.
		bus.emit(BusChannels.LoopBlocked, {
			tool: "read",
			repeatCount: 5,
			blocksThisTurn: 2,
			budget: 2,
			interrupted: false,
			disposition: "lockout",
			at: Date.now(),
		} as LoopBlockedPayload);
		const locked = await onPayload({ tools: [{ name: "read" }], messages: [] }, model);
		strictEqual(locked?.tool_choice, "none", "a locked turn forces tool_choice none");

		// The middleware continuation (open-tasks/detached-dispatch nudge shape)
		// submits a fresh synthetic user turn. The M1 Phase C finding: this new
		// turn must NOT inherit the disabled tools.
		await loop.submit("", { requestContinuation: true });
		const unlocked = await onPayload({ tools: [{ name: "read" }], messages: [] }, model);
		ok(unlocked?.tool_choice !== "none", "the continuation turn regains tool use");

		// And the continuation's tool call chains to the NEW user turn id, not
		// the locked turn's lineage.
		const userTurns = entries.filter(
			(entry): entry is Extract<SessionEntry, { kind: "message" }> => entry.kind === "message" && entry.role === "user",
		);
		strictEqual(userTurns.length, 2, "one real prompt plus one synthetic continuation turn");
		const syntheticTurn = userTurns[1];
		ok(syntheticTurn);
		strictEqual((syntheticTurn.payload as { synthetic?: boolean }).synthetic, true);
		const continuationToolCall = entries.find(
			(entry) =>
				entry.kind === "message" &&
				entry.role === "tool_call" &&
				(entry.payload as { toolCallId?: string }).toolCallId === "call-t2",
		);
		ok(continuationToolCall && continuationToolCall.kind === "message");
		strictEqual(
			continuationToolCall.parentTurnId,
			syntheticTurn.turnId,
			"the continuation's tool call parents on the new user turn",
		);
	});
});

describe("contracts/chat-loop loop-guard interrupt", () => {
	it("stops with a durable closing turn and suppresses the empty aborted turn", async () => {
		const entries: SessionEntry[] = [];
		const bus = createSafeEventBus();
		const aborts: Array<{ source?: string; reason?: string }> = [];
		bus.on(BusChannels.RunAborted, (payload) => {
			aborts.push(payload as { source?: string; reason?: string });
		});
		const REASON = "[Clio Coder] loop guard stopped this turn: context was called with identical arguments 3 times.";
		const holder: { loop?: ReturnType<typeof createChatLoop> } = {};
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			bus,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				agent.state.messages.push(...inputMessages(input));
				// Simulate the loop guard interrupting mid-turn while streaming.
				holder.loop?.cancel({ reason: REASON, source: "loop_guard", auditReason: "loop: context repeated 3x" });
				// The abort surfaces an empty aborted assistant message; the loop must
				// suppress it because the closing turn was already written.
				const aborted = {
					role: "assistant",
					content: [],
					stopReason: "aborted",
					errorMessage: "Request was aborted.",
					timestamp: Date.now(),
				} as unknown as AgentMessage;
				agent.state.messages.push(aborted);
				await agent.emit({ type: "message_end", message: aborted });
				await agent.emit({ type: "agent_end", messages: [aborted] });
			}),
		} as never);
		holder.loop = loop;

		await loop.submit("use context and learn more");

		const assistantEntries = entries.filter(isAssistantMessageEntry);
		strictEqual(assistantEntries.length, 1, "exactly one assistant turn: the durable closing message");
		const payload = assistantEntries[0]?.payload as { text?: string; stopReason?: string; errorMessage?: string };
		strictEqual(payload.text, REASON, "the closing turn carries the loop-stop reason");
		// What distinguishes the durable closing turn from the empty aborted
		// message is its text and the absence of an errorMessage, not its
		// stopReason. Both are aborted, and the closing turn has to be: it carries
		// no usage, and the engine's context estimator dereferences usage on any
		// assistant turn not marked aborted or error.
		strictEqual(payload.errorMessage, undefined, "the closing turn is not the empty aborted message");
		strictEqual(payload.stopReason, "aborted", "a turn the loop guard stopped is recorded as stopped");
		const looped = aborts.find((evt) => evt.source === "loop_guard");
		ok(looped, "a loop_guard RunAborted is audited, distinct from a user stream_cancel");
		strictEqual(looped?.reason, "loop: context repeated 3x");
	});

	it("persists the closing turn after straggler tool results and keeps aborted noise out of the live transcript", async () => {
		// Regression for the v0.2.8 demo failure: the hard-ceiling cancel used to
		// persist the closing turn immediately, so the still-in-flight blocked
		// tool results landed after it and the ledger replayed assistant text
		// between a tool-call message and its results. The aborted follow-up
		// calls also rendered as "[aborted] Request was aborted." noise.
		const entries: SessionEntry[] = [];
		const bus = createSafeEventBus();
		const REASON = "[Clio Coder] loop guard stopped this turn: 40 tool calls reached the per-turn ceiling (40).";
		const holder: { loop?: ReturnType<typeof createChatLoop> } = {};
		const seen: ChatLoopEvent[] = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			bus,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				agent.state.messages.push(...inputMessages(input));
				await agent.emit({
					type: "tool_execution_start",
					toolCallId: "c1",
					toolName: "ls",
					args: { path: "src/domains/prompts" },
				} as never);
				// The ceiling fires while the blocked call is still in flight.
				holder.loop?.cancel({ reason: REASON, source: "loop_guard", auditReason: "tool-call ceiling: 40 calls" });
				// The straggler result lands after the cancel...
				await agent.emit({
					type: "tool_execution_end",
					toolCallId: "c1",
					toolName: "ls",
					result: { content: [{ type: "text", text: "tool-call budget exhausted" }] },
					isError: true,
				} as never);
				// ...followed by the empty aborted assistant message the abort leaves.
				const aborted = {
					role: "assistant",
					content: [],
					stopReason: "aborted",
					errorMessage: "Request was aborted.",
					timestamp: Date.now(),
				} as unknown as AgentMessage;
				agent.state.messages.push(aborted);
				await agent.emit({ type: "message_end", message: aborted });
				await agent.emit({ type: "agent_end", messages: [aborted] });
			}),
		} as never);
		holder.loop = loop;
		loop.onEvent((event: ChatLoopEvent) => seen.push(event));

		await loop.submit("audit the docs");

		const roles = entries.filter((entry) => entry.kind === "message").map((entry) => entry.role);
		const resultIndex = roles.lastIndexOf("tool_result");
		const closingIndex = roles.lastIndexOf("assistant");
		ok(resultIndex !== -1 && closingIndex !== -1, "both the tool result and the closing turn are persisted");
		ok(resultIndex < closingIndex, "the closing turn lands after the straggler tool result");
		const assistantEntries = entries.filter(isAssistantMessageEntry);
		strictEqual(assistantEntries.length, 1, "exactly one assistant turn: the durable closing message");
		strictEqual((assistantEntries[0]?.payload as { text?: string }).text, REASON);
		const abortedEnds = seen.filter(
			(event) =>
				event.type === "message_end" && (event as { message?: { stopReason?: string } }).message?.stopReason === "aborted",
		);
		strictEqual(abortedEnds.length, 0, "the empty aborted message never reaches the live transcript");
		const closingNotices = seen.filter(
			(event) => event.type === "notice" && event.key === "turn.interrupted" && event.text.includes("loop guard stopped"),
		);
		strictEqual(closingNotices.length, 1, "the closing notice is shown live exactly once, as a typed notice");
	});

	it("closes a bare operator cancel with the cancellation notice, not aborted noise", async () => {
		// Regression for the v0.2.8 demo session: a bare Esc cancel rendered
		// "[Clio Coder] active response cancelled." immediately followed by
		// "[aborted] Request was aborted" — the empty aborted turn the abort
		// leaves behind. The cancel notice is the closing turn; the aborted
		// noise must be suppressed in both the ledger and the live transcript.
		const entries: SessionEntry[] = [];
		const bus = createSafeEventBus();
		const aborts: Array<{ source?: string }> = [];
		bus.on(BusChannels.RunAborted, (payload) => {
			aborts.push(payload as { source?: string });
		});
		const holder: { loop?: ReturnType<typeof createChatLoop> } = {};
		const seen: ChatLoopEvent[] = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			bus,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				agent.state.messages.push(...inputMessages(input));
				holder.loop?.cancel();
				const aborted = {
					role: "assistant",
					content: [],
					stopReason: "aborted",
					errorMessage: "Request was aborted.",
					timestamp: Date.now(),
				} as unknown as AgentMessage;
				agent.state.messages.push(aborted);
				await agent.emit({ type: "message_end", message: aborted });
				await agent.emit({ type: "agent_end", messages: [aborted] });
			}),
		} as never);
		holder.loop = loop;
		loop.onEvent((event: ChatLoopEvent) => seen.push(event));

		await loop.submit("stop");

		const assistantEntries = entries.filter(isAssistantMessageEntry);
		strictEqual(assistantEntries.length, 1, "exactly one assistant turn: the durable cancellation notice");
		const payload = assistantEntries[0]?.payload as { text?: string; stopReason?: string; errorMessage?: string };
		strictEqual(payload.text, "[Clio Coder] active response cancelled.");
		// The empty aborted turn is the one with an errorMessage and no text. Both
		// it and the durable notice are aborted, and the notice has to be, or a
		// resume of this session throws reading usage that a cancelled turn never
		// had.
		strictEqual(payload.errorMessage, undefined, "the empty aborted turn stays out of the ledger");
		strictEqual(payload.stopReason, "aborted", "a turn the operator cancelled is recorded as cancelled");
		const abortedEnds = seen.filter(
			(event) =>
				event.type === "message_end" && (event as { message?: { stopReason?: string } }).message?.stopReason === "aborted",
		);
		strictEqual(abortedEnds.length, 0, "the aborted message never reaches the live transcript");
		strictEqual(aborts.find((evt) => evt.source === "stream_cancel")?.source, "stream_cancel");
	});

	it("preserves the run's real usage when the abort path replaces agent_end messages", async () => {
		// The engine's failure path emits agent_end with one synthetic zero-usage
		// message; the loop must rebuild the run window from agent state so the
		// footer summary, session totals, and cache records keep the real spend.
		const entries: SessionEntry[] = [];
		const bus = createSafeEventBus();
		const holder: { loop?: ReturnType<typeof createChatLoop> } = {};
		const seen: ChatLoopEvent[] = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			bus,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				agent.state.messages.push(...inputMessages(input));
				await agent.emit({ type: "agent_start" } as never);
				const worked = {
					role: "assistant",
					content: [{ type: "text", text: "gathering" }],
					stopReason: "toolUse",
					usage: { input: 52_000, output: 900, cacheRead: 0, cacheWrite: 0 },
					timestamp: Date.now(),
				} as unknown as AgentMessage;
				agent.state.messages.push(worked);
				await agent.emit({ type: "message_end", message: worked });
				holder.loop?.cancel({
					reason: "[Clio Coder] loop guard stopped this turn: context repeated.",
					source: "loop_guard",
					auditReason: "loop: context repeated 4x",
				});
				const aborted = {
					role: "assistant",
					content: [],
					stopReason: "aborted",
					errorMessage: "Request was aborted",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					timestamp: Date.now(),
				} as unknown as AgentMessage;
				agent.state.messages.push(aborted);
				await agent.emit({ type: "message_end", message: aborted });
				// The failure path replaces the run window with the synthetic message.
				await agent.emit({ type: "agent_end", messages: [aborted] });
			}),
		} as never);
		holder.loop = loop;
		loop.onEvent((event: ChatLoopEvent) => seen.push(event));

		await loop.submit("audit the docs");

		const end = seen.find((event) => event.type === "agent_end") as
			| { messages?: Array<{ usage?: { input?: number; output?: number } }> }
			| undefined;
		ok(end, "agent_end reaches the public stream");
		ok((end?.messages?.length ?? 0) >= 2, "the enriched agent_end carries the run window, not one synthetic message");
		const settledInput = (end?.messages ?? [])
			.filter((message) => (message as { stopReason?: string }).stopReason !== "aborted")
			.reduce((sum, message) => sum + (message.usage?.input ?? 0), 0);
		strictEqual(settledInput, 52_000, "the run's real input tokens survive the abort");
		// The aborted call re-sent the prompt; the public window reports that
		// estimate instead of the provider's zeros.
		const windowAbort = end?.messages?.find((message) => (message as { stopReason?: string }).stopReason === "aborted") as
			| { usage?: { input?: number; estimated?: boolean } }
			| undefined;
		ok((windowAbort?.usage?.input ?? 0) > 0, "the aborted call's prompt spend is reported, not the provider's zero");
		strictEqual(windowAbort?.usage?.estimated, true, "and it is labelled as an estimate");
	});

	it("publishes the same interrupted usage estimate that persistence records", async () => {
		const entries: SessionEntry[] = [];
		const bus = createSafeEventBus();
		const holder: { loop?: ReturnType<typeof createChatLoop> } = {};
		const seen: ChatLoopEvent[] = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers("local-native"),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			bus,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				agent.state.messages.push(...inputMessages(input));
				await agent.emit({ type: "agent_start" } as never);
				holder.loop?.cancel();
				const aborted = {
					role: "assistant",
					content: [{ type: "text", text: "partial local response" }],
					stopReason: "aborted",
					errorMessage: "Request was aborted",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
					timestamp: Date.now(),
				} as unknown as AgentMessage;
				agent.state.messages.push(aborted);
				await agent.emit({ type: "message_end", message: aborted });
				await agent.emit({ type: "agent_end", messages: [aborted] });
			}),
		} as never);
		holder.loop = loop;
		loop.onEvent((event: ChatLoopEvent) => seen.push(event));

		await loop.submit("write a long answer");

		const publicAbort = seen.find(
			(event) =>
				event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "aborted",
		) as { message?: { usage?: Record<string, unknown> } } | undefined;
		const persistedAbort = entries
			.filter(isAssistantMessageEntry)
			.map((entry) => entry.payload as { text?: string; usage?: Record<string, unknown> })
			.find((payload) => payload.text === "partial local response");

		ok(publicAbort?.message?.usage, "status receives usage for the interrupted partial response");
		ok((publicAbort?.message?.usage?.input as number) > 0, "the sent prompt is reflected in status usage");
		ok((publicAbort?.message?.usage?.output as number) > 0, "the streamed partial is reflected in status usage");
		deepStrictEqual(publicAbort?.message?.usage, persistedAbort?.usage, "status and the durable transcript agree");
	});

	it("feeds the footer tally a thinking-only abort while keeping it out of the transcript (DOGFOOD-F2)", async () => {
		// Esc during a reasoning-only stream: the abort leaves an assistant message
		// with thinking, no text, and the provider's untouched zero usage. The
		// transcript rightly suppresses that hollow turn after the cancel notice,
		// but the footer and the `turn · in/out` receipt settled to zero while the
		// persisted entry carried the estimate.
		const entries: SessionEntry[] = [];
		const bus = createSafeEventBus();
		const holder: { loop?: ReturnType<typeof createChatLoop> } = {};
		const seen: ChatLoopEvent[] = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers("local-native"),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			bus,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				agent.state.messages.push(...inputMessages(input));
				await agent.emit({ type: "agent_start" } as never);
				const thinking = "Weighing which file owns the footer before answering.";
				const aborted = {
					role: "assistant",
					content: [{ type: "thinking", thinking }],
					stopReason: "aborted",
					errorMessage: "Request was aborted",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
					timestamp: Date.now(),
				} as unknown as AgentMessage;
				await agent.emit({ type: "message_start", message: aborted } as never);
				await agent.emit({
					type: "message_update",
					message: aborted,
					assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: thinking, partial: aborted },
				} as never);
				holder.loop?.cancel();
				agent.state.messages.push(aborted);
				await agent.emit({ type: "message_end", message: aborted });
				await agent.emit({ type: "agent_end", messages: [aborted] });
			}),
		} as never);
		holder.loop = loop;
		let now = 1_000;
		const status = createStatusController({
			chat: loop,
			bus,
			providers: providers("local-native"),
			now: () => now,
			setInterval: () => Symbol("interval"),
			clearInterval: () => {},
			setTimeout: () => Symbol("timeout"),
			clearTimeout: () => {},
		});
		const panel = createChatPanel();
		loop.onEvent((event: ChatLoopEvent) => {
			now += 100;
			seen.push(event);
			panel.applyEvent(event as never);
		});

		try {
			await loop.submit("think about it");
		} finally {
			status.dispose();
		}

		const abortedEnds = seen.filter(
			(event) =>
				event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "aborted",
		);
		strictEqual(abortedEnds.length, 0, "the hollow aborted turn stays out of the public transcript stream");
		const persistedRows = entries
			.filter(isAssistantMessageEntry)
			.map((entry) => entry.payload as { text?: string; stopReason?: string; usage?: Record<string, unknown> });
		strictEqual(persistedRows.length, 1, "the hollow aborted message stays out of the ledger");
		const persistedAbort = persistedRows[0];
		const summary = status.current().summary;
		strictEqual(status.current().phase, "ended");
		ok(
			(summary?.inputTokens ?? 0) > 0,
			`the footer reports the prompt the cancelled call sent, got ${summary?.inputTokens}`,
		);
		strictEqual(summary?.outputTokens, 14, "the footer reports the streamed reasoning (53 chars), not the notice text");
		const receipt = panel.render(120).join("\n");
		ok(
			receipt.includes(`turn · in ${summary?.inputTokens}`) && receipt.includes(`· out ${summary?.outputTokens}`),
			`the transcript receipt matches the footer:\n${receipt}`,
		);
		// The ledger's only row for the cancelled turn is the closing notice; it
		// records the cancelled call's spend rather than an estimate of its own text.
		strictEqual(persistedAbort?.text, "[Clio Coder] active response cancelled.");
		strictEqual(persistedAbort?.usage?.input, summary?.inputTokens, "footer and ledger agree on input");
		strictEqual(persistedAbort?.usage?.output, summary?.outputTokens, "footer and ledger agree on output");
		strictEqual(persistedAbort?.usage?.estimated, true);
	});
});

describe("contracts/chat-loop per-turn telemetry", () => {
	it("classifies per-call cache verdicts with the turn-report thresholds", () => {
		strictEqual(backendCacheVerdict(11, 5319), "hot");
		strictEqual(backendCacheVerdict(2400, 3000), "partial");
		strictEqual(backendCacheVerdict(5330, 0), "cold");
		strictEqual(backendCacheVerdict(17, 0), "small");
	});

	it("persists timing + prompt-cache fields and stamps expected-cold reasons after dispatch activity", async () => {
		const entries: SessionEntry[] = [];
		const bus = createSafeEventBus();
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers("local-native"),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			bus,
			createAgent: createFakeAgentFactory(async (agent) => {
				const message = {
					role: "assistant",
					content: [{ type: "text", text: "warm reply" }],
					stopReason: "stop",
					usage: { input: 17, output: 9, cacheRead: 5319, cacheWrite: 0, totalTokens: 5345 },
					timestamp: Date.now(),
				} as unknown as AgentMessage;
				await agent.emit({ type: "agent_start" });
				await agent.emit({ type: "message_start", message });
				await agent.emit({
					type: "message_update",
					message,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "warm", partial: message },
				} as never);
				agent.state.messages.push(message);
				await agent.emit({ type: "message_end", message });
				await agent.emit({ type: "agent_end", messages: [message] });
			}),
		} as never);

		// Worker traffic on the shared backend since the last settled run. The
		// cold-reason subscriber ignores the payload, so a deliberately partial
		// one is emitted through `as never` (emit is compile-checked otherwise).
		bus.emit(BusChannels.DispatchCompleted, { at: Date.now() } as never);
		await loop.submit("after a dispatch ran");

		const assistant = entries.find((entry) => entry.kind === "message" && entry.role === "assistant");
		ok(assistant && assistant.kind === "message");
		const payload = assistant.payload as {
			timing?: { ttftMs: number | null; apiMs: number };
			promptCache?: {
				input: number;
				cacheRead: number;
				cacheWrite: number;
				backendVerdict: string;
				expectedColdReasons?: string[];
			};
		};
		ok(payload.timing && payload.timing.apiMs >= 0, "expected persisted apiMs");
		ok(payload.timing?.ttftMs !== null && (payload.timing?.ttftMs ?? -1) >= 0, "expected persisted ttftMs");
		strictEqual(payload.promptCache?.input, 17);
		strictEqual(payload.promptCache?.cacheRead, 5319);
		strictEqual(payload.promptCache?.backendVerdict, "hot");
		deepStrictEqual(payload.promptCache?.expectedColdReasons, ["dispatch"]);
	});
});

function allowAllSafety(): SafetyContract {
	return {
		classify: () => ({ actionClass: "read", reasons: [] }),
		evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "test", count: 0 }),
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset,
		audit: { recordCount: () => 0 },
	};
}

function dummyTool(name: ToolName): ToolSpec {
	return {
		name,
		description: `${name} test tool`,
		parameters: Type.Object({}),
		baseActionClass: "read",
		run: async () => ({ kind: "ok", output: name }),
	};
}

interface NamedAgentTool {
	name: string;
	execute(toolCallId: string, params: unknown): Promise<unknown>;
}

describe("contracts/chat-loop pending skill tool surface", () => {
	it("keeps the full frozen surface on a pending-skill turn; loading a skill never reshapes the wire schemas", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-chat-skill-"));
		try {
			const skillDir = join(scratch, ".clio-coder", "skills", "narrow");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				[
					"---",
					"name: narrow",
					"description: Narrow surface skill.",
					"allowed-tools:",
					"  - read",
					"  - grep",
					"---",
					"",
					"NARROW BODY",
					"",
				].join("\n"),
				"utf8",
			);

			const registry = createRegistry({ safety: allowAllSafety() });
			registry.register(createContextTool({ getCwd: () => scratch }));
			for (const name of [ToolNames.Read, ToolNames.Grep, ToolNames.Edit, ToolNames.Bash]) {
				registry.register(dummyTool(name));
			}

			const entries: SessionEntry[] = [];
			let toolsAtStart: string[] = [];
			let unrequestedDenied = "";
			let readSkillOutput = "";
			let updateAfterLoad: unknown = "unset";
			const loop = createChatLoop({
				getSettings: () => settings(),
				providers: providers(),
				knownTargets: () => new Set(["test-target"]),
				session: createSession(entries),
				readSessionEntries: () => entries,
				toolRegistry: registry,
				createAgent: createFakeAgentFactory(async (agent, input) => {
					agent.state.messages.push(...inputMessages(input));
					const tools = agent.state.tools as NamedAgentTool[];
					toolsAtStart = tools.map((tool) => tool.name);
					const contextTool = tools.find((tool) => tool.name === "context");
					ok(contextTool, "context must be active on a pending-skill turn");
					// Invoke-time policy still gates skill loading even though the
					// wire schemas never narrow.
					try {
						const denied = (await contextTool.execute("call-0", { scope: "skills", name: "unrequested" })) as {
							content?: Array<{ type: string; text?: string }>;
						};
						unrequestedDenied = denied.content?.find((part) => part.type === "text")?.text ?? "";
					} catch (err) {
						unrequestedDenied = err instanceof Error ? err.message : String(err);
					}
					const result = (await contextTool.execute("call-1", { scope: "skills", name: "narrow" })) as {
						content?: Array<{ type: string; text?: string }>;
					};
					readSkillOutput = result.content?.find((part) => part.type === "text")?.text ?? "";
					agent.state.messages.push({
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "context", arguments: { scope: "skills", name: "narrow" } }],
						stopReason: "toolUse",
						timestamp: Date.now(),
					} as unknown as AgentMessage);
					agent.state.messages.push({
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "context",
						content: [{ type: "text", text: readSkillOutput }],
						timestamp: Date.now(),
					} as unknown as AgentMessage);
					updateAfterLoad = await agent.prepareNextTurn?.(new AbortController().signal);
				}),
			} as never);

			await loop.submit("science skills for expert subagents", {
				pendingSkillRequests: [
					{
						name: "narrow",
						args: "science skills for expert subagents",
						source: "slash-command",
						installed: true,
						filePath: join(skillDir, "SKILL.md"),
					},
				],
			});

			// The frozen surface: every registered tool, sorted, from the first call.
			deepStrictEqual(toolsAtStart, ["bash", "context", "edit", "grep", "read"]);
			ok(unrequestedDenied.includes("pending skill request"));
			ok(readSkillOutput.includes("NARROW BODY"));
			// Loading a skill must not push a continuation update that reshapes tools.
			strictEqual(updateAfterLoad, undefined);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("releases skill narrowing when the turn that requested it ends", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-chat-skill-life-"));
		try {
			const skillDir = join(scratch, ".clio-coder", "skills", "narrow");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				[
					"---",
					"name: narrow",
					"description: Narrow surface skill.",
					"allowed-tools:",
					"  - read",
					"---",
					"",
					"BODY",
					"",
				].join("\n"),
				"utf8",
			);

			const registry = createRegistry({ safety: allowAllSafety() });
			registry.register(createContextTool({ getCwd: () => scratch }));
			for (const name of [ToolNames.Read, ToolNames.Edit]) registry.register(dummyTool(name));

			const entries: SessionEntry[] = [];
			const editOutcomes: string[] = [];
			let turn = 0;
			const loop = createChatLoop({
				getSettings: () => settings(),
				providers: providers(),
				knownTargets: () => new Set(["test-target"]),
				session: createSession(entries),
				readSessionEntries: () => entries,
				toolRegistry: registry,
				createAgent: createFakeAgentFactory(async (agent, input) => {
					agent.state.messages.push(...inputMessages(input));
					const tools = agent.state.tools as NamedAgentTool[];
					turn += 1;
					if (turn === 1) {
						const contextTool = tools.find((tool) => tool.name === "context");
						ok(contextTool);
						await contextTool.execute("call-load", { scope: "skills", name: "narrow" });
					}
					const editTool = tools.find((tool) => tool.name === "edit");
					ok(editTool);
					try {
						const result = (await editTool.execute(`call-edit-${turn}`, {})) as {
							content?: Array<{ type: string; text?: string }>;
						};
						editOutcomes.push(result.content?.find((part) => part.type === "text")?.text ?? "");
					} catch (err) {
						editOutcomes.push(err instanceof Error ? err.message : String(err));
					}
					const message = {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						stopReason: "stop",
						timestamp: Date.now(),
					} as unknown as AgentMessage;
					agent.state.messages.push(message);
					await agent.emit({ type: "message_end", message } as never);
					await agent.emit({ type: "agent_end", messages: [message] } as never);
				}),
			} as never);

			await loop.submit("use the skill", {
				pendingSkillRequests: [
					{ name: "narrow", args: "", source: "slash-command", installed: true, filePath: join(skillDir, "SKILL.md") },
				],
			});
			await loop.submit("a plain turn with no skill request");

			// Narrowing is scoped to the turn that requested the skill. Outliving
			// it is a silent capability loss; ending early is a silent grant.
			ok(
				editOutcomes[0]?.includes("narrow"),
				`expected edit blocked by the active skill in turn 1, got ${JSON.stringify(editOutcomes[0])}`,
			);
			ok(
				editOutcomes[1] !== undefined && !editOutcomes[1].includes("narrow"),
				`expected edit admitted once the requesting turn ended, got ${JSON.stringify(editOutcomes[1])}`,
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("supplies structured task memory only to an explicit context-handoff request", async () => {
		const entries: SessionEntry[] = [];
		let sourceReads = 0;
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			getTaskMemoryHandoffSource: () => {
				sourceReads += 1;
				return '[Task memory handoff source]\n```clio-task-memory\n{"version":1,"knowledge":[],"procedural":[]}\n```';
			},
			createAgent: createFakeAgentFactory(async (agent, input) => {
				const incoming = inputMessages(input);
				agent.state.messages.push(...incoming);
				const message = {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
					timestamp: Date.now(),
				} as unknown as AgentMessage;
				agent.state.messages.push(message);
				await agent.emit({ type: "message_end", message } as never);
				await agent.emit({ type: "agent_end", messages: [message] } as never);
			}),
		} as never);

		await loop.submit("write a handoff", {
			pendingSkillRequests: [{ name: "context-handoff", args: "", source: "slash-command", installed: true }],
		});
		await loop.submit("ordinary follow-up");

		strictEqual(sourceReads, 1);
		const userText = entries
			.filter(
				(entry): entry is Extract<SessionEntry, { kind: "message" }> => entry.kind === "message" && entry.role === "user",
			)
			.map((entry) => (entry.payload as { text?: string }).text ?? "");
		ok(userText[0]?.includes("Task memory handoff source"));
		ok(userText[0]?.includes("clio-task-memory"));
		ok(!userText[1]?.includes("Task memory handoff source"));
	});
});

describe("contracts/chat-loop locked-turn markup sanitation", () => {
	const MARKUP =
		"<tool_call>\n<function=grep>\n<parameter=pattern>\nhttp|network\n</parameter>\n<parameter=mode>\nfiles\n</parameter>\n</function>\n</tool_call>";

	function lockoutPayload(): LoopBlockedPayload {
		return {
			tool: "grep",
			repeatCount: 4,
			blocksThisTurn: 2,
			budget: 2,
			interrupted: false,
			disposition: "lockout",
			at: Date.now(),
		};
	}

	function markupAgentFactory(bus: ReturnType<typeof createSafeEventBus> | null) {
		return createFakeAgentFactory(async (agent, input) => {
			agent.state.messages.push(...inputMessages(input));
			// The guard locks the turn mid-run (bus event), then the forced
			// text-only round streams dead markup and finishes.
			if (bus) bus.emit(BusChannels.LoopBlocked, lockoutPayload());
			const message = {
				role: "assistant",
				content: [{ type: "text", text: MARKUP }],
				stopReason: "stop",
				usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 140 },
				timestamp: Date.now(),
			} as unknown as AgentMessage;
			agent.state.messages.push(message);
			await agent.emit({ type: "agent_start", messages: [] } as never);
			await agent.emit({ type: "message_start", message } as never);
			await agent.emit({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: MARKUP, partial: message },
			} as never);
			await agent.emit({ type: "message_end", message } as never);
			await agent.emit({ type: "agent_end", messages: [message] } as never);
		});
	}

	it("strips dead markup from the locked turn at one seam: event, ledger, panel, agent state", async () => {
		const entries: SessionEntry[] = [];
		const bus = createSafeEventBus();
		const panel = createChatPanel();
		const events: ChatLoopEvent[] = [];
		let agentState: { messages: AgentMessage[] } | null = null;
		const factory = markupAgentFactory(bus);
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			bus,
			createAgent: ((options: never) => {
				const handle = (factory as (options: never) => { agent: never; state: () => never })(options);
				agentState = (handle as { agent: { state: { messages: AgentMessage[] } } }).agent.state;
				return handle;
			}) as never,
		} as never);
		loop.onEvent((event: ChatLoopEvent) => {
			events.push(event);
			panel.applyEvent(event as never);
		});

		await loop.submit("does this repo have a network layer?");

		const fallback = lockedSynthesisFallbackText();
		// Emitted message_end carries the sanitized message plus the marker the
		// panel uses to replace its streamed (markup) tail.
		const messageEnd = events.find(
			(event) => event.type === "message_end" && (event as { message?: AgentMessage }).message?.role === "assistant",
		) as { message: AgentMessage; lockedSynthesisSanitized?: boolean } | undefined;
		ok(messageEnd, "assistant message_end reached consumers");
		const emittedBlocks = (messageEnd.message as { content?: Array<{ type: string; text?: string }> }).content ?? [];
		const emittedText = emittedBlocks
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("");
		strictEqual(emittedText, fallback, "emitted message text is the fallback");
		strictEqual(messageEnd.lockedSynthesisSanitized, true, "the event is marked sanitized");
		// Session ledger persisted the sanitized text.
		const assistant = entries.find(isAssistantMessageEntry);
		ok(assistant, "assistant turn persisted");
		const persistedText = (assistant.payload as { text?: string }).text ?? "";
		strictEqual(persistedText, fallback, "ledger text is the fallback");
		// The panel replaced its streamed markup tail with the sanitized text.
		const rendered = panel.render(100).join("\n");
		ok(!rendered.includes("<tool_call>"), "no markup survives in the rendered transcript");
		ok(rendered.includes("loop guard:"), "the fallback renders in the transcript");
		// Agent state holds the same sanitized object (next-round payloads, /tree).
		const stateMessages = (agentState as unknown as { messages: AgentMessage[] } | null)?.messages ?? [];
		const lastAssistant = stateMessages[stateMessages.length - 1] as { content: Array<{ text?: string }> };
		strictEqual(lastAssistant.content[0]?.text, fallback, "agent state was mutated in place");
	});

	it("keeps prose around a dead block and does not fall back", async () => {
		const entries: SessionEntry[] = [];
		const bus = createSafeEventBus();
		const prose = "The repository has no network layer.";
		const factory = createFakeAgentFactory(async (agent, input) => {
			agent.state.messages.push(...inputMessages(input));
			bus.emit(BusChannels.LoopBlocked, lockoutPayload());
			const message = {
				role: "assistant",
				content: [{ type: "text", text: `${prose}\n\n${MARKUP}` }],
				stopReason: "stop",
				timestamp: Date.now(),
			} as unknown as AgentMessage;
			agent.state.messages.push(message);
			await agent.emit({ type: "message_start", message } as never);
			await agent.emit({ type: "message_end", message } as never);
			await agent.emit({ type: "agent_end", messages: [message] } as never);
		});
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			bus,
			createAgent: factory,
		} as never);

		await loop.submit("does this repo have a network layer?");

		const assistant = entries.find(isAssistantMessageEntry);
		ok(assistant, "assistant turn persisted");
		strictEqual((assistant.payload as { text?: string }).text, prose, "prose survives, markup does not");
	});

	it("leaves ordinary turns untouched: same markup text without a lockout persists verbatim", async () => {
		const entries: SessionEntry[] = [];
		const events: ChatLoopEvent[] = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			createAgent: markupAgentFactory(null),
		} as never);
		loop.onEvent((event: ChatLoopEvent) => events.push(event));

		await loop.submit("does this repo have a network layer?");

		const assistant = entries.find(isAssistantMessageEntry);
		ok(assistant, "assistant turn persisted");
		strictEqual((assistant.payload as { text?: string }).text, MARKUP, "unlocked turns are never sanitized");
		const messageEnd = events.find(
			(event) => event.type === "message_end" && (event as { message?: AgentMessage }).message?.role === "assistant",
		) as { lockedSynthesisSanitized?: boolean } | undefined;
		strictEqual(messageEnd?.lockedSynthesisSanitized, undefined, "no sanitize marker on ordinary turns");
	});

	it("clears the lock at the next user turn so later turns stream markup untouched", async () => {
		const entries: SessionEntry[] = [];
		const bus = createSafeEventBus();
		let turn = 0;
		const factory = createFakeAgentFactory(async (agent, input) => {
			agent.state.messages.push(...inputMessages(input));
			turn += 1;
			if (turn === 1) bus.emit(BusChannels.LoopBlocked, lockoutPayload());
			const message = {
				role: "assistant",
				content: [{ type: "text", text: MARKUP }],
				stopReason: "stop",
				timestamp: Date.now(),
			} as unknown as AgentMessage;
			agent.state.messages.push(message);
			await agent.emit({ type: "message_start", message } as never);
			await agent.emit({ type: "message_end", message } as never);
			await agent.emit({ type: "agent_end", messages: [message] } as never);
		});
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			bus,
			createAgent: factory,
		} as never);

		await loop.submit("first turn: locked");
		await loop.submit("second turn: ordinary");

		const assistants = entries.filter(isAssistantMessageEntry);
		strictEqual(assistants.length, 2, "both turns persisted");
		strictEqual(
			(assistants[0]?.payload as { text?: string }).text,
			lockedSynthesisFallbackText(),
			"locked turn sanitized",
		);
		strictEqual((assistants[1]?.payload as { text?: string }).text, MARKUP, "next turn is unlocked again");
	});
});

/**
 * A stream that goes silent and never comes back. The fake mirrors
 * pi-agent-core's `runWithLifecycle`: `abort()` does not reject `prompt()`, it
 * settles the run with an `stopReason: "aborted"` assistant message and
 * resolves. That distinction is the whole reason the escalation hangs off the
 * post-resolve failure path rather than the catch arm.
 */
function createSilentStreamAgentFactory(
	record: { starts: number; aborts: number; abortedDuringTool: boolean },
	holdToolMs = 0,
	dropToolEnd = false,
) {
	let listener: ((event: AgentEvent, signal: AbortSignal) => Promise<void> | void) | null = null;
	const state = {
		systemPrompt: "",
		model: undefined,
		thinkingLevel: "off",
		tools: [] as unknown[],
		messages: [] as AgentMessage[],
		errorMessage: undefined as string | undefined,
	};
	const controller = new AbortController();
	const emit = async (event: AgentEvent): Promise<void> => {
		await listener?.(event, controller.signal);
	};
	let release: (() => void) | null = null;
	let toolRunning = false;
	const run = async (): Promise<void> => {
		record.starts += 1;
		await emit({ type: "agent_start" } as never);
		if (holdToolMs > 0) {
			// A tool that runs longer than the stall threshold: the stream is
			// quiet, but the silence belongs to the tool, not the backend.
			toolRunning = true;
			await emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" } as never);
			await new Promise((resolve) => setTimeout(resolve, holdToolMs));
			if (dropToolEnd) {
				toolRunning = false;
				// The mediator died with the call in flight, so the end event is
				// never emitted. The engine settles the turn anyway, which is the
				// only evidence the runtime gets that nothing is still executing.
				await emit({
					type: "turn_end",
					message: { role: "assistant", content: [], stopReason: "toolUse", timestamp: Date.now() },
					toolResults: [],
				} as never);
			} else {
				await emit({
					type: "tool_execution_end",
					toolCallId: "call-1",
					toolName: "bash",
					isError: false,
					result: { content: [{ type: "text", text: "suite passed" }] },
				} as never);
				toolRunning = false;
			}
		}
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		const failure = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			stopReason: "aborted",
			errorMessage: "Request was aborted.",
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		state.messages.push(failure);
		await emit({ type: "message_end", message: failure } as never);
		await emit({ type: "agent_end", messages: [failure] } as never);
	};
	const factory = (() => ({
		agent: {
			state,
			sessionId: undefined,
			maxRetryDelayMs: undefined,
			prepareNextTurn: undefined,
			subscribe(l: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void) {
				listener = l;
				return () => {};
			},
			emit,
			prompt: run,
			continue: run,
			followUp() {},
			abort() {
				record.aborts += 1;
				if (toolRunning) record.abortedDuringTool = true;
				release?.();
				release = null;
			},
			clearAllQueues() {},
			clearFollowUpQueue() {},
			clearSteeringQueue() {},
		},
		state: () => state,
	})) as never;
	return factory;
}

/**
 * A healthy stream on a host whose wall clock jumps forward mid-run: an NTP
 * correction on a node that booted without an RTC battery, or a laptop resuming
 * from suspend. Deltas keep arriving the whole time, so there is no silence to
 * escalate on; only `Date.now()` moves.
 *
 * The timeline is laid out against a 500ms threshold: deltas at 100/200/300ms,
 * the step at 400ms, the next delta at 650ms. The watchdog's first fire lands at
 * 500ms, inside the 350ms gap and after the step, which is exactly the window
 * where a wall-clock-measured idle reads +200s and aborts a live run.
 */
function createClockStepAgentFactory(record: { starts: number; aborts: number }, stepClock: () => void) {
	let listener: ((event: AgentEvent, signal: AbortSignal) => Promise<void> | void) | null = null;
	const state = {
		systemPrompt: "",
		model: undefined,
		thinkingLevel: "off",
		tools: [] as unknown[],
		messages: [] as AgentMessage[],
		errorMessage: undefined as string | undefined,
	};
	const controller = new AbortController();
	const emit = async (event: AgentEvent): Promise<void> => {
		await listener?.(event, controller.signal);
	};
	const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "still streaming" }],
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AgentMessage;
	const delta = async (): Promise<void> => {
		await emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "token ", partial: message },
		} as never);
	};
	const run = async (): Promise<void> => {
		record.starts += 1;
		await emit({ type: "agent_start" } as never);
		await emit({ type: "message_start", message } as never);
		await sleep(100);
		await delta();
		await sleep(100);
		await delta();
		await sleep(100);
		await delta();
		await sleep(100);
		stepClock();
		await sleep(250);
		await delta();
		state.messages.push(message);
		await emit({ type: "message_end", message } as never);
		await emit({ type: "agent_end", messages: [message] } as never);
	};
	return (() => ({
		agent: {
			state,
			sessionId: undefined,
			maxRetryDelayMs: undefined,
			prepareNextTurn: undefined,
			subscribe(l: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void) {
				listener = l;
				return () => {};
			},
			emit,
			prompt: run,
			continue: run,
			followUp() {},
			abort() {
				record.aborts += 1;
			},
			clearAllQueues() {},
			clearFollowUpQueue() {},
			clearSteeringQueue() {},
		},
		state: () => state,
	})) as never;
}

describe("contracts/chat-loop stream stall escalation", () => {
	// The runtime unrefs the stall watchdog on purpose: a real request holds the
	// event loop open and the timer must not keep a settled headless run alive.
	// The fake agents here hold nothing open, so on Node 22 the loop drains
	// before the watchdog can fire and the runner cancels the pending await.
	// A ref'd interval stands in for the in-flight request.
	let keepAlive: ReturnType<typeof setInterval> | null = null;
	beforeEach(() => {
		keepAlive = setInterval(() => {}, 1_000);
	});
	afterEach(() => {
		if (keepAlive !== null) clearInterval(keepAlive);
		keepAlive = null;
	});

	it("aborts a silently stalled stream, retries the ladder, and exhausts into a typed failure", async () => {
		const cfg = settings();
		cfg.retry = { enabled: true, maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0, streamStallMs: 40 };
		const record = { starts: 0, aborts: 0, abortedDuringTool: false };
		const entries: SessionEntry[] = [];
		const loop = createChatLoop({
			getSettings: () => cfg,
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			createAgent: createSilentStreamAgentFactory(record),
		} as never);
		const events: ChatLoopEvent[] = [];
		loop.onEvent((event) => events.push(event));

		await loop.submit("summarize these files");

		strictEqual(record.starts, 3, "the first attempt plus both retries each stalled and restarted");
		strictEqual(record.aborts, 3, "every stall aborts through the same agent.abort() the Esc path uses");
		const statuses = events
			.filter((event): event is Extract<ChatLoopEvent, { type: "retry_status" }> => event.type === "retry_status")
			.map((event) => event.status);
		deepStrictEqual(
			statuses.filter((status) => status.phase === "retrying").map((status) => status.attempt),
			[1, 2],
			"the ladder walks attempt 1 then attempt 2",
		);
		const exhausted = statuses.find((status) => status.phase === "exhausted");
		ok(exhausted, "exhaustion is reported as a typed retry_status, not a silent hang");
		strictEqual(exhausted?.attempt, 2, "exhaustion lands on the configured last attempt");
		ok(
			exhausted?.errorMessage?.includes("stream stalled"),
			`the stall reason survives into the typed failure, got: ${exhausted?.errorMessage}`,
		);
		const terminalAssistants = entries.filter(isAssistantMessageEntry);
		strictEqual(terminalAssistants.length, 3, "each attempt persists exactly one terminal assistant row");
		for (const entry of terminalAssistants) {
			const payload = entry.payload as { stopReason?: unknown; errorMessage?: unknown };
			strictEqual(payload.stopReason, "error");
			ok(
				String(payload.errorMessage ?? "").startsWith("stream stalled:"),
				"every persisted attempt names the stall rather than the provider's generic abort",
			);
			strictEqual(String(payload.errorMessage ?? "").includes("Request aborted"), false);
		}
	});

	it("leaves a long-running tool alone: silence during tool execution is not a stalled stream", async () => {
		const cfg = settings();
		cfg.retry = { enabled: true, maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, streamStallMs: 30 };
		const record = { starts: 0, aborts: 0, abortedDuringTool: false };
		const loop = createChatLoop({
			getSettings: () => cfg,
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(),
			readSessionEntries: () => [],
			createAgent: createSilentStreamAgentFactory(record, 90),
		} as never);

		await loop.submit("run the suite");

		strictEqual(record.abortedDuringTool, false, "a tool running past the threshold is not a stalled stream");
		strictEqual(record.aborts, 2, "the watchdog still escalates on the silence that follows the tool");
	});

	it("survives a forward wall-clock step of 200s while the stream is producing output", async () => {
		const cfg = settings();
		cfg.retry = { enabled: true, maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, streamStallMs: 500 };
		const record = { starts: 0, aborts: 0 };
		const entries: SessionEntry[] = [];
		const realNow = Date.now;
		let clockOffsetMs = 0;
		Date.now = () => realNow() + clockOffsetMs;
		try {
			const loop = createChatLoop({
				getSettings: () => cfg,
				providers: providers(),
				knownTargets: () => new Set(["test-target"]),
				session: createSession(entries),
				readSessionEntries: () => entries,
				createAgent: createClockStepAgentFactory(record, () => {
					clockOffsetMs = 200_000;
				}),
			} as never);

			await loop.submit("summarize these files");
		} finally {
			Date.now = realNow;
		}

		strictEqual(record.aborts, 0, "a wall-clock step is not stream silence and must not abort a live run");
		strictEqual(record.starts, 1, "no spurious stall means no trip through the retry ladder");
		ok(
			!entries
				.filter(isAssistantMessageEntry)
				.some((entry) =>
					String((entry.payload as { errorMessage?: unknown }).errorMessage ?? "").includes("stream stalled"),
				),
			"no fabricated stall is recorded in the transcript",
		);
	});

	// The timeout is the assertion's safety net: a watchdog left suspended by the
	// lost end event never fires, so the run never settles and the test would
	// otherwise hang instead of failing.
	it("fires on a later stall even when a tool's end event never arrived", { timeout: 5_000 }, async () => {
		const cfg = settings();
		cfg.retry = { enabled: true, maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, streamStallMs: 40 };
		const record = { starts: 0, aborts: 0, abortedDuringTool: false };
		const entries: SessionEntry[] = [];
		const loop = createChatLoop({
			getSettings: () => cfg,
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			createAgent: createSilentStreamAgentFactory(record, 20, true),
		} as never);

		await loop.submit("run the suite");

		strictEqual(record.aborts, 1, "the lost end event must not disable the watchdog for the rest of the run");
		ok(
			entries
				.filter(isAssistantMessageEntry)
				.some((entry) =>
					String((entry.payload as { errorMessage?: unknown }).errorMessage ?? "").includes("stream stalled"),
				),
			"the abort is classified as a stall, not as an operator cancel",
		);
	});
});
