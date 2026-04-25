import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { EngineAgentHandle } from "../../src/engine/agent.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";

describe("interactive/chat-loop auth resolution", () => {
	it("resolves OAuth-backed credentials through providers.auth", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "codex-pro";
		settings.orchestrator.model = "gpt-5.4";
		settings.orchestrator.thinkingLevel = "xhigh";

		const endpoint = {
			id: "codex-pro",
			runtime: "openai-codex",
			defaultModel: "gpt-5.4",
		};
		const runtime: RuntimeDescriptor = {
			id: "openai-codex",
			displayName: "OpenAI Codex",
			kind: "http",
			apiFamily: "openai-codex-responses",
			auth: "oauth",
			defaultCapabilities: {
				...EMPTY_CAPABILITIES,
				chat: true,
				tools: true,
				reasoning: true,
				thinkingFormat: "openai-codex",
			},
			synthesizeModel: () => ({ id: "gpt-5.4", provider: "openai-codex" }) as never,
		};

		let capturedKey: string | undefined;
		const providers: ProvidersContract = {
			list: () => [],
			getEndpoint: (id) => (id === endpoint.id ? endpoint : null),
			getRuntime: (id) => (id === runtime.id ? runtime : null),
			probeAll: async () => {},
			probeAllLive: async () => {},
			probeEndpoint: async () => null,
			disconnectEndpoint: () => null,
			auth: {
				statusForTarget: () => ({
					providerId: "openai-codex",
					available: true,
					credentialType: "oauth",
					source: "stored-oauth",
					detail: "openai-codex",
				}),
				resolveForTarget: async () => ({
					providerId: "openai-codex",
					available: true,
					credentialType: "oauth",
					source: "stored-oauth",
					detail: "openai-codex",
					apiKey: "oauth-access-token",
				}),
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
			credentials: {
				hasKey: () => false,
				get: () => null,
				set: () => {},
				remove: () => {},
			},
			getDetectedReasoning: () => null,
			probeReasoningForModel: async () => null,
			knowledgeBase: null,
		};

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
			createAgent: (options) => {
				const agentState = {
					systemPrompt: "",
					model: (options?.initialState?.model ?? { id: "gpt-5.4", provider: "openai-codex" }) as never,
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
						capturedKey = await options?.getApiKey?.("openai-codex");
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
		strictEqual(capturedKey, "oauth-access-token");
	});
});
