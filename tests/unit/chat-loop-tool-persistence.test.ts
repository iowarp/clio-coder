import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ObservabilityContract } from "../../src/domains/observability/contract.js";
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
		cwd: "/tmp/clio-tool-persistence-test",
		cwdHash: "h",
		createdAt: "2026-04-23T00:00:00.000Z",
		endedAt: null,
		model: null,
		endpoint: null,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.1.0-test",
		piMonoVersion: "0.0.0",
		platform: "linux",
		nodeVersion: "v20.0.0",
	};
}

function createProviders(): {
	settings: typeof DEFAULT_SETTINGS;
	providers: ProvidersContract;
} {
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

	return { settings, providers };
}

describe("interactive/chat-loop tool persistence", () => {
	it("persists tool call and result events into session lineage", async () => {
		const { settings, providers } = createProviders();
		let currentMeta: ClioSessionMeta | null = fakeMeta("session-1");
		const appended: ClioTurnRecord[] = [];
		const session: SessionContract = {
			current: () => currentMeta,
			create: () => {
				currentMeta = fakeMeta("session-1");
				return currentMeta;
			},
			append: (input) => {
				const rec: ClioTurnRecord = {
					id: `rec-${appended.length}`,
					parentId: input.parentId ?? null,
					at: "2026-04-23T00:00:00.000Z",
					kind: input.kind,
					payload: input.payload,
				};
				if (input.renderedPromptHash !== undefined) rec.renderedPromptHash = input.renderedPromptHash;
				appended.push(rec);
				return rec;
			},
			appendEntry: () => {
				throw new Error("unused in this test");
			},
			async checkpoint() {},
			resume: () => fakeMeta("session-1"),
			fork: () => fakeMeta("session-2"),
			tree: () => {
				throw new Error("unused in this test");
			},
			switchBranch: () => fakeMeta("session-1"),
			editLabel: () => {},
			deleteSession: () => {},
			history: () => [],
			async close() {},
		};

		let subscribeCb: ((event: AgentEvent) => void | Promise<void>) | null = null;
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
			session,
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
						const beforeTool: AgentMessage = {
							role: "assistant",
							content: [{ type: "text", text: "I will inspect the file." }],
							stopReason: "stop",
							timestamp: 0,
						} as AgentMessage;
						const afterTool: AgentMessage = {
							role: "assistant",
							content: [{ type: "text", text: "The file contains setup docs." }],
							stopReason: "stop",
							timestamp: 0,
						} as AgentMessage;
						await subscribeCb?.({ type: "message_end", message: beforeTool });
						await subscribeCb?.({
							type: "tool_execution_start",
							toolCallId: "call-1",
							toolName: "read",
							args: { path: "README.md" },
						});
						await subscribeCb?.({
							type: "tool_execution_end",
							toolCallId: "call-1",
							toolName: "read",
							result: { content: [{ type: "text", text: "setup docs" }], details: { kind: "ok" } },
							isError: false,
						});
						await subscribeCb?.({ type: "message_end", message: afterTool });
						await subscribeCb?.({ type: "agent_end", messages: [beforeTool, afterTool] });
					},
					abort: () => {},
				};
				return {
					agent: agent as unknown as EngineAgentHandle["agent"],
					state: () => agent.state,
				} as unknown as EngineAgentHandle;
			},
		});

		await loop.submit("inspect README");

		strictEqual(appended.length, 5);
		strictEqual(appended[0]?.kind, "user");
		strictEqual(appended[0]?.parentId, null);
		strictEqual(appended[1]?.kind, "assistant");
		strictEqual(appended[1]?.parentId, appended[0]?.id);
		strictEqual(appended[2]?.kind, "tool_call");
		strictEqual(appended[2]?.parentId, appended[1]?.id);
		strictEqual(appended[3]?.kind, "tool_result");
		strictEqual(appended[3]?.parentId, appended[2]?.id);
		strictEqual(appended[4]?.kind, "assistant");
		strictEqual(appended[4]?.parentId, appended[3]?.id);
		strictEqual((appended[2]?.payload as { name?: string }).name, "read");
		strictEqual((appended[3]?.payload as { toolCallId?: string }).toolCallId, "call-1");
	});

	it("surfaces a finish-contract advisory through chat events and session entries", async () => {
		const { settings, providers } = createProviders();
		let currentMeta: ClioSessionMeta | null = fakeMeta("session-1");
		const entries: SessionEntry[] = [];
		const session: SessionContract = {
			current: () => currentMeta,
			create: () => {
				currentMeta = fakeMeta("session-1");
				return currentMeta;
			},
			append: (input) => {
				const rec: ClioTurnRecord = {
					id: `turn-${entries.length}`,
					parentId: input.parentId ?? null,
					at: "2026-04-29T00:00:00.000Z",
					kind: input.kind,
					payload: input.payload,
				};
				entries.push({
					kind: "message",
					turnId: rec.id,
					parentTurnId: rec.parentId,
					timestamp: rec.at,
					role: rec.kind,
					payload: rec.payload,
				});
				return rec;
			},
			appendEntry: (input: SessionEntryInput) => {
				const entry = {
					...input,
					turnId: input.turnId ?? `entry-${entries.length}`,
					timestamp: input.timestamp ?? "2026-04-29T00:00:00.000Z",
				} as SessionEntry;
				entries.push(entry);
				return entry;
			},
			async checkpoint() {},
			resume: () => fakeMeta("session-1"),
			fork: () => fakeMeta("session-2"),
			tree: () => {
				throw new Error("unused in this test");
			},
			switchBranch: () => fakeMeta("session-1"),
			editLabel: () => {},
			deleteSession: () => {},
			history: () => [],
			async close() {},
		};

		let subscribeCb: ((event: AgentEvent) => void | Promise<void>) | null = null;
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
		const messages: string[] = [];
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
			session,
			readSessionEntries: () => entries,
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
						const reply: AgentMessage = {
							role: "assistant",
							content: [{ type: "text", text: "Done, the fix is complete." }],
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
		loop.onEvent((event) => {
			if (event.type !== "message_end") return;
			const content = event.message.content;
			if (!Array.isArray(content)) return;
			const text = content
				.filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
				.map((item) => item.text)
				.join("");
			messages.push(text);
		});

		await loop.submit("finish this");

		deepStrictEqual(messages, [
			"Done, the fix is complete.",
			"[Clio Coder] finish-contract advisory: completion claim found, but no recent validation evidence or explicit limitation was recorded. Run validation or state what could not be verified.",
		]);
		const advisory = entries.find((entry) => entry.kind === "custom" && entry.customType === "finishContractAdvisory");
		strictEqual(advisory?.kind, "custom");
		if (advisory?.kind === "custom") {
			deepStrictEqual(advisory.data, {
				message:
					"[Clio Coder] finish-contract advisory: completion claim found, but no recent validation evidence or explicit limitation was recorded. Run validation or state what could not be verified.",
			});
			strictEqual(advisory.parentTurnId, "turn-1");
		}
	});

	it("skips zero-usage observability records for failed turns", async () => {
		const { settings, providers } = createProviders();
		settings.retry.enabled = false;
		let recordCalls = 0;
		const observability: ObservabilityContract = {
			telemetry: () => ({}) as never,
			metrics: () => ({}) as never,
			sessionCost: () => 0,
			sessionTokens: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, totalTokens: 0 }),
			costEntries: () => [],
			recordTokens: () => {
				recordCalls += 1;
			},
		};

		let subscribeCb: ((event: AgentEvent) => void | Promise<void>) | null = null;
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
			observability,
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
						const failed: AgentMessage = {
							role: "assistant",
							content: [{ type: "text", text: "" }],
							stopReason: "error",
							errorMessage: "provider returned an error",
							timestamp: 0,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { total: 0 },
							},
						} as AgentMessage;
						agentState.messages.push(failed);
						await subscribeCb?.({ type: "agent_end", messages: [failed] });
					},
					abort: () => {},
				};
				return {
					agent: agent as unknown as EngineAgentHandle["agent"],
					state: () => agent.state,
				} as unknown as EngineAgentHandle;
			},
		});

		await loop.submit("trigger failure");

		strictEqual(recordCalls, 0);
	});
});
