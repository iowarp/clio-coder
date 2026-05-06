import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import type { ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { SessionContract, SessionMeta, TurnInput } from "../../src/domains/session/contract.js";
import type { EngineAgentHandle } from "../../src/engine/agent.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { type ChatLoopEvent, createChatLoop } from "../../src/interactive/chat-loop.js";

function defer<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function fakeModes(): ModesContract {
	return {
		current: () => "default",
		setMode: () => "default",
		cycleNormal: () => "default",
		visibleTools: () => new Set(),
		isToolVisible: () => false,
		isActionAllowed: () => true,
		requestSuper: () => {},
		confirmSuper: () => "default",
		elevatedModeFor: () => null,
	};
}

function fakeProviders(): ProvidersContract {
	const endpoint = { id: "stub-endpoint", runtime: "stub-runtime", defaultModel: "stub-model" };
	const runtime: RuntimeDescriptor = {
		id: "stub-runtime",
		displayName: "Stub",
		kind: "http",
		apiFamily: "openai-responses",
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true },
		synthesizeModel: () => ({ id: "stub-model", provider: "stub-runtime" }) as never,
	};
	return {
		list: () => [],
		getEndpoint: (id) => (id === endpoint.id ? endpoint : null),
		getRuntime: (id) => (id === runtime.id ? runtime : null),
		probeAll: async () => {},
		probeAllLive: async () => {},
		probeEndpoint: async () => null,
		disconnectEndpoint: () => null,
		auth: {
			statusForTarget: () => ({ providerId: "stub", available: true, source: "none", detail: "stub" }) as never,
			resolveForTarget: async () => ({ providerId: "stub", available: true, source: "none", apiKey: "local" }) as never,
			getStored: () => null,
			listStored: () => [],
			setApiKey: () => {},
			remove: () => {},
			login: async () => {},
			logout: () => {},
			getOAuthProviders: () => [],
			setRuntimeOverrideForTarget: () => {},
			clearRuntimeOverrideForTarget: () => {},
		},
		credentials: { hasKey: () => false, get: () => null, set: () => {}, remove: () => {} },
		getDetectedReasoning: () => null,
		probeReasoningForModel: async () => null,
		knowledgeBase: null,
	};
}

function fakeSession(appended: TurnInput[]): SessionContract {
	const meta = { id: "s1", cwd: process.cwd(), createdAt: new Date().toISOString() } as unknown as SessionMeta;
	let nextId = 0;
	return {
		current: () => meta,
		create: () => meta,
		append: (turn) => {
			appended.push(turn);
			nextId += 1;
			return { ...turn, id: `t${nextId}`, at: new Date().toISOString() } as never;
		},
		appendEntry: () => ({ turnId: "e1", timestamp: new Date().toISOString(), kind: "custom" }) as never,
		checkpoint: async () => {},
		resume: () => meta,
		fork: () => meta,
		tree: () => ({ sessionId: "s1", nodes: [], leafId: null }) as never,
		switchBranch: () => meta,
		editLabel: () => {},
		deleteSession: () => {},
		history: () => [meta],
		close: async () => {},
	};
}

function textMessage(role: "user" | "assistant", text: string): AgentMessage {
	if (role === "user") return { role, content: text, timestamp: Date.now() } as AgentMessage;
	return {
		role,
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage;
}

describe("interactive/chat-loop follow-up queue", () => {
	it("queues follow-ups during streaming and persists them when the agent consumes them", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "stub-endpoint";
		settings.orchestrator.model = "stub-model";
		const appended: TurnInput[] = [];
		const promptStarted = defer();
		const finishPrompt = defer();
		const queueEvents: string[][] = [];
		let subscribeCb: ((event: AgentEvent) => void | Promise<void>) | null = null;
		const queued: AgentMessage[] = [];
		const agentState = {
			systemPrompt: "",
			model: {} as never,
			thinkingLevel: "off",
			tools: [],
			messages: [] as AgentMessage[],
			isStreaming: false,
			pendingToolCalls: new Set<string>(),
			errorMessage: undefined,
		};

		const loop = createChatLoop({
			getSettings: () => settings,
			modes: fakeModes(),
			providers: fakeProviders(),
			knownEndpoints: () => new Set(["stub-endpoint"]),
			session: fakeSession(appended),
			createAgent: () => {
				const agent = {
					state: agentState,
					sessionId: undefined as string | undefined,
					subscribe: (cb: (event: AgentEvent) => void | Promise<void>) => {
						subscribeCb = cb;
						return () => {
							subscribeCb = null;
						};
					},
					prompt: async (text: string) => {
						const messages = [textMessage("user", text)];
						await subscribeCb?.({ type: "agent_start" });
						await subscribeCb?.({ type: "message_end", message: messages[0] as AgentMessage });
						promptStarted.resolve();
						await finishPrompt.promise;
						const first = textMessage("assistant", "first done");
						messages.push(first);
						await subscribeCb?.({ type: "message_end", message: first });
						for (const followUp of queued.splice(0)) {
							messages.push(followUp);
							await subscribeCb?.({ type: "message_end", message: followUp });
							const reply = textMessage("assistant", "follow-up done");
							messages.push(reply);
							await subscribeCb?.({ type: "message_end", message: reply });
						}
						agentState.messages = messages;
						await subscribeCb?.({ type: "agent_end", messages });
					},
					followUp: (message: AgentMessage) => {
						queued.push(message);
					},
					clearFollowUpQueue: () => {
						queued.length = 0;
					},
					clearAllQueues: () => {
						queued.length = 0;
					},
					abort: () => {},
				};
				return {
					agent: agent as unknown as EngineAgentHandle["agent"],
					state: () => agent.state,
				} as unknown as EngineAgentHandle;
			},
		});
		loop.onEvent((event: ChatLoopEvent) => {
			if (event.type === "queue_update") queueEvents.push(event.followUp);
		});

		const submitted = loop.submit("first");
		await promptStarted.promise;

		strictEqual(loop.queueFollowUp("next"), true);
		deepStrictEqual(loop.queuedMessages().followUp, ["next"]);
		finishPrompt.resolve();
		await submitted;

		deepStrictEqual(queueEvents, [["next"], []]);
		deepStrictEqual(
			appended.filter((turn) => turn.kind === "user").map((turn) => (turn.payload as { text?: string }).text),
			["first", "next"],
		);
	});

	it("restores queued follow-ups and clears the agent follow-up queue", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "stub-endpoint";
		settings.orchestrator.model = "stub-model";
		const promptStarted = defer();
		const finishPrompt = defer();
		let subscribeCb: ((event: AgentEvent) => void | Promise<void>) | null = null;
		const queued: AgentMessage[] = [];
		const agentState = {
			systemPrompt: "",
			model: {} as never,
			thinkingLevel: "off",
			tools: [],
			messages: [] as AgentMessage[],
			isStreaming: false,
			pendingToolCalls: new Set<string>(),
			errorMessage: undefined,
		};

		const loop = createChatLoop({
			getSettings: () => settings,
			modes: fakeModes(),
			providers: fakeProviders(),
			knownEndpoints: () => new Set(["stub-endpoint"]),
			createAgent: () => {
				const agent = {
					state: agentState,
					sessionId: undefined as string | undefined,
					subscribe: (cb: (event: AgentEvent) => void | Promise<void>) => {
						subscribeCb = cb;
						return () => {
							subscribeCb = null;
						};
					},
					prompt: async (text: string) => {
						await subscribeCb?.({ type: "agent_start" });
						await subscribeCb?.({ type: "message_end", message: textMessage("user", text) });
						promptStarted.resolve();
						await finishPrompt.promise;
						const reply = textMessage("assistant", "done");
						agentState.messages = [reply];
						await subscribeCb?.({ type: "message_end", message: reply });
						await subscribeCb?.({ type: "agent_end", messages: [reply] });
					},
					followUp: (message: AgentMessage) => {
						queued.push(message);
					},
					clearFollowUpQueue: () => {
						queued.length = 0;
					},
					clearAllQueues: () => {
						queued.length = 0;
					},
					abort: () => {},
				};
				return {
					agent: agent as unknown as EngineAgentHandle["agent"],
					state: () => agent.state,
				} as unknown as EngineAgentHandle;
			},
		});

		const submitted = loop.submit("first");
		await promptStarted.promise;

		strictEqual(loop.queueFollowUp("next one"), true);
		strictEqual(loop.queueFollowUp("next two"), true);
		deepStrictEqual(loop.clearQueuedFollowUps(), ["next one", "next two"]);
		deepStrictEqual(loop.queuedMessages().followUp, []);
		strictEqual(queued.length, 0);

		finishPrompt.resolve();
		await submitted;
	});
});
