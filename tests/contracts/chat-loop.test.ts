import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import type { EndpointStatus, ProvidersContract } from "../../src/domains/providers/contract.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { EndpointDescriptor } from "../../src/domains/providers/types/endpoint-descriptor.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { CompactResult } from "../../src/domains/session/compaction/compact.js";
import type { SessionContract, SessionEntryInput, SessionMeta, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { createChatLoop, type ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";

function settings(overrides: Partial<ClioSettings["compaction"]> = {}): ClioSettings {
	const value = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	value.orchestrator.endpoint = "mini";
	value.orchestrator.model = "model";
	value.endpoints = [
		{
			id: "mini",
			runtime: "fake-runtime",
			defaultModel: "model",
			capabilities: { contextWindow: 1000, maxTokens: 256, tools: true, chat: true },
		},
	];
	value.compaction = { ...value.compaction, ...overrides };
	return value;
}

function modes(): ModesContract {
	return {
		current: () => "default",
		setMode: () => "default",
		cycleNormal: () => "default",
		visibleTools: () => new Set(),
		isToolVisible: () => false,
		isActionAllowed: () => true,
		requestSuper: () => {},
		confirmSuper: () => "super",
		elevatedModeFor: () => null,
	};
}

function providers(): ProvidersContract {
	const endpoint: EndpointDescriptor = {
		id: "mini",
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
	const status: EndpointStatus = {
		endpoint,
		runtime,
		available: true,
		reason: "test",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...runtime.defaultCapabilities },
		discoveredModels: ["model"],
	};
	return {
		list: () => [status],
		getEndpoint: (id: string) => (id === endpoint.id ? endpoint : null),
		getRuntime: (id: string) => (id === runtime.id ? runtime : null),
		getDetectedReasoning: () => null,
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
				endpoint: input?.endpoint ?? "mini",
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
		editLabel: () => {},
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

describe("contracts/chat-loop compaction and terminal notices", () => {
	it("runs post-tool compaction guard before an oversized continuation", async () => {
		const entries: SessionEntry[] = [];
		let compactTrigger: string | undefined;
		let prepareUpdate: unknown;
		const loop = createChatLoop({
			getSettings: () =>
				settings({
					thresholds: {
						warning: 0.1,
						maskObservations: 0.2,
						pruneObservations: 0.3,
						maskDialogue: 0.4,
						llmSummary: 0.5,
					},
				}),
			modes: modes(),
			providers: providers(),
			knownEndpoints: () => new Set(["mini"]),
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
			modes: modes(),
			providers: providers(),
			knownEndpoints: () => new Set(["mini"]),
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
		const payload = assistant.payload as { contextExhaustion?: { kind?: string; contextWindow?: number } };
		strictEqual(payload.contextExhaustion?.kind, "provider_length_stop");
		strictEqual(payload.contextExhaustion?.contextWindow, 1000);
		ok(panel.render(120).join("\n").includes("output/context limit"));
	});
});
