import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { runMiddlewareRegistrations } from "../../src/domains/middleware/runtime.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import type { EndpointStatus, ProvidersContract } from "../../src/domains/providers/contract.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { EndpointDescriptor } from "../../src/domains/providers/types/endpoint-descriptor.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import { FINISH_CONTRACT_ADVISORY_MESSAGE } from "../../src/domains/safety/finish-contract.js";
import { createFinishContractRegistration } from "../../src/domains/safety/finish-contract-registration.js";
import type { SessionContract, SessionEntryInput, SessionMeta, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";
import { createToolProseRegistration } from "../../src/interactive/tool-prose-registration.js";

function settings(): ClioSettings {
	const value = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	value.orchestrator.endpoint = "test-target";
	value.orchestrator.model = "model";
	value.endpoints = [
		{
			id: "test-target",
			runtime: "fake-runtime",
			defaultModel: "model",
			capabilities: { contextWindow: 100000, maxTokens: 256, tools: true, chat: true },
		},
	];
	return value;
}

function providers(): ProvidersContract {
	const endpoint: EndpointDescriptor = {
		id: "test-target",
		runtime: "fake-runtime",
		defaultModel: "model",
		capabilities: { contextWindow: 100000, maxTokens: 256, tools: true, chat: true },
	};
	const runtime: RuntimeDescriptor = {
		id: "fake-runtime",
		displayName: "Fake Runtime",
		kind: "http",
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 100000, maxTokens: 256 },
		synthesizeModel: () =>
			({
				id: "model",
				name: "model",
				api: "openai-completions",
				provider: "fake-runtime",
				contextWindow: 100000,
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
		switchTurn: () => current as SessionMeta,
		editLabel: () => {},
		deleteSession: () => {},
		history: () => (current ? [current] : []),
		close: async () => {},
	};
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
	prepareNextTurn: unknown;
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
	emit(event: AgentEvent): Promise<void>;
	prompt(input: unknown): Promise<void>;
	continue(): Promise<void>;
	followUp(message: AgentMessage): void;
	abort(): void;
	clearAllQueues(): void;
	clearFollowUpQueue(): void;
}

/**
 * Fake agent factory mirroring tests/contracts/chat-loop.test.ts: the
 * promptImpl drives the event stream the chat-loop subscribes to. Also
 * counts abort() calls so hard-block interruption is observable.
 */
function createFakeAgentFactory(promptImpl: (agent: FakeAgent, input: unknown) => Promise<void>, aborts: number[]) {
	return ((options: { initialState?: Partial<FakeAgent["state"]> } = {}) => {
		const listeners: Array<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void> = [];
		const controller = new AbortController();
		const agent: FakeAgent = {
			state: {
				systemPrompt: options.initialState?.systemPrompt ?? "",
				model: options.initialState?.model,
				thinkingLevel: options.initialState?.thinkingLevel ?? "off",
				tools: options.initialState?.tools ?? [],
				messages: options.initialState?.messages ?? [],
				errorMessage: undefined,
			},
			sessionId: undefined,
			maxRetryDelayMs: undefined,
			prepareNextTurn: undefined,
			subscribe(listener) {
				listeners.push(listener);
				return () => {};
			},
			async emit(event: AgentEvent) {
				for (const listener of listeners) await listener(event, controller.signal);
			},
			async prompt(input: unknown) {
				await promptImpl(agent, input);
			},
			async continue() {},
			followUp() {},
			abort() {
				aborts.push(1);
			},
			clearAllQueues() {},
			clearFollowUpQueue() {},
		};
		return { agent, state: () => agent.state };
	}) as never;
}

function assistantStopMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

async function emitAssistantTurn(agent: FakeAgent, message: AgentMessage): Promise<void> {
	agent.state.messages.push(message);
	await agent.emit({ type: "message_start", message } as AgentEvent);
	await agent.emit({ type: "message_end", message } as AgentEvent);
	await agent.emit({ type: "agent_end", messages: [...agent.state.messages] } as AgentEvent);
}

describe("contracts/turn-hooks chat-loop wiring", () => {
	it("fires turn_start with prompt metadata and flushes its reminders into the same request", async () => {
		const seenInputs: MiddlewareHookInput[] = [];
		const middleware = createMiddlewareBundle().contract;
		middleware.registerHook({
			id: "test.turn-start-reminder",
			description: "inject a steering reminder at turn start",
			hooks: ["turn_start"],
			evaluate(input) {
				seenInputs.push(input);
				return [{ kind: "inject_reminder", message: "steering: prefer small diffs", severity: "info" }];
			},
		});
		const prompts: string[] = [];
		const entries: SessionEntry[] = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownEndpoints: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			middleware,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				prompts.push(String(input));
				await emitAssistantTurn(agent, assistantStopMessage("ok"));
			}, []),
		} as never);

		await loop.submit("hello there");

		strictEqual(seenInputs.length, 1);
		strictEqual(seenInputs[0]?.hook, "turn_start");
		strictEqual(seenInputs[0]?.metadata?.promptChars, "hello there".length);
		strictEqual(seenInputs[0]?.metadata?.queued, false);
		strictEqual(prompts.length, 1);
		const prompted = prompts[0] ?? "";
		ok(prompted.startsWith("<system-reminder>\nsteering: prefer small diffs\n</system-reminder>"));
		ok(prompted.endsWith("hello there"));
		// The injected block is plain visible text persisted with the user turn.
		const userEntry = entries.find((entry) => entry.kind === "message" && entry.role === "user");
		ok(userEntry && JSON.stringify(userEntry).includes("system-reminder"));
	});

	it("fires turn_end with capped text and assistant metadata", async () => {
		const seenInputs: MiddlewareHookInput[] = [];
		const middleware = createMiddlewareBundle().contract;
		middleware.registerHook({
			id: "test.turn-end-probe",
			description: "capture turn_end inputs",
			hooks: ["turn_end"],
			evaluate(input) {
				seenInputs.push(input);
				return [];
			},
		});
		const longText = `done ${"x".repeat(20_000)}`;
		const entries: SessionEntry[] = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownEndpoints: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			middleware,
			createAgent: createFakeAgentFactory(async (agent) => {
				await emitAssistantTurn(agent, assistantStopMessage(longText));
			}, []),
		} as never);

		await loop.submit("do the thing");

		strictEqual(seenInputs.length, 1);
		const input = seenInputs[0];
		strictEqual(input?.hook, "turn_end");
		strictEqual(input?.text?.length, 16_000);
		strictEqual(input?.metadata?.assistantTextChars, longText.length);
		strictEqual(input?.metadata?.stopReason, "stop");
		strictEqual(input?.metadata?.hasStructuredToolCall, false);
		strictEqual(input?.metadata?.runtimeId, "fake-runtime");
		ok(typeof input?.turnId === "string" && input.turnId.length > 0);
	});

	it("delivers the finish-contract advisory through turn_end: notice, ledger entry, next-request flush", async () => {
		const entries: SessionEntry[] = [];
		const middleware = createMiddlewareBundle().contract;
		middleware.registerHook(createFinishContractRegistration({ readSessionEntries: () => entries }));
		const prompts: string[] = [];
		const notices: string[] = [];
		let turn = 0;
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownEndpoints: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			middleware,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				prompts.push(String(input));
				turn += 1;
				await emitAssistantTurn(
					agent,
					assistantStopMessage(turn === 1 ? "Done. The feature is implemented and ready for review." : "ok"),
				);
			}, []),
		} as never);
		loop.onEvent((event) => {
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const content = (event.message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
				for (const part of content) {
					if (part.type === "text" && typeof part.text === "string") notices.push(part.text);
				}
			}
		});

		await loop.submit("implement the feature");

		ok(notices.includes(FINISH_CONTRACT_ADVISORY_MESSAGE), "advisory notice should reach the operator");
		const reminderEntry = entries.find((entry) => entry.kind === "custom" && entry.customType === "middlewareReminder");
		ok(reminderEntry, "advisory should persist as a middlewareReminder entry");
		const data = (reminderEntry as { data?: { message?: string; severity?: string } }).data;
		strictEqual(data?.message, FINISH_CONTRACT_ADVISORY_MESSAGE);
		strictEqual(data?.severity, "warn");

		await loop.submit("thanks");
		const second = prompts[1] ?? "";
		ok(second.includes("<system-reminder>"), "next request should carry the flushed reminder block");
		ok(second.includes(FINISH_CONTRACT_ADVISORY_MESSAGE));
		ok(second.endsWith("thanks"));

		await loop.submit("and again");
		ok(!(prompts[2] ?? "").includes("<system-reminder>"), "reminders flush once, not on every request");
	});

	it("interrupts the turn on a hard-block reminder and keeps the guidance for the next request", async () => {
		const middleware = createMiddlewareBundle().contract;
		middleware.registerHook({
			id: "test.turn-end-hard-block",
			description: "interrupt every turn",
			hooks: ["turn_end"],
			evaluate(input) {
				if (input.hook !== "turn_end") return [];
				return [
					{ kind: "inject_reminder", message: "[Clio Coder] aborted local model turn: test loop.", severity: "hard-block" },
				];
			},
		});
		const aborts: number[] = [];
		const prompts: string[] = [];
		const notices: string[] = [];
		const entries: SessionEntry[] = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownEndpoints: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			middleware,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				prompts.push(String(input));
				await emitAssistantTurn(agent, assistantStopMessage("narrating instead of calling tools"));
			}, aborts),
		} as never);
		loop.onEvent((event) => {
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const content = (event.message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
				for (const part of content) {
					if (part.type === "text" && typeof part.text === "string") notices.push(part.text);
				}
			}
		});

		await loop.submit("first");
		strictEqual(aborts.length, 1, "hard-block should abort the agent");
		ok(notices.some((text) => text.includes("aborted local model turn")));
		// Hard-block reminders interrupt; they never persist an advisory entry.
		strictEqual(
			entries.some((entry) => entry.kind === "custom" && entry.customType === "middlewareReminder"),
			false,
		);

		await loop.submit("second");
		ok((prompts[1] ?? "").includes("[Clio Coder] aborted local model turn: test loop."));
	});

	it("clears buffered reminders on session reset", async () => {
		const middleware = createMiddlewareBundle().contract;
		middleware.registerHook({
			id: "test.turn-end-warn",
			description: "warn every turn",
			hooks: ["turn_end"],
			evaluate() {
				return [{ kind: "inject_reminder", message: "leftover advice", severity: "warn" }];
			},
		});
		const prompts: string[] = [];
		const entries: SessionEntry[] = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownEndpoints: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			middleware,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				prompts.push(String(input));
				await emitAssistantTurn(agent, assistantStopMessage("ok"));
			}, []),
		} as never);

		await loop.submit("first");
		loop.resetForSession(null);
		await loop.submit("second");
		ok(!(prompts[1] ?? "").includes("leftover advice"), "session switch must drop buffered reminders");
	});
});

describe("contracts/turn-hooks finish-contract registration", () => {
	const baseInput = (overrides: Partial<MiddlewareHookInput> = {}): MiddlewareHookInput => ({
		hook: "turn_end",
		turnId: "turn-9",
		text: "Done. Implemented the parser and updated the tests.",
		metadata: { stopReason: "stop" },
		...overrides,
	});

	it("emits a warn reminder for a completion claim without evidence", () => {
		const registration = createFinishContractRegistration({ readSessionEntries: () => [] });
		const effects = registration.evaluate(baseInput());
		strictEqual(effects.length, 1);
		strictEqual(effects[0]?.kind, "inject_reminder");
		ok(effects[0]?.kind === "inject_reminder" && effects[0].severity === "warn");
	});

	it("stays silent on aborted turns, without a session, and when evidence exists", () => {
		const registration = createFinishContractRegistration({ readSessionEntries: () => [] });
		strictEqual(registration.evaluate(baseInput({ metadata: { stopReason: "aborted" } })).length, 0);

		const sessionless = createFinishContractRegistration({ readSessionEntries: () => null });
		strictEqual(sessionless.evaluate(baseInput()).length, 0);

		const withEvidence = createFinishContractRegistration({
			readSessionEntries: () => [
				{ kind: "protectedArtifact", action: "protect", artifact: { path: "report.md" }, turnId: "turn-1" },
			],
		});
		strictEqual(withEvidence.evaluate(baseInput()).length, 0);
	});
});

describe("contracts/turn-hooks tool-prose registration", () => {
	const proseText = `${"I will call the read tool now. ".repeat(8)}${"padding ".repeat(150)}`;
	const proseInput = (overrides: Partial<MiddlewareHookInput> = {}): MiddlewareHookInput => ({
		hook: "turn_end",
		text: proseText,
		metadata: {
			runtimeId: "llamacpp",
			activeToolNames: "read,write,bash",
			hasStructuredToolCall: false,
			stopReason: "stop",
		},
		...overrides,
	});

	it("emits a hard-block reminder for narrated tool calls on a local runtime", () => {
		const registration = createToolProseRegistration();
		const effects = registration.evaluate(proseInput());
		strictEqual(effects.length, 1);
		ok(effects[0]?.kind === "inject_reminder" && effects[0].severity === "hard-block");
		ok(effects[0]?.kind === "inject_reminder" && effects[0].message.includes("aborted local model turn"));
	});

	it("stays silent off local runtimes and when a structured tool call exists", () => {
		const registration = createToolProseRegistration();
		strictEqual(
			registration.evaluate(proseInput({ metadata: { runtimeId: "anthropic", activeToolNames: "read" } })).length,
			0,
		);
		strictEqual(
			registration.evaluate(
				proseInput({
					metadata: { runtimeId: "llamacpp", activeToolNames: "read", hasStructuredToolCall: true },
				}),
			).length,
			0,
		);
	});
});

describe("contracts/turn-hooks text cap", () => {
	it("caps MiddlewareHookInput.text at 16k chars for every evaluation", () => {
		let seen = -1;
		const result = runMiddlewareRegistrations({ hook: "turn_end", text: "y".repeat(40_000) }, [
			{
				id: "test.cap-probe",
				description: "observe text length",
				hooks: ["turn_end"],
				evaluate(input) {
					seen = input.text?.length ?? -1;
					return [];
				},
			},
		]);
		strictEqual(seen, 16_000);
		strictEqual(result.input.text?.length, 16_000);
	});
});
