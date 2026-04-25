import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import { MODE_MATRIX, type ModeName } from "../../src/domains/modes/matrix.js";
import type { ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import { classify as classifyAction } from "../../src/domains/safety/action-classifier.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import type { EngineAgentHandle } from "../../src/engine/agent.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { createRegistry } from "../../src/tools/registry.js";

function fakeSafety(): SafetyContract {
	return {
		classify: (call: Parameters<SafetyContract["classify"]>[0]) => classifyAction(call),
		evaluate: (call: Parameters<SafetyContract["evaluate"]>[0]) =>
			({ kind: "allow", classification: classifyAction(call) }) as never,
		observeLoop: (key: string) => ({ looping: false, key, count: 1 }) as never,
		scopes: { default: new Set(), readonly: new Set(), super: new Set() } as never,
		isSubset: () => true,
		audit: { recordCount: () => 0 },
	} as unknown as SafetyContract;
}

function liveModesAt(mode: ModeName): ModesContract {
	return {
		current: () => mode,
		setMode: () => mode,
		cycleNormal: () => mode,
		visibleTools: () => MODE_MATRIX[mode].tools,
		isToolVisible: (t) => MODE_MATRIX[mode].tools.has(t),
		isActionAllowed: (a) => MODE_MATRIX[mode].allowedActions.has(a),
		requestSuper: () => {},
		confirmSuper: () => mode,
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
		getDetectedReasoning: () => null,
		probeReasoningForModel: async () => null,
		knowledgeBase: null,
	};
}

const MATRIX_TOOLS_BY_MODE: Readonly<Record<ModeName, ReadonlyArray<string>>> = {
	default: ["bash", "edit", "glob", "grep", "ls", "read", "web_fetch", "write"],
	advise: ["glob", "grep", "ls", "read", "web_fetch", "write_plan", "write_review"],
	super: ["bash", "edit", "glob", "grep", "ls", "read", "web_fetch", "write"],
};

function liveMutableModes(initial: ModeName): ModesContract & { __set: (m: ModeName) => void } {
	let current: ModeName = initial;
	return {
		__set: (m) => {
			current = m;
		},
		current: () => current,
		setMode: (next) => {
			current = next;
			return current;
		},
		cycleNormal: () => current,
		visibleTools: () => MODE_MATRIX[current].tools,
		isToolVisible: (t) => MODE_MATRIX[current].tools.has(t),
		isActionAllowed: (a) => MODE_MATRIX[current].allowedActions.has(a),
		requestSuper: () => {},
		confirmSuper: () => current,
		elevatedModeFor: () => null,
	};
}

describe("interactive/chat-loop mode-aware tool resolution", () => {
	for (const mode of ["default", "advise", "super"] as const) {
		it(`exposes exactly the matrix tool set for mode=${mode}`, async () => {
			const settings = structuredClone(DEFAULT_SETTINGS);
			settings.orchestrator.endpoint = "stub-endpoint";
			settings.orchestrator.model = "stub-model";

			const modes = liveModesAt(mode);
			const toolRegistry = createRegistry({ safety: fakeSafety(), modes });
			registerAllTools(toolRegistry);

			let subscribeCb: ((event: AgentEvent) => void | Promise<void>) | null = null;
			const agentState: {
				systemPrompt: string;
				model: never;
				thinkingLevel: "off";
				tools: Array<{ name: string }>;
				messages: AgentMessage[];
				isStreaming: boolean;
				pendingToolCalls: Set<string>;
				errorMessage: string | undefined;
			} = {
				systemPrompt: "",
				model: {} as never,
				thinkingLevel: "off",
				tools: [],
				messages: [] as AgentMessage[],
				isStreaming: false,
				pendingToolCalls: new Set<string>(),
				errorMessage: undefined,
			};

			let toolsAtPrompt: ReadonlyArray<string> = [];
			const loop = createChatLoop({
				getSettings: () => settings,
				modes,
				providers: fakeProviders(),
				knownEndpoints: () => new Set(["stub-endpoint"]),
				toolRegistry,
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
						prompt: async () => {
							toolsAtPrompt = agentState.tools.map((t) => t.name);
							const reply: AgentMessage = {
								role: "assistant",
								content: [{ type: "text", text: "ok" }],
								stopReason: "stop",
								timestamp: 0,
							} as AgentMessage;
							await subscribeCb?.({ type: "message_end", message: reply });
							await subscribeCb?.({ type: "agent_end", messages: [reply] });
						},
						abort: () => {},
					};
					return {
						agent: agent as unknown as EngineAgentHandle["agent"],
						state: () => agent.state,
					} as unknown as EngineAgentHandle;
				},
			});

			await loop.submit("list tools");

			deepStrictEqual([...toolsAtPrompt].sort(), [...MATRIX_TOOLS_BY_MODE[mode]].sort());
			strictEqual(toolsAtPrompt.length, MATRIX_TOOLS_BY_MODE[mode].length);
		});
	}

	it("re-resolves tools after a mode toggle between agent construction and submit", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "stub-endpoint";
		settings.orchestrator.model = "stub-model";

		// Boot in default. Toggle to advise just before submitting. The runtime
		// is built lazily on first submit, so state.tools must reflect the
		// post-toggle mode rather than the boot-time mode.
		const modes = liveMutableModes("default");
		const toolRegistry = createRegistry({ safety: fakeSafety(), modes });
		registerAllTools(toolRegistry);

		let subscribeCb: ((event: AgentEvent) => void | Promise<void>) | null = null;
		const agentState: {
			systemPrompt: string;
			model: never;
			thinkingLevel: "off";
			tools: Array<{ name: string }>;
			messages: AgentMessage[];
			isStreaming: boolean;
			pendingToolCalls: Set<string>;
			errorMessage: string | undefined;
		} = {
			systemPrompt: "",
			model: {} as never,
			thinkingLevel: "off",
			tools: [],
			messages: [] as AgentMessage[],
			isStreaming: false,
			pendingToolCalls: new Set<string>(),
			errorMessage: undefined,
		};
		const promptToolSnapshots: Array<ReadonlyArray<string>> = [];

		const loop = createChatLoop({
			getSettings: () => settings,
			modes,
			providers: fakeProviders(),
			knownEndpoints: () => new Set(["stub-endpoint"]),
			toolRegistry,
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
					prompt: async () => {
						promptToolSnapshots.push(agentState.tools.map((t) => t.name));
						const reply: AgentMessage = {
							role: "assistant",
							content: [{ type: "text", text: "ok" }],
							stopReason: "stop",
							timestamp: 0,
						} as AgentMessage;
						await subscribeCb?.({ type: "message_end", message: reply });
						await subscribeCb?.({ type: "agent_end", messages: [reply] });
					},
					abort: () => {},
				};
				return {
					agent: agent as unknown as EngineAgentHandle["agent"],
					state: () => agent.state,
				} as unknown as EngineAgentHandle;
			},
		});

		// First submit: still default. State.tools must be the 8-tool set.
		await loop.submit("first turn");
		// Toggle.
		modes.__set("advise");
		// Second submit: must reflect advise's 7 tools.
		await loop.submit("second turn");

		strictEqual(promptToolSnapshots.length, 2);
		deepStrictEqual([...(promptToolSnapshots[0] ?? [])].sort(), [...MATRIX_TOOLS_BY_MODE.default].sort());
		deepStrictEqual([...(promptToolSnapshots[1] ?? [])].sort(), [...MATRIX_TOOLS_BY_MODE.advise].sort());
	});
});
