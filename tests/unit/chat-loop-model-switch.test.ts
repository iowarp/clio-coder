import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { EndpointDescriptor } from "../../src/domains/providers/types/endpoint-descriptor.js";
import type { EngineAgentHandle } from "../../src/engine/agent.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";

interface AgentStateLike {
	systemPrompt: string;
	model: { id?: string; reasoning?: boolean; contextWindow?: number };
	thinkingLevel: string;
	tools: never[];
	messages: AgentMessage[];
	isStreaming: boolean;
	pendingToolCalls: Set<string>;
	errorMessage: undefined;
}

function modesContract(): Parameters<typeof createChatLoop>[0]["modes"] {
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

function buildProvidersAndRuntimes(opts: {
	endpoints: EndpointDescriptor[];
	runtimes: RuntimeDescriptor[];
}): ProvidersContract {
	return {
		list: () => [],
		getEndpoint: (id) => opts.endpoints.find((e) => e.id === id) ?? null,
		getRuntime: (id) => opts.runtimes.find((r) => r.id === id) ?? null,
		probeAll: async () => {},
		probeAllLive: async () => {},
		probeEndpoint: async () => null,
		disconnectEndpoint: () => null,
		auth: {
			statusForTarget: () =>
				({
					providerId: "stub",
					available: true,
					source: "none",
					detail: "stub",
				}) as never,
			resolveForTarget: async () =>
				({
					providerId: "stub",
					available: true,
					source: "none",
					apiKey: "local",
				}) as never,
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
		knowledgeBase: null,
	};
}

function createStubAgent(state: AgentStateLike, onAbort?: () => void): EngineAgentHandle {
	const agent = {
		state,
		sessionId: undefined as string | undefined,
		subscribe: () => () => {},
		prompt: async () => {},
		abort: () => {
			onAbort?.();
		},
	};
	return {
		agent: agent as unknown as EngineAgentHandle["agent"],
		state: () => agent.state,
	} as unknown as EngineAgentHandle;
}

describe("interactive/chat-loop model switch", () => {
	it("hot-swaps the model in place on a same-endpoint wireModelId change", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "ep1";
		settings.orchestrator.model = "first-model";

		let synthesizedReasoning = true;
		let synthesizedContextWindow = 8192;
		const synthesisCalls: string[] = [];

		const endpoint: EndpointDescriptor = { id: "ep1", runtime: "lmstudio-native" };
		const runtime: RuntimeDescriptor = {
			id: "lmstudio-native",
			displayName: "LM Studio",
			kind: "http",
			apiFamily: "lmstudio-native",
			auth: "none",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, reasoning: true },
			synthesizeModel: (_ep, wireModelId) => {
				synthesisCalls.push(wireModelId);
				return {
					id: wireModelId,
					provider: "lmstudio",
					reasoning: synthesizedReasoning,
					contextWindow: synthesizedContextWindow,
				} as never;
			},
		};

		const providers = buildProvidersAndRuntimes({ endpoints: [endpoint], runtimes: [runtime] });

		let agentCreations = 0;
		let agentAborts = 0;
		const states: AgentStateLike[] = [];
		const loop = createChatLoop({
			getSettings: () => settings,
			modes: modesContract(),
			providers,
			knownEndpoints: () => new Set([endpoint.id]),
			createAgent: (options) => {
				agentCreations += 1;
				const state: AgentStateLike = {
					systemPrompt: "",
					model: (options?.initialState?.model ?? { id: "first-model", reasoning: true }) as AgentStateLike["model"],
					thinkingLevel: options?.initialState?.thinkingLevel ?? "off",
					tools: [],
					messages: [],
					isStreaming: false,
					pendingToolCalls: new Set<string>(),
					errorMessage: undefined,
				};
				states.push(state);
				return createStubAgent(state, () => {
					agentAborts += 1;
				});
			},
		});

		await loop.submit("hello");
		strictEqual(agentCreations, 1, "first submit constructs the agent");
		strictEqual(states[0]?.model.id, "first-model");

		// Hot-swap path: same endpoint, new model. No new agent is built; the
		// existing state.model is mutated in place.
		settings.orchestrator.model = "second-model";
		await loop.submit("again");
		strictEqual(agentCreations, 1, "model-only switch must reuse the existing agent");
		strictEqual(agentAborts, 0, "model-only switch must not abort the live stream");
		strictEqual(states[0]?.model.id, "second-model", "agent.state.model now points at the new model");
		strictEqual(states[0]?.thinkingLevel, "off", "default thinking level for non-explicit reasoning request");

		// Same endpoint+model: idempotent.
		await loop.submit("once more");
		strictEqual(agentCreations, 1);
		strictEqual(synthesisCalls.length, 2, "synthesizeModel runs once per distinct wireModelId switch");

		// Capability-aware clamp: the user requests reasoning, but the next
		// model lacks it. agent.state.thinkingLevel must drop to "off".
		settings.orchestrator.model = "no-think-model";
		settings.orchestrator.thinkingLevel = "high";
		synthesizedReasoning = false;
		synthesizedContextWindow = 4096;
		await loop.submit("no thinking please");
		strictEqual(agentCreations, 1, "still no rebuild");
		strictEqual(states[0]?.model.id, "no-think-model");
		strictEqual(states[0]?.model.reasoning, false);
		strictEqual(states[0]?.thinkingLevel, "off", "clamps when the new model lacks reasoning");

		// And a follow-up swap to a reasoning-capable model honors the request.
		settings.orchestrator.model = "another-think-model";
		synthesizedReasoning = true;
		synthesizedContextWindow = 8192;
		await loop.submit("with thinking");
		strictEqual(agentCreations, 1);
		strictEqual(states[0]?.thinkingLevel, "high");
	});

	it("rebuilds the agent when the endpoint or runtime changes", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "ep1";
		settings.orchestrator.model = "model-a";

		const endpointA: EndpointDescriptor = { id: "ep1", runtime: "rt-a" };
		const endpointB: EndpointDescriptor = { id: "ep2", runtime: "rt-b" };
		const runtimeA: RuntimeDescriptor = {
			id: "rt-a",
			displayName: "RT A",
			kind: "http",
			apiFamily: "openai-completions",
			auth: "none",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true },
			synthesizeModel: (_ep, wireModelId) => ({ id: wireModelId, provider: "rt-a", reasoning: false }) as never,
		};
		const runtimeB: RuntimeDescriptor = {
			id: "rt-b",
			displayName: "RT B",
			kind: "http",
			apiFamily: "anthropic-messages",
			auth: "none",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true },
			synthesizeModel: (_ep, wireModelId) => ({ id: wireModelId, provider: "rt-b", reasoning: false }) as never,
		};

		const providers = buildProvidersAndRuntimes({
			endpoints: [endpointA, endpointB],
			runtimes: [runtimeA, runtimeB],
		});

		let agentCreations = 0;
		let agentAborts = 0;
		const loop = createChatLoop({
			getSettings: () => settings,
			modes: modesContract(),
			providers,
			knownEndpoints: () => new Set([endpointA.id, endpointB.id]),
			createAgent: (options) => {
				agentCreations += 1;
				const state: AgentStateLike = {
					systemPrompt: "",
					model: (options?.initialState?.model ?? { id: "model-a", reasoning: false }) as AgentStateLike["model"],
					thinkingLevel: options?.initialState?.thinkingLevel ?? "off",
					tools: [],
					messages: [],
					isStreaming: false,
					pendingToolCalls: new Set<string>(),
					errorMessage: undefined,
				};
				return createStubAgent(state, () => {
					agentAborts += 1;
				});
			},
		});

		await loop.submit("hello");
		strictEqual(agentCreations, 1);

		settings.orchestrator.endpoint = "ep2";
		settings.orchestrator.model = "model-b";
		await loop.submit("hop");
		strictEqual(agentCreations, 2, "endpoint change requires a fresh agent");
		ok(agentAborts >= 1, "the prior agent's stream is aborted before discard");
	});
});
