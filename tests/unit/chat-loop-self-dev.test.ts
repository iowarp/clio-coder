import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { sha256 } from "../../src/domains/prompts/hash.js";
import {
	EMPTY_CAPABILITIES,
	type ProvidersContract,
	type RuntimeDescriptor,
} from "../../src/domains/providers/index.js";
import type { EngineAgentHandle } from "../../src/engine/agent.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";

describe("interactive/chat-loop self-dev prompt", () => {
	it("appends the self-dev supplement to compiled prompts", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "stub";
		settings.orchestrator.model = "stub-model";

		const endpoint = { id: "stub", runtime: "stub-runtime", defaultModel: "stub-model" };
		const runtime: RuntimeDescriptor = {
			id: "stub-runtime",
			displayName: "Stub",
			kind: "http",
			apiFamily: "openai-responses",
			auth: "none",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true },
			synthesizeModel: () => ({ id: "stub-model", provider: "stub-runtime" }) as never,
		};
		const providers: ProvidersContract = {
			list: () => [],
			getEndpoint: (id) => (id === endpoint.id ? endpoint : null),
			getRuntime: (id) => (id === runtime.id ? runtime : null),
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

		let capturedPrompt = "";
		const loop = createChatLoop({
			getSettings: () => settings,
			modes: {
				current: () => "default",
				setMode: () => "default",
				cycleNormal: () => "default",
				visibleTools: () => new Set(),
				isToolVisible: () => false,
				isActionAllowed: () => true,
				requestSuper: () => {},
				confirmSuper: () => "super",
				elevatedModeFor: () => null,
			},
			providers,
			knownEndpoints: () => new Set([endpoint.id]),
			prompts: {
				compileForTurn: () => ({
					text: "base prompt",
					staticCompositionHash: sha256("static"),
					renderedPromptHash: sha256("base prompt"),
					fragmentManifest: [],
					dynamicInputs: {},
				}),
				reload: () => {},
			},
			selfDevPrompt: "self-dev supplement",
			createAgent: (options) => {
				const agentState = {
					systemPrompt: options?.initialState?.systemPrompt ?? "",
					model: (options?.initialState?.model ?? { id: "stub-model", provider: "stub-runtime" }) as never,
					thinkingLevel: options?.initialState?.thinkingLevel ?? "off",
					tools: [],
					messages: [],
					isStreaming: false,
					pendingToolCalls: new Set<string>(),
					errorMessage: undefined,
				};
				const agent = {
					state: agentState,
					sessionId: undefined,
					subscribe: () => () => {},
					prompt: async () => {
						capturedPrompt = agentState.systemPrompt;
					},
					abort: () => {},
				};
				return {
					agent: agent as unknown as EngineAgentHandle["agent"],
					state: () => agent.state,
				} as unknown as EngineAgentHandle;
			},
		});

		await loop.submit("hello");
		ok(capturedPrompt.includes("base prompt"));
		ok(capturedPrompt.includes("self-dev supplement"));
	});
});
