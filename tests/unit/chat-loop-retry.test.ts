import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ToolName } from "../../src/core/tool-names.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import type { ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { SessionContract, SessionEntryInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { EngineAgentHandle } from "../../src/engine/agent.js";
import type { ClioSessionMeta, ClioTurnRecord } from "../../src/engine/session.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";

function fakeMeta(id: string): ClioSessionMeta {
	return {
		id,
		cwd: "/tmp/clio-retry-test",
		cwdHash: "h",
		createdAt: "2026-04-24T00:00:00.000Z",
		endedAt: null,
		model: null,
		endpoint: null,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.1.1-test",
		piMonoVersion: "0.0.0",
		platform: "linux",
		nodeVersion: "v20.0.0",
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: 0,
	} as AgentMessage;
}

function errorMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		stopReason: "error",
		errorMessage: text,
		timestamp: 0,
	} as AgentMessage;
}

function abortedMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		stopReason: "aborted",
		errorMessage: text,
		timestamp: 0,
	} as AgentMessage;
}

function providers(settings: typeof DEFAULT_SETTINGS): ProvidersContract {
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
	settings.orchestrator.endpoint = endpoint.id;
	settings.orchestrator.model = "stub-model";
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

function modes(): ModesContract {
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

function sessionHarness(): { session: SessionContract; turns: ClioTurnRecord[]; entries: SessionEntry[] } {
	let currentMeta: ClioSessionMeta | null = fakeMeta("session-1");
	const turns: ClioTurnRecord[] = [];
	const entries: SessionEntry[] = [];
	const session: SessionContract = {
		current: () => currentMeta,
		create: () => {
			currentMeta = fakeMeta("session-1");
			return currentMeta;
		},
		append: (input) => {
			const rec: ClioTurnRecord = {
				id: `turn-${turns.length}`,
				parentId: input.parentId ?? null,
				at: "2026-04-24T00:00:00.000Z",
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
				timestamp: input.timestamp ?? "2026-04-24T00:00:00.000Z",
			} as SessionEntry;
			entries.push(entry);
			return entry;
		},
		async checkpoint() {},
		resume: () => fakeMeta("session-1"),
		fork: () => fakeMeta("session-2"),
		tree: () => {
			throw new Error("unused");
		},
		switchBranch: () => fakeMeta("session-1"),
		editLabel: () => {},
		deleteSession: () => {},
		history: () => [],
		async close() {},
	};
	return { session, turns, entries };
}

function retryPhases(entries: SessionEntry[]): string[] {
	return entries
		.filter((entry) => entry.kind === "custom" && entry.customType === "retryStatus")
		.map((entry) => (entry as { data?: { phase?: string } }).data?.phase ?? "missing");
}

describe("interactive/chat-loop transient retry", () => {
	it("continues after a retryable provider error without prompting the user turn twice", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.retry.baseDelayMs = 0;
		settings.retry.maxRetries = 2;
		const { session, turns, entries } = sessionHarness();
		const agentState = {
			systemPrompt: "",
			model: {} as never,
			thinkingLevel: "off" as const,
			tools: [],
			messages: [] as AgentMessage[],
			isStreaming: false,
			pendingToolCalls: new Set<string>(),
			errorMessage: undefined,
		};
		let promptCalls = 0;
		let continueCalls = 0;
		let subscribeCb: ((event: AgentEvent) => void | Promise<void>) | null = null;
		const loop = createChatLoop({
			getSettings: () => settings,
			modes: modes(),
			providers: providers(settings),
			knownEndpoints: () => new Set(["stub-endpoint"]),
			session,
			createAgent: () =>
				({
					agent: {
						state: agentState,
						sessionId: undefined,
						subscribe: (cb: (event: AgentEvent) => void | Promise<void>) => {
							subscribeCb = cb;
							return () => {};
						},
						prompt: async (text: string) => {
							promptCalls += 1;
							agentState.messages.push(userMessage(text));
							const failed = errorMessage("rate limit 429");
							agentState.messages.push(failed);
							await subscribeCb?.({ type: "agent_end", messages: [failed] });
						},
						continue: async () => {
							continueCalls += 1;
							strictEqual(agentState.messages.at(-1)?.role, "user", "failed assistant must be pruned before retry");
							const okMessage = assistantMessage("retry recovered");
							agentState.messages.push(okMessage);
							await subscribeCb?.({ type: "message_end", message: okMessage });
							await subscribeCb?.({ type: "agent_end", messages: [okMessage] });
						},
						abort: () => {},
					},
					state: () => agentState,
				}) as unknown as EngineAgentHandle,
		});

		await loop.submit("hello");

		strictEqual(promptCalls, 1);
		strictEqual(continueCalls, 1);
		strictEqual(turns.filter((turn) => turn.kind === "user").length, 1);
		ok(JSON.stringify(turns).includes("rate limit 429"), "failed attempt should be durable");
		ok(JSON.stringify(turns).includes("retry recovered"), "successful retry should be durable");
		ok(retryPhases(entries).includes("scheduled"), "retry boundary should be durable");
		ok(retryPhases(entries).includes("recovered"), "retry recovery should be durable");
	});

	it("records retry exhaustion after the configured attempts", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.retry.baseDelayMs = 0;
		settings.retry.maxRetries = 2;
		const { session, turns, entries } = sessionHarness();
		const agentState = {
			systemPrompt: "",
			model: {} as never,
			thinkingLevel: "off" as const,
			tools: [],
			messages: [] as AgentMessage[],
			isStreaming: false,
			pendingToolCalls: new Set<string>(),
			errorMessage: undefined,
		};
		let continueCalls = 0;
		let subscribeCb: ((event: AgentEvent) => void | Promise<void>) | null = null;
		const loop = createChatLoop({
			getSettings: () => settings,
			modes: modes(),
			providers: providers(settings),
			knownEndpoints: () => new Set(["stub-endpoint"]),
			session,
			createAgent: () =>
				({
					agent: {
						state: agentState,
						sessionId: undefined,
						subscribe: (cb: (event: AgentEvent) => void | Promise<void>) => {
							subscribeCb = cb;
							return () => {};
						},
						prompt: async (text: string) => {
							agentState.messages.push(userMessage(text));
							const failed = errorMessage("service unavailable 503");
							agentState.messages.push(failed);
							await subscribeCb?.({ type: "agent_end", messages: [failed] });
						},
						continue: async () => {
							continueCalls += 1;
							const failed = errorMessage(`service unavailable 503 attempt ${continueCalls}`);
							agentState.messages.push(failed);
							await subscribeCb?.({ type: "agent_end", messages: [failed] });
						},
						abort: () => {},
					},
					state: () => agentState,
				}) as unknown as EngineAgentHandle,
		});

		await loop.submit("hello");

		strictEqual(continueCalls, 2);
		strictEqual(turns.filter((turn) => turn.kind === "user").length, 1);
		strictEqual(agentState.messages.at(-1)?.role, "user");
		ok(retryPhases(entries).includes("exhausted"), "retry exhaustion should be durable");
	});

	it("prunes the failed assistant when abort lands before continue completes", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.retry.baseDelayMs = 0;
		settings.retry.maxRetries = 2;
		const { session } = sessionHarness();
		const agentState = {
			systemPrompt: "",
			model: {} as never,
			thinkingLevel: "off" as const,
			tools: [],
			messages: [] as AgentMessage[],
			isStreaming: false,
			pendingToolCalls: new Set<string>(),
			errorMessage: undefined,
		};
		let continueCalls = 0;
		let abortCalls = 0;
		let subscribeCb: ((event: AgentEvent) => void | Promise<void>) | null = null;
		let loop: ReturnType<typeof createChatLoop>;
		loop = createChatLoop({
			getSettings: () => settings,
			modes: modes(),
			providers: providers(settings),
			knownEndpoints: () => new Set(["stub-endpoint"]),
			session,
			createAgent: () =>
				({
					agent: {
						state: agentState,
						sessionId: undefined,
						subscribe: (cb: (event: AgentEvent) => void | Promise<void>) => {
							subscribeCb = cb;
							return () => {};
						},
						prompt: async (text: string) => {
							agentState.messages.push(userMessage(text));
							const failed = errorMessage("rate limit 429");
							agentState.messages.push(failed);
							await subscribeCb?.({ type: "agent_end", messages: [failed] });
						},
						continue: async () => {
							continueCalls += 1;
							const failed = abortedMessage("request aborted");
							agentState.messages.push(failed);
							loop.cancel();
							await subscribeCb?.({ type: "agent_end", messages: [failed] });
						},
						abort: () => {
							abortCalls += 1;
						},
					},
					state: () => agentState,
				}) as unknown as EngineAgentHandle,
		});

		await loop.submit("hello");

		strictEqual(continueCalls, 1);
		strictEqual(abortCalls, 1);
		strictEqual(agentState.messages.at(-1)?.role, "user");
	});

	it("persists a thrown retryable error before continuing", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.retry.baseDelayMs = 0;
		settings.retry.maxRetries = 1;
		const { session, turns } = sessionHarness();
		const agentState = {
			systemPrompt: "",
			model: {} as never,
			thinkingLevel: "off" as const,
			tools: [],
			messages: [] as AgentMessage[],
			isStreaming: false,
			pendingToolCalls: new Set<string>(),
			errorMessage: undefined,
		};
		let continueCalls = 0;
		let subscribeCb: ((event: AgentEvent) => void | Promise<void>) | null = null;
		const loop = createChatLoop({
			getSettings: () => settings,
			modes: modes(),
			providers: providers(settings),
			knownEndpoints: () => new Set(["stub-endpoint"]),
			session,
			createAgent: () =>
				({
					agent: {
						state: agentState,
						sessionId: undefined,
						subscribe: (cb: (event: AgentEvent) => void | Promise<void>) => {
							subscribeCb = cb;
							return () => {};
						},
						prompt: async (text: string) => {
							agentState.messages.push(userMessage(text));
							throw new Error("rate limit 429");
						},
						continue: async () => {
							continueCalls += 1;
							strictEqual(agentState.messages.at(-1)?.role, "user");
							const okMessage = assistantMessage("retry recovered");
							agentState.messages.push(okMessage);
							await subscribeCb?.({ type: "message_end", message: okMessage });
							await subscribeCb?.({ type: "agent_end", messages: [okMessage] });
						},
						abort: () => {},
					},
					state: () => agentState,
				}) as unknown as EngineAgentHandle,
		});

		await loop.submit("hello");

		const durableFailures = turns.filter(
			(turn) => turn.kind === "assistant" && (turn.payload as { stopReason?: string }).stopReason === "error",
		);
		strictEqual(continueCalls, 1);
		strictEqual(durableFailures.length, 1);
		strictEqual((durableFailures[0]?.payload as { errorMessage?: string } | undefined)?.errorMessage, "rate limit 429");
	});

	it("cancels a pending retry countdown before continuing", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.retry.baseDelayMs = 60_000;
		settings.retry.maxRetries = 1;
		const { session, entries } = sessionHarness();
		const agentState = {
			systemPrompt: "",
			model: {} as never,
			thinkingLevel: "off" as const,
			tools: [],
			messages: [] as AgentMessage[],
			isStreaming: false,
			pendingToolCalls: new Set<string>(),
			errorMessage: undefined,
		};
		let continueCalls = 0;
		let subscribeCb: ((event: AgentEvent) => void | Promise<void>) | null = null;
		const loop = createChatLoop({
			getSettings: () => settings,
			modes: modes(),
			providers: providers(settings),
			knownEndpoints: () => new Set(["stub-endpoint"]),
			session,
			createAgent: () =>
				({
					agent: {
						state: agentState,
						sessionId: undefined,
						subscribe: (cb: (event: AgentEvent) => void | Promise<void>) => {
							subscribeCb = cb;
							return () => {};
						},
						prompt: async (text: string) => {
							agentState.messages.push(userMessage(text));
							const failed = errorMessage("network timeout");
							agentState.messages.push(failed);
							await subscribeCb?.({ type: "agent_end", messages: [failed] });
						},
						continue: async () => {
							continueCalls += 1;
						},
						abort: () => {},
					},
					state: () => agentState,
				}) as unknown as EngineAgentHandle,
		});

		const submitted = loop.submit("hello");
		while (!retryPhases(entries).includes("scheduled")) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		loop.cancel();
		await submitted;

		strictEqual(continueCalls, 0);
		ok(retryPhases(entries).includes("cancelled"), "retry cancellation should be durable");
	});

	it("aborts pending retry state before resetting session context", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.retry.baseDelayMs = 60_000;
		settings.retry.maxRetries = 1;
		const { session, entries } = sessionHarness();
		const agentState = {
			systemPrompt: "",
			model: {} as never,
			thinkingLevel: "off" as const,
			tools: [],
			messages: [] as AgentMessage[],
			isStreaming: false,
			pendingToolCalls: new Set<string>(),
			errorMessage: undefined,
		};
		let continueCalls = 0;
		let subscribeCb: ((event: AgentEvent) => void | Promise<void>) | null = null;
		const loop = createChatLoop({
			getSettings: () => settings,
			modes: modes(),
			providers: providers(settings),
			knownEndpoints: () => new Set(["stub-endpoint"]),
			session,
			createAgent: () =>
				({
					agent: {
						state: agentState,
						sessionId: undefined,
						subscribe: (cb: (event: AgentEvent) => void | Promise<void>) => {
							subscribeCb = cb;
							return () => {};
						},
						prompt: async (text: string) => {
							agentState.messages.push(userMessage(text));
							const failed = errorMessage("network timeout");
							agentState.messages.push(failed);
							await subscribeCb?.({ type: "agent_end", messages: [failed] });
						},
						continue: async () => {
							continueCalls += 1;
						},
						abort: () => {},
					},
					state: () => agentState,
				}) as unknown as EngineAgentHandle,
		});

		const submitted = loop.submit("hello");
		while (!retryPhases(entries).includes("scheduled")) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		const replay = [userMessage("replayed prompt"), assistantMessage("replayed answer")];
		loop.resetForSession(null, replay);
		await submitted;

		strictEqual(continueCalls, 0);
		deepStrictEqual(agentState.messages, replay);
	});
});
