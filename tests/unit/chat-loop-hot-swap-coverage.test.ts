import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ToolName } from "../../src/core/tool-names.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import type { ObservabilityContract } from "../../src/domains/observability/contract.js";
import type { CostEntry, UsageBreakdown } from "../../src/domains/observability/cost.js";
import type { CompileForTurnInput, PromptsContract } from "../../src/domains/prompts/contract.js";
import type { ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { EndpointDescriptor } from "../../src/domains/providers/types/endpoint-descriptor.js";
import type { SessionContract, SessionEntryInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { EngineAgentHandle } from "../../src/engine/agent.js";
import type { ClioSessionMeta, ClioTurnRecord } from "../../src/engine/session.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
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

function modesContract(): ModesContract {
	return {
		current: () => "default" as const,
		setMode: () => "default" as const,
		cycleNormal: () => "default" as const,
		visibleTools: () => new Set<ToolName>(),
		isToolVisible: () => false,
		isActionAllowed: () => true,
		requestSuper: () => {},
		confirmSuper: () => "super" as const,
		elevatedModeFor: () => null,
	};
}

function buildProviders(endpoint: EndpointDescriptor, runtime: RuntimeDescriptor): ProvidersContract {
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
		knowledgeBase: null,
	};
}

function fakeMeta(id: string): ClioSessionMeta {
	return {
		id,
		cwd: "/tmp/clio-hot-swap-test",
		cwdHash: "h",
		createdAt: "2026-04-25T00:00:00.000Z",
		endedAt: null,
		model: null,
		endpoint: null,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.1.2-test",
		piMonoVersion: "0.0.0",
		platform: "linux",
		nodeVersion: "v20.0.0",
	};
}

function sessionHarness(): {
	session: SessionContract;
	turns: ClioTurnRecord[];
	entries: SessionEntry[];
} {
	let currentMeta: ClioSessionMeta | null = null;
	const turns: ClioTurnRecord[] = [];
	const entries: SessionEntry[] = [];
	const session: SessionContract = {
		current: () => currentMeta,
		create: () => {
			currentMeta = fakeMeta("session-hot-swap");
			return currentMeta;
		},
		append: (input) => {
			const rec: ClioTurnRecord = {
				id: `turn-${turns.length}`,
				parentId: input.parentId ?? null,
				at: "2026-04-25T00:00:00.000Z",
				kind: input.kind,
				payload: input.payload,
			};
			if (input.renderedPromptHash !== undefined) rec.renderedPromptHash = input.renderedPromptHash;
			turns.push(rec);
			return rec;
		},
		appendEntry: (input: SessionEntryInput) => {
			const entry = {
				...input,
				turnId: input.turnId ?? `entry-${entries.length}`,
				timestamp: input.timestamp ?? "2026-04-25T00:00:00.000Z",
			} as SessionEntry;
			entries.push(entry);
			return entry;
		},
		async checkpoint() {},
		resume: () => fakeMeta("session-hot-swap"),
		fork: () => fakeMeta("session-hot-swap-fork"),
		tree: () => {
			throw new Error("unused");
		},
		switchBranch: () => fakeMeta("session-hot-swap"),
		editLabel: () => {},
		deleteSession: () => {},
		history: () => [],
		async close() {},
	};
	return { session, turns, entries };
}

interface AgentRecorder {
	state: AgentStateLike;
	subscribers: Array<(event: AgentEvent) => void | Promise<void>>;
}

function createRecorder(
	initialModelId: string,
	reasoning: boolean,
): {
	handle: EngineAgentHandle;
	recorder: AgentRecorder;
} {
	const recorder: AgentRecorder = {
		state: {
			systemPrompt: "",
			model: { id: initialModelId, reasoning },
			thinkingLevel: "off",
			tools: [],
			messages: [],
			isStreaming: false,
			pendingToolCalls: new Set<string>(),
			errorMessage: undefined,
		},
		subscribers: [],
	};
	const agent = {
		state: recorder.state,
		sessionId: undefined as string | undefined,
		subscribe: (cb: (event: AgentEvent) => void | Promise<void>) => {
			recorder.subscribers.push(cb);
			return () => {};
		},
		prompt: async () => {},
		abort: () => {},
	};
	const handle = {
		agent: agent as unknown as EngineAgentHandle["agent"],
		state: () => recorder.state,
	} as unknown as EngineAgentHandle;
	return { handle, recorder };
}

function makeObservability(): { obs: ObservabilityContract; calls: CostEntry[] } {
	const calls: CostEntry[] = [];
	const obs: ObservabilityContract = {
		telemetry: () => ({}) as never,
		metrics: () => ({}) as never,
		sessionCost: () => 0,
		sessionTokens: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }) as UsageBreakdown,
		costEntries: () => calls,
		recordTokens: (providerId, modelId, tokens, costUsd, breakdown) => {
			calls.push({
				providerId,
				modelId,
				tokens,
				usd: costUsd ?? 0,
				input: breakdown?.input ?? 0,
				output: breakdown?.output ?? 0,
				cacheRead: breakdown?.cacheRead ?? 0,
				cacheWrite: breakdown?.cacheWrite ?? 0,
			});
		},
	};
	return { obs, calls };
}

function fakeAgentEnd(modelId: string): AgentEvent {
	return {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
				timestamp: 0,
				usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { total: 0.0042 } },
				model: modelId,
			} as AgentMessage,
		],
	} as AgentEvent;
}

describe("interactive/chat-loop hot-swap coverage", () => {
	it("records observability tokens under the swapped model id, not the build-time model id", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "ep1";
		settings.orchestrator.model = "model-a";

		const endpoint: EndpointDescriptor = { id: "ep1", runtime: "rt-stub" };
		const runtime: RuntimeDescriptor = {
			id: "rt-stub",
			displayName: "RT",
			kind: "http",
			apiFamily: "openai-completions",
			auth: "none",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, reasoning: true },
			synthesizeModel: (_ep, wireModelId) => ({ id: wireModelId, provider: "rt-stub", reasoning: true }) as never,
		};
		const providers = buildProviders(endpoint, runtime);
		const { obs, calls } = makeObservability();

		const recorders: AgentRecorder[] = [];
		const loop = createChatLoop({
			getSettings: () => settings,
			modes: modesContract(),
			providers,
			knownEndpoints: () => new Set([endpoint.id]),
			observability: obs,
			createAgent: () => {
				const { handle, recorder } = createRecorder("model-a", true);
				recorders.push(recorder);
				return handle;
			},
		});

		await loop.submit("first");
		strictEqual(recorders.length, 1, "agent built on first submit");
		const recorder = recorders[0];
		ok(recorder, "recorder captured");
		strictEqual(recorder.subscribers.length, 1, "subscribe ran exactly once");
		const fire = recorder.subscribers[0];
		ok(fire, "subscriber fn captured");

		// Hot-swap before any usage event has fired.
		settings.orchestrator.model = "model-b";
		await loop.submit("second");
		strictEqual(recorders.length, 1, "no rebuild on same-endpoint model swap");
		strictEqual(recorder.state.model.id, "model-b", "agent.state.model points at model-b");

		// Drive an agent_end event with non-zero usage. The fix means recordTokens
		// reads from the runtime object the chat-loop mutates, so the row carries
		// the swapped model id even though the closure was registered when model-a
		// was active.
		await fire(fakeAgentEnd("model-b"));
		strictEqual(calls.length, 1);
		strictEqual(calls[0]?.providerId, "ep1");
		strictEqual(calls[0]?.modelId, "model-b", "must record under the swapped model id, not the build-time id");
		strictEqual(calls[0]?.tokens, 150);
	});

	it("compiles the prompt with the clamped thinking level after a hot-swap to a non-reasoning model", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "ep1";
		settings.orchestrator.model = "reasoning-model";
		settings.orchestrator.thinkingLevel = "high";

		const endpoint: EndpointDescriptor = { id: "ep1", runtime: "rt-stub" };
		let nextReasoning = true;
		const runtime: RuntimeDescriptor = {
			id: "rt-stub",
			displayName: "RT",
			kind: "http",
			apiFamily: "openai-completions",
			auth: "none",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, reasoning: true },
			synthesizeModel: (_ep, wireModelId) =>
				({ id: wireModelId, provider: "rt-stub", reasoning: nextReasoning, contextWindow: 4096 }) as never,
		};
		const providers = buildProviders(endpoint, runtime);

		const compileCalls: CompileForTurnInput[] = [];
		const promptsStub: PromptsContract = {
			compileForTurn: (input) => {
				compileCalls.push(input);
				return {
					text: "compiled",
					staticCompositionHash: "static",
					renderedPromptHash: "rendered",
					fragmentManifest: [],
					dynamicInputs: input.dynamicInputs,
				};
			},
			reload: () => {},
		};

		const recorders: AgentRecorder[] = [];
		const loop = createChatLoop({
			getSettings: () => settings,
			modes: modesContract(),
			providers,
			knownEndpoints: () => new Set([endpoint.id]),
			prompts: promptsStub,
			createAgent: () => {
				const { handle, recorder } = createRecorder("reasoning-model", true);
				// Mirror the pi-agent-core init: thinkingLevel passed in initialState
				// flows onto state. Force a value that matches what
				// clampThinkingLevelForModel(reasoningModel, "high") would yield.
				recorder.state.thinkingLevel = "high";
				recorder.state.model = { id: "reasoning-model", reasoning: true, contextWindow: 4096 };
				recorders.push(recorder);
				return handle;
			},
		});

		await loop.submit("first");
		strictEqual(compileCalls.length, 1);
		strictEqual(compileCalls[0]?.dynamicInputs.thinkingBudget, "high", "first turn uses high");
		strictEqual(compileCalls[0]?.dynamicInputs.contextWindow, 4096);

		// Hot-swap to a model that does not support reasoning. The clamp must
		// drive agent.state.thinkingLevel to "off"; the compiler must see "off",
		// not the still-stored "high" in settings.
		settings.orchestrator.model = "no-think-model";
		nextReasoning = false;
		await loop.submit("second");
		strictEqual(recorders.length, 1, "no rebuild on same-endpoint swap");
		const recorder = recorders[0];
		ok(recorder);
		strictEqual(recorder.state.thinkingLevel, "off", "runtime clamps to off");
		strictEqual(compileCalls.length, 2);
		strictEqual(
			compileCalls[1]?.dynamicInputs.thinkingBudget,
			"off",
			"prompt advertises off, matching what the runtime actually sends",
		);
		strictEqual(compileCalls[1]?.dynamicInputs.model, "no-think-model");
	});

	it("appends a modelChange session entry on hot-swap mid-session", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "ep1";
		settings.orchestrator.model = "model-a";

		const endpoint: EndpointDescriptor = { id: "ep1", runtime: "rt-stub" };
		const runtime: RuntimeDescriptor = {
			id: "rt-stub",
			displayName: "RT",
			kind: "http",
			apiFamily: "openai-completions",
			auth: "none",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true },
			synthesizeModel: (_ep, wireModelId) => ({ id: wireModelId, provider: "rt-stub" }) as never,
		};
		const providers = buildProviders(endpoint, runtime);
		const { session, entries } = sessionHarness();

		const loop = createChatLoop({
			getSettings: () => settings,
			modes: modesContract(),
			providers,
			knownEndpoints: () => new Set([endpoint.id]),
			session,
			createAgent: () => {
				const { handle } = createRecorder("model-a", false);
				return handle;
			},
		});

		// Initial build does not append a modelChange entry — the session header
		// (meta.model, written by session.create()) already names the first
		// model, so the marker would be redundant.
		await loop.submit("first");
		strictEqual(entries.filter((e) => e.kind === "modelChange").length, 0);

		// Hot-swap to model-b mid-session must append a marker so /resume and
		// /fork can find the actual last-used model.
		settings.orchestrator.model = "model-b";
		await loop.submit("second");
		const changes = entries.filter((e) => e.kind === "modelChange");
		strictEqual(changes.length, 1, "hot-swap appends a modelChange marker");
		const marker = changes[0];
		ok(marker && marker.kind === "modelChange");
		strictEqual(marker.modelId, "model-b");
		strictEqual(marker.endpoint, "ep1");
		strictEqual(marker.provider, "rt-stub");

		// Submitting again with no swap must not add a duplicate marker.
		await loop.submit("third");
		strictEqual(entries.filter((e) => e.kind === "modelChange").length, 1);
	});

	it("propagates a settings.thinkingLevel change to agent.state without rebuilding", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "ep1";
		settings.orchestrator.model = "reasoning-model";
		settings.orchestrator.thinkingLevel = "off";

		const endpoint: EndpointDescriptor = { id: "ep1", runtime: "rt-stub" };
		const runtime: RuntimeDescriptor = {
			id: "rt-stub",
			displayName: "RT",
			kind: "http",
			apiFamily: "openai-completions",
			auth: "none",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, reasoning: true },
			synthesizeModel: (_ep, wireModelId) => ({ id: wireModelId, provider: "rt-stub", reasoning: true }) as never,
		};
		const providers = buildProviders(endpoint, runtime);

		let creations = 0;
		const recorders: AgentRecorder[] = [];
		const loop = createChatLoop({
			getSettings: () => settings,
			modes: modesContract(),
			providers,
			knownEndpoints: () => new Set([endpoint.id]),
			createAgent: () => {
				creations += 1;
				const { handle, recorder } = createRecorder("reasoning-model", true);
				recorders.push(recorder);
				return handle;
			},
		});

		await loop.submit("first");
		strictEqual(creations, 1);
		strictEqual(recorders[0]?.state.thinkingLevel, "off");

		// User invokes /thinking → settings change, but endpoint+runtime+model
		// are unchanged, so ensureRuntime takes the early-return branch. The
		// reconcile clause must still propagate the new clamped value.
		settings.orchestrator.thinkingLevel = "medium";
		await loop.submit("second");
		strictEqual(creations, 1, "thinking-level change must not rebuild the agent");
		strictEqual(
			recorders[0]?.state.thinkingLevel,
			"medium",
			"agent.state.thinkingLevel reflects the settings change without a rebuild",
		);
	});

	it("appends a modelChange entry on cross-target rebuild and records cost against each target", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "ep-a";
		settings.orchestrator.model = "model-a";

		const endpointA: EndpointDescriptor = { id: "ep-a", runtime: "rt-a" };
		const endpointB: EndpointDescriptor = { id: "ep-b", runtime: "rt-b" };
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
		const providers: ProvidersContract = {
			...buildProviders(endpointA, runtimeA),
			getEndpoint: (id) => (id === "ep-a" ? endpointA : id === "ep-b" ? endpointB : null),
			getRuntime: (id) => (id === "rt-a" ? runtimeA : id === "rt-b" ? runtimeB : null),
		};

		const { session, entries } = sessionHarness();
		const { obs, calls } = makeObservability();

		let creations = 0;
		let aborts = 0;
		const recorders: AgentRecorder[] = [];
		const loop = createChatLoop({
			getSettings: () => settings,
			modes: modesContract(),
			providers,
			knownEndpoints: () => new Set(["ep-a", "ep-b"]),
			session,
			observability: obs,
			createAgent: (_options) => {
				creations += 1;
				const initialModel = settings.orchestrator.model ?? "unknown-model";
				const { handle, recorder } = createRecorder(initialModel, false);
				const original = handle.agent.abort.bind(handle.agent);
				handle.agent.abort = () => {
					aborts += 1;
					original();
				};
				recorders.push(recorder);
				return handle;
			},
		});

		await loop.submit("first");
		strictEqual(creations, 1);
		strictEqual(entries.filter((e) => e.kind === "modelChange").length, 0, "initial build does not append");

		// Cross-target swap: different endpoint and runtime. The rebuild
		// branch should abort the old agent, build a new one, and append a
		// modelChange marker so /resume can find the right model.
		settings.orchestrator.endpoint = "ep-b";
		settings.orchestrator.model = "model-b";
		await loop.submit("second");
		strictEqual(creations, 2, "cross-target swap rebuilds the agent");
		ok(aborts >= 1, "the prior agent was aborted before discard");

		const changes = entries.filter((e) => e.kind === "modelChange");
		strictEqual(changes.length, 1, "cross-target rebuild appends a modelChange marker");
		const marker = changes[0];
		ok(marker && marker.kind === "modelChange");
		strictEqual(marker.endpoint, "ep-b");
		strictEqual(marker.provider, "rt-b");
		strictEqual(marker.modelId, "model-b");

		// Drive each agent's subscribe callback and confirm the cost row is
		// attributed to its own target. The original agent's tail event must
		// land under ep-a/model-a; the new agent's events land under
		// ep-b/model-b.
		const oldFire = recorders[0]?.subscribers[0];
		const newFire = recorders[1]?.subscribers[0];
		ok(oldFire && newFire);
		await oldFire(fakeAgentEnd("model-a"));
		await newFire(fakeAgentEnd("model-b"));
		strictEqual(calls.length, 2);
		strictEqual(calls[0]?.providerId, "ep-a");
		strictEqual(calls[0]?.modelId, "model-a");
		strictEqual(calls[1]?.providerId, "ep-b");
		strictEqual(calls[1]?.modelId, "model-b");

		// Switching back to ep-a/model-a is also a cross-target rebuild and
		// should append another marker so the trail captures the full path.
		settings.orchestrator.endpoint = "ep-a";
		settings.orchestrator.model = "model-a";
		await loop.submit("third");
		strictEqual(creations, 3);
		const allChanges = entries.filter((e) => e.kind === "modelChange");
		strictEqual(allChanges.length, 2);
		const second = allChanges[1];
		ok(second && second.kind === "modelChange");
		strictEqual(second.endpoint, "ep-a");
		strictEqual(second.modelId, "model-a");
	});
});
