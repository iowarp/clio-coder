import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { CompileResult } from "../../src/domains/prompts/compiler.js";
import type { CompileForTurnInput, PromptsContract } from "../../src/domains/prompts/contract.js";
import type { ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { EngineAgentHandle } from "../../src/engine/agent.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";

function createProviders(): { settings: typeof DEFAULT_SETTINGS; providers: ProvidersContract } {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.orchestrator.endpoint = "stub-endpoint";
	settings.orchestrator.model = "stub-model";

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

	const providers: ProvidersContract = {
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
	return { settings, providers };
}

function createPromptsRecorder(): { prompts: PromptsContract; calls: CompileForTurnInput[] } {
	const calls: CompileForTurnInput[] = [];
	const prompts: PromptsContract = {
		compileForTurn(input) {
			calls.push(input);
			const result: CompileResult = {
				text: `system|memorySection=${input.dynamicInputs.memorySection ?? ""}`,
				staticCompositionHash: "static",
				renderedPromptHash: "rendered",
				fragmentManifest: [],
				dynamicInputs: { ...input.dynamicInputs },
			};
			return result;
		},
		reload() {},
	};
	return { prompts, calls };
}

function noopAgent(): EngineAgentHandle {
	const state = {
		systemPrompt: "",
		model: {} as never,
		thinkingLevel: "off" as const,
		tools: [],
		messages: [] as AgentMessage[],
		isStreaming: false,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
	let cb: ((event: AgentEvent) => void | Promise<void>) | null = null;
	const agent = {
		state,
		sessionId: undefined as string | undefined,
		subscribe: (handler: (event: AgentEvent) => void | Promise<void>) => {
			cb = handler;
			return () => {
				cb = null;
			};
		},
		prompt: async () => {
			const message: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
				timestamp: 0,
			} as AgentMessage;
			await cb?.({ type: "message_end", message });
			await cb?.({ type: "agent_end", messages: [message] });
		},
		abort: () => {},
	};
	return { agent: agent as unknown as EngineAgentHandle["agent"], state: () => state } as unknown as EngineAgentHandle;
}

describe("chat-loop memory injection", () => {
	it("threads the memory section into the prompt compiler when getMemorySection returns text", async () => {
		const { settings, providers } = createProviders();
		const { prompts, calls } = createPromptsRecorder();

		const memorySection = "# Memory\n\n- [mem-aaaaaaaaaaaaaaaa] (scope=repo) test lesson. Evidence: ev-1.";
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
			knownEndpoints: () => new Set(["stub-endpoint"]),
			prompts,
			getMemorySection: () => memorySection,
			createAgent: () => noopAgent(),
		});

		await loop.submit("hello");

		strictEqual(calls.length, 1);
		strictEqual(calls[0]?.dynamicInputs.memorySection, memorySection);
	});

	it("does not set memorySection when getMemorySection returns empty", async () => {
		const { settings, providers } = createProviders();
		const { prompts, calls } = createPromptsRecorder();

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
			knownEndpoints: () => new Set(["stub-endpoint"]),
			prompts,
			getMemorySection: () => "",
			createAgent: () => noopAgent(),
		});

		await loop.submit("hello");

		strictEqual(calls.length, 1);
		strictEqual(calls[0]?.dynamicInputs.memorySection, undefined);
	});

	it("survives getMemorySection throws by skipping the section and emitting a notice", async () => {
		const { settings, providers } = createProviders();
		const { prompts, calls } = createPromptsRecorder();

		const noticeTexts: string[] = [];
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
			knownEndpoints: () => new Set(["stub-endpoint"]),
			prompts,
			getMemorySection: () => {
				throw new Error("boom");
			},
			createAgent: () => noopAgent(),
		});

		const unsub = loop.onEvent((event) => {
			if (event.type === "message_end") {
				const message = event.message as { content?: ReadonlyArray<{ type?: string; text?: string }> };
				const content = message.content ?? [];
				for (const item of content) {
					if (item?.type === "text" && typeof item.text === "string") noticeTexts.push(item.text);
				}
			}
		});
		try {
			await loop.submit("hello");
		} finally {
			unsub();
		}

		strictEqual(calls.length, 1);
		strictEqual(calls[0]?.dynamicInputs.memorySection, undefined);
		ok(noticeTexts.some((text) => text.includes("memory load failed")));
	});
});
