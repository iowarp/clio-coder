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
		async compileForTurn(input) {
			calls.push(input);
			const result: CompileResult = {
				text: `system|memorySection=${input.dynamicInputs.memorySection ?? ""}`,
				systemPrompt: "stable-system",
				dynamicPromptFragments: input.dynamicInputs.memorySection
					? [
							{
								id: "memory",
								body: input.dynamicInputs.memorySection,
								contentHash: "memory-hash",
								tokenEstimate: 1,
							},
						]
					: [],
				renderedPromptHash: "rendered",
				fragmentManifest: [],
				segmentManifest: [],
				staticShellHash: "static",
				sessionShellHash: "session",
				dynamicHash: input.dynamicInputs.memorySection ? "dynamic-memory" : "dynamic-empty",
				staticShellTokenEstimate: 1,
				dynamicInputs: { ...input.dynamicInputs },
			};
			return result;
		},
		reload() {},
	};
	return { prompts, calls };
}

function noopAgent(captured?: { prompts: unknown[]; systemPrompts?: string[] }): EngineAgentHandle {
	let systemPrompt = "";
	const state = {
		get systemPrompt() {
			return systemPrompt;
		},
		set systemPrompt(value: string) {
			systemPrompt = value;
			captured?.systemPrompts?.push(value);
		},
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
		prompt: async (input?: unknown) => {
			captured?.prompts.push(input);
			if (Array.isArray(input)) {
				for (const message of input) {
					await cb?.({ type: "message_end", message: message as AgentMessage });
				}
			} else if (typeof input === "string") {
				await cb?.({
					type: "message_end",
					message: { role: "user", content: [{ type: "text", text: input }], timestamp: 0 } as AgentMessage,
				});
			}
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

	it("sends dynamic prompt fragments before the user turn without surfacing them as chat messages", async () => {
		const { settings, providers } = createProviders();
		const { prompts } = createPromptsRecorder();
		const captured = { prompts: [] as unknown[] };
		const messageTexts: string[] = [];
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
			getMemorySection: () => "# Memory\n\n- hidden dynamic memory",
			createAgent: () => noopAgent(captured),
		});
		const unsub = loop.onEvent((event) => {
			if (event.type !== "message_end") return;
			const content = (event.message as { content?: ReadonlyArray<{ type?: string; text?: string }> }).content ?? [];
			for (const item of content) {
				if (item?.type === "text" && typeof item.text === "string") messageTexts.push(item.text);
			}
		});
		try {
			await loop.submit("hello");
		} finally {
			unsub();
		}

		const prompt = captured.prompts[0];
		ok(Array.isArray(prompt));
		strictEqual(prompt.length, 2);
		ok(JSON.stringify(prompt[0]).includes("hidden dynamic memory"));
		ok(JSON.stringify(prompt[1]).includes("hello"));
		strictEqual(
			messageTexts.some((text) => text.includes("hidden dynamic memory")),
			false,
		);
		ok(messageTexts.includes("hello"));
		ok(messageTexts.includes("ok"));
	});

	it("does not rewrite the stable system prompt when only dynamic memory changes", async () => {
		const { settings, providers } = createProviders();
		const { prompts } = createPromptsRecorder();
		const captured = { prompts: [] as unknown[], systemPrompts: [] as string[] };
		let memorySection = "# Memory\n\n- first";
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
			createAgent: () => noopAgent(captured),
		});

		await loop.submit("first");
		memorySection = "# Memory\n\n- second";
		await loop.submit("second");

		strictEqual(captured.systemPrompts.length, 1);
		strictEqual(captured.systemPrompts[0], "stable-system");
		ok(JSON.stringify(captured.prompts[1]).includes("second"));
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
