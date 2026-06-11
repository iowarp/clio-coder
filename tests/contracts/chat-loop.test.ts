import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { BusChannels } from "../../src/core/bus-events.js";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import type { EndpointStatus, ProvidersContract } from "../../src/domains/providers/contract.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { EndpointDescriptor } from "../../src/domains/providers/types/endpoint-descriptor.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import type { CompactResult } from "../../src/domains/session/compaction/compact.js";
import type { SessionContract, SessionEntryInput, SessionMeta, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { backendCacheVerdict, type ChatLoopEvent, createChatLoop } from "../../src/interactive/chat-loop.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";
import { createReadSkillTool } from "../../src/tools/skills.js";

function settings(overrides: Partial<ClioSettings["compaction"]> = {}): ClioSettings {
	const value = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	value.orchestrator.endpoint = "test-target";
	value.orchestrator.model = "model";
	value.endpoints = [
		{
			id: "test-target",
			runtime: "fake-runtime",
			defaultModel: "model",
			capabilities: { contextWindow: 1000, maxTokens: 256, tools: true, chat: true },
		},
	];
	value.compaction = { ...value.compaction, ...overrides };
	return value;
}

function providers(tier?: "local-native"): ProvidersContract {
	const endpoint: EndpointDescriptor = {
		id: "test-target",
		runtime: "fake-runtime",
		defaultModel: "model",
		capabilities: { contextWindow: 1000, maxTokens: 256, tools: true, chat: true },
	};
	const runtime: RuntimeDescriptor = {
		id: "fake-runtime",
		displayName: "Fake Runtime",
		kind: "http",
		...(tier ? { tier } : {}),
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 1000, maxTokens: 256 },
		synthesizeModel: () =>
			({
				id: "model",
				name: "model",
				api: "openai-completions",
				provider: "fake-runtime",
				contextWindow: 1000,
				maxTokens: 256,
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}) as never,
	};
	const status: EndpointStatus = {
		endpoint,
		runtime,
		available: true,
		reason: "test",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...runtime.defaultCapabilities },
		discoveredModels: ["model"],
	};
	return {
		list: () => [status],
		getEndpoint: (id: string) => (id === endpoint.id ? endpoint : null),
		getRuntime: (id: string) => (id === runtime.id ? runtime : null),
		getDetectedReasoning: () => null,
		probeEndpoint: async () => status,
		probeReasoningForModel: async () => null,
		knowledgeBase: null,
		auth: {
			statusForTarget: () => ({ kind: "not-required" }) as never,
			resolveForTarget: async () => ({ apiKey: "", source: "none" }) as never,
		} as never,
	} as never;
}

function createSession(entries: SessionEntry[] = []): SessionContract {
	let current: SessionMeta | null = null;
	let counter = 0;
	const nextId = () => `turn-${++counter}`;
	return {
		current: () => current,
		create(input) {
			current = {
				id: "session-1",
				createdAt: new Date().toISOString(),
				cwd: input?.cwd ?? process.cwd(),
				model: input?.model ?? "model",
				endpoint: input?.endpoint ?? "test-target",
			} as SessionMeta;
			return current;
		},
		append(turn: TurnInput) {
			if (!current) this.create();
			const id = turn.id ?? nextId();
			const at = turn.at ?? new Date().toISOString();
			entries.push({
				kind: "message",
				turnId: id,
				parentTurnId: turn.parentId,
				timestamp: at,
				role: turn.kind,
				payload: turn.payload,
			});
			return { ...turn, id, at };
		},
		appendEntry(entry: SessionEntryInput) {
			const withIds = {
				...entry,
				turnId: entry.turnId ?? nextId(),
				parentTurnId: entry.parentTurnId ?? null,
				timestamp: entry.timestamp ?? new Date().toISOString(),
			} as SessionEntry;
			entries.push(withIds);
			return withIds;
		},
		replaceEntries(next) {
			entries.splice(0, entries.length, ...next);
		},
		recordSkillActivation: (activation) => activation,
		checkpoint: async () => {},
		resume: () => current as SessionMeta,
		fork: () => current as SessionMeta,
		tree: () => ({ nodes: [], rootSessionId: "session-1" }) as never,
		switchBranch: () => current as SessionMeta,
		editLabel: () => {},
		deleteSession: () => {},
		history: () => (current ? [current] : []),
		close: async () => {
			current = null;
		},
	};
}

type FakeAgentOptions = {
	initialState?: {
		systemPrompt?: string;
		model?: unknown;
		thinkingLevel?: string;
		tools?: unknown[];
		messages?: AgentMessage[];
	};
	prepareNextTurn?: (signal?: AbortSignal) => Promise<unknown> | unknown;
};

function createFakeAgentFactory(promptImpl: (agent: FakeAgent, input: AgentMessage | AgentMessage[]) => Promise<void>) {
	return ((options: FakeAgentOptions = {}) => {
		const listeners: Array<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void> = [];
		const state = {
			systemPrompt: options.initialState?.systemPrompt ?? "",
			model: options.initialState?.model,
			thinkingLevel: options.initialState?.thinkingLevel ?? "off",
			tools: options.initialState?.tools ?? [],
			messages: options.initialState?.messages ?? [],
			errorMessage: undefined as string | undefined,
		};
		const controller = new AbortController();
		const agent: FakeAgent = {
			state,
			sessionId: undefined,
			maxRetryDelayMs: undefined,
			prepareNextTurn: options.prepareNextTurn,
			subscribe(listener) {
				listeners.push(listener);
				return () => {};
			},
			async emit(event: AgentEvent) {
				for (const listener of listeners) await listener(event, controller.signal);
			},
			async prompt(input: AgentMessage | AgentMessage[]) {
				await promptImpl(agent, input);
			},
			async continue() {},
			followUp() {},
			abort() {},
			clearAllQueues() {},
			clearFollowUpQueue() {},
			clearSteeringQueue() {},
		};
		return { agent, state: () => state };
	}) as never;
}

interface FakeAgent {
	state: {
		systemPrompt: string;
		model: unknown;
		thinkingLevel: string;
		tools: unknown[];
		messages: AgentMessage[];
		errorMessage: string | undefined;
	};
	sessionId: string | undefined;
	maxRetryDelayMs: number | undefined;
	prepareNextTurn: ((signal?: AbortSignal) => Promise<unknown> | unknown) | undefined;
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
	emit(event: AgentEvent): Promise<void>;
	prompt(input: AgentMessage | AgentMessage[]): Promise<void>;
	continue(): Promise<void>;
	followUp(message: AgentMessage): void;
	abort(): void;
	clearAllQueues(): void;
	clearFollowUpQueue(): void;
	clearSteeringQueue(): void;
}

function inputMessages(input: AgentMessage | AgentMessage[]): AgentMessage[] {
	return Array.isArray(input) ? input : [input];
}

describe("contracts/chat-loop compaction and terminal notices", () => {
	it("runs post-tool compaction guard before an oversized continuation", async () => {
		const entries: SessionEntry[] = [];
		let compactTrigger: string | undefined;
		let prepareUpdate: unknown;
		const loop = createChatLoop({
			getSettings: () =>
				settings({
					thresholds: {
						warning: 0.1,
						maskObservations: 0.2,
						pruneObservations: 0.3,
						maskDialogue: 0.4,
						llmSummary: 0.5,
					},
				}),
			providers: providers(),
			knownEndpoints: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			autoCompact: async (_instructions: string | undefined, trigger: string | undefined): Promise<CompactResult> => {
				compactTrigger = trigger;
				entries.splice(0, entries.length, {
					kind: "compactionSummary",
					turnId: "summary-1",
					parentTurnId: null,
					timestamp: new Date().toISOString(),
					summary: "compacted tool observations",
					tokensBefore: 1500,
					firstKeptTurnId: "summary-1",
					trigger: "auto",
				});
				return {
					summary: "compacted tool observations",
					firstKeptEntryIndex: 0,
					firstKeptTurnId: "summary-1",
					tokensBefore: 1500,
					messagesSummarized: 3,
					isSplitTurn: false,
				};
			},
			createAgent: createFakeAgentFactory(async (agent, input) => {
				agent.state.messages.push(...inputMessages(input));
				agent.state.messages.push({
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "huge.txt" } }],
					stopReason: "toolUse",
					timestamp: Date.now(),
				} as unknown as AgentMessage);
				agent.state.messages.push({
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "x".repeat(7000) }],
					timestamp: Date.now(),
				} as unknown as AgentMessage);
				prepareUpdate = await agent.prepareNextTurn?.(new AbortController().signal);
				const context = (prepareUpdate as { context?: { messages?: AgentMessage[] } } | undefined)?.context;
				if (context?.messages) agent.state.messages = context.messages;
			}),
		} as never);

		await loop.submit("read huge file");

		strictEqual(compactTrigger, "auto");
		const context = (prepareUpdate as { context?: { messages?: AgentMessage[] } } | undefined)?.context;
		ok(context?.messages && context.messages.length > 0, "expected compacted continuation context");
		ok(!JSON.stringify(context.messages).includes("xxxx"), "oversized tool observation should not survive guard");
	});

	it("renders and persists provider length stops with explicit exhaustion metadata", async () => {
		const entries: SessionEntry[] = [];
		const panel = createChatPanel();
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownEndpoints: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			createAgent: createFakeAgentFactory(async (agent) => {
				const message = {
					role: "assistant",
					content: [],
					stopReason: "length",
					usage: { input: 1100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1101 },
					timestamp: Date.now(),
				} as unknown as AgentMessage;
				agent.state.messages.push(message);
				await agent.emit({ type: "message_start", message });
				await agent.emit({ type: "message_end", message });
				await agent.emit({ type: "agent_end", messages: [message] });
			}),
		} as never);
		loop.onEvent((event: ChatLoopEvent) => panel.applyEvent(event));

		await loop.submit("trigger length stop");

		const assistant = entries.find((entry) => entry.kind === "message" && entry.role === "assistant");
		ok(assistant && assistant.kind === "message");
		const payload = assistant.payload as {
			contextExhaustion?: { kind?: string; contextWindow?: number };
			timing?: { ttftMs: number | null; apiMs: number };
			promptCache?: { input: number; cacheRead: number; backendVerdict: string };
		};
		strictEqual(payload.contextExhaustion?.kind, "provider_length_stop");
		strictEqual(payload.contextExhaustion?.contextWindow, 1000);
		// Per-call telemetry (T3.2) rides every persisted assistant entry.
		ok(payload.timing && payload.timing.apiMs >= 0, "expected persisted apiMs");
		strictEqual(payload.timing?.ttftMs, null);
		strictEqual(payload.promptCache?.input, 1100);
		strictEqual(payload.promptCache?.backendVerdict, "small");
		ok(panel.render(120).join("\n").includes("generation/output limit"));
	});
});

describe("contracts/chat-loop per-turn telemetry", () => {
	it("classifies per-call cache verdicts with the turn-report thresholds", () => {
		strictEqual(backendCacheVerdict(11, 5319), "hot");
		strictEqual(backendCacheVerdict(2400, 3000), "partial");
		strictEqual(backendCacheVerdict(5330, 0), "cold");
		strictEqual(backendCacheVerdict(17, 0), "small");
	});

	it("persists timing + prompt-cache fields and stamps expected-cold reasons after dispatch activity", async () => {
		const entries: SessionEntry[] = [];
		const bus = createSafeEventBus();
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers("local-native"),
			knownEndpoints: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			bus,
			createAgent: createFakeAgentFactory(async (agent) => {
				const message = {
					role: "assistant",
					content: [{ type: "text", text: "warm reply" }],
					stopReason: "stop",
					usage: { input: 17, output: 9, cacheRead: 5319, cacheWrite: 0, totalTokens: 5345 },
					timestamp: Date.now(),
				} as unknown as AgentMessage;
				await agent.emit({ type: "agent_start" });
				await agent.emit({ type: "message_start", message });
				await agent.emit({
					type: "message_update",
					message,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "warm", partial: message },
				} as never);
				agent.state.messages.push(message);
				await agent.emit({ type: "message_end", message });
				await agent.emit({ type: "agent_end", messages: [message] });
			}),
		} as never);

		// Worker traffic on the shared backend since the last settled run.
		bus.emit(BusChannels.DispatchCompleted, { at: Date.now() });
		await loop.submit("after a dispatch ran");

		const assistant = entries.find((entry) => entry.kind === "message" && entry.role === "assistant");
		ok(assistant && assistant.kind === "message");
		const payload = assistant.payload as {
			timing?: { ttftMs: number | null; apiMs: number };
			promptCache?: {
				input: number;
				cacheRead: number;
				cacheWrite: number;
				backendVerdict: string;
				expectedColdReasons?: string[];
			};
		};
		ok(payload.timing && payload.timing.apiMs >= 0, "expected persisted apiMs");
		ok(payload.timing?.ttftMs !== null && (payload.timing?.ttftMs ?? -1) >= 0, "expected persisted ttftMs");
		strictEqual(payload.promptCache?.input, 17);
		strictEqual(payload.promptCache?.cacheRead, 5319);
		strictEqual(payload.promptCache?.backendVerdict, "hot");
		deepStrictEqual(payload.promptCache?.expectedColdReasons, ["dispatch"]);
	});
});

function allowAllSafety(): SafetyContract {
	return {
		classify: () => ({ actionClass: "read", reasons: [] }),
		evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "test", count: 0 }),
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset,
		audit: { recordCount: () => 0 },
	};
}

function dummyTool(name: ToolName): ToolSpec {
	return {
		name,
		description: `${name} test tool`,
		parameters: Type.Object({}),
		baseActionClass: "read",
		run: async () => ({ kind: "ok", output: name }),
	};
}

interface NamedAgentTool {
	name: string;
	execute(toolCallId: string, params: unknown): Promise<unknown>;
}

describe("contracts/chat-loop pending skill tool surface", () => {
	it("keeps the full frozen surface on a pending-skill turn; loading a skill never reshapes the wire schemas", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-chat-skill-"));
		try {
			const skillDir = join(scratch, ".clio", "skills", "narrow");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				[
					"---",
					"name: narrow",
					"description: Narrow surface skill.",
					"allowed-tools:",
					"  - read",
					"  - grep",
					"---",
					"",
					"NARROW BODY",
					"",
				].join("\n"),
				"utf8",
			);

			const registry = createRegistry({ safety: allowAllSafety() });
			registry.register(createReadSkillTool({ getCwd: () => scratch }));
			for (const name of [ToolNames.Read, ToolNames.Grep, ToolNames.Edit, ToolNames.Bash]) {
				registry.register(dummyTool(name));
			}

			const entries: SessionEntry[] = [];
			let toolsAtStart: string[] = [];
			let unrequestedDenied = "";
			let readSkillOutput = "";
			let updateAfterLoad: unknown = "unset";
			const loop = createChatLoop({
				getSettings: () => settings(),
				providers: providers(),
				knownEndpoints: () => new Set(["test-target"]),
				session: createSession(entries),
				readSessionEntries: () => entries,
				toolRegistry: registry,
				createAgent: createFakeAgentFactory(async (agent, input) => {
					agent.state.messages.push(...inputMessages(input));
					const tools = agent.state.tools as NamedAgentTool[];
					toolsAtStart = tools.map((tool) => tool.name);
					const readSkill = tools.find((tool) => tool.name === "read_skill");
					ok(readSkill, "read_skill must be active on a pending-skill turn");
					// Invoke-time policy still gates skill loading even though the
					// wire schemas never narrow.
					try {
						const denied = (await readSkill.execute("call-0", { name: "unrequested" })) as {
							content?: Array<{ type: string; text?: string }>;
						};
						unrequestedDenied = denied.content?.find((part) => part.type === "text")?.text ?? "";
					} catch (err) {
						unrequestedDenied = err instanceof Error ? err.message : String(err);
					}
					const result = (await readSkill.execute("call-1", { name: "narrow" })) as {
						content?: Array<{ type: string; text?: string }>;
					};
					readSkillOutput = result.content?.find((part) => part.type === "text")?.text ?? "";
					agent.state.messages.push({
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "read_skill", arguments: { name: "narrow" } }],
						stopReason: "toolUse",
						timestamp: Date.now(),
					} as unknown as AgentMessage);
					agent.state.messages.push({
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "read_skill",
						content: [{ type: "text", text: readSkillOutput }],
						timestamp: Date.now(),
					} as unknown as AgentMessage);
					updateAfterLoad = await agent.prepareNextTurn?.(new AbortController().signal);
				}),
			} as never);

			await loop.submit("science skills for expert subagents", {
				pendingSkillRequests: [
					{
						name: "narrow",
						args: "science skills for expert subagents",
						source: "slash-command",
						installed: true,
						filePath: join(skillDir, "SKILL.md"),
					},
				],
			});

			// The frozen surface: every registered tool, sorted, from the first call.
			deepStrictEqual(toolsAtStart, ["bash", "edit", "grep", "read", "read_skill"]);
			ok(unrequestedDenied.includes("read_skill"));
			ok(readSkillOutput.includes("NARROW BODY"));
			// Loading a skill must not push a continuation update that reshapes tools.
			strictEqual(updateAfterLoad, undefined);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
