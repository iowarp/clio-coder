import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import {
	buildProactiveScoutRoutingMessage,
	createReadOnlyExplorationNudgeRegistration,
} from "../../src/domains/middleware/dispatch-nudge.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { runMiddlewareHook, runMiddlewareRegistrations } from "../../src/domains/middleware/runtime.js";
import {
	STALLED_TURN_REQUEST_CONTINUATION_MESSAGE,
	STALLED_TURN_RULE_DEFINITION,
} from "../../src/domains/middleware/stalled-turn.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { CompletionContractAuditInput } from "../../src/domains/safety/audit.js";
import { FINISH_CONTRACT_ADVISORY_MESSAGE } from "../../src/domains/safety/finish-contract.js";
import {
	createFinishContractRegistration,
	HIGH_RIGOR_REVALIDATION_MESSAGE,
} from "../../src/domains/safety/finish-contract-registration.js";
import type { SessionContract, SessionEntryInput, SessionMeta, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";
import { createToolProseRegistration } from "../../src/interactive/tool-prose-registration.js";

function settings(): ClioSettings {
	const value = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	value.orchestrator.target = "test-target";
	value.orchestrator.model = "model";
	value.targets = [
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
	const target: TargetDescriptor = {
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
	const status: TargetStatus = {
		target,
		runtime,
		available: true,
		reason: "test",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...runtime.defaultCapabilities },
		discoveredModels: ["model"],
	};
	return {
		list: () => [status],
		getTarget: (id: string) => (id === target.id ? target : null),
		getRuntime: (id: string) => (id === runtime.id ? runtime : null),
		getDetectedReasoning: () => null,
		probeTarget: async () => status,
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
				target: input?.target ?? "test-target",
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

function dispatchOnlyRegistry(): unknown {
	const spec = {
		name: ToolNames.Dispatch,
		description: "dispatch test tool",
		parameters: { type: "object", properties: {} },
		baseActionClass: "dispatch",
		run: async () => ({ kind: "ok", output: "unused" }),
	};
	return {
		listRegistered: () => [ToolNames.Dispatch],
		get: (name: string) => (name === ToolNames.Dispatch ? spec : undefined),
		invoke: async () => ({ kind: "ok", result: { kind: "ok", output: "sealed Scout receipt" }, decision: {} }),
	};
}

async function emitAssistantTurn(agent: FakeAgent, message: AgentMessage): Promise<void> {
	agent.state.messages.push(message);
	await agent.emit({ type: "message_start", message } as AgentEvent);
	await agent.emit({ type: "message_end", message } as AgentEvent);
	await agent.emit({ type: "agent_end", messages: [...agent.state.messages] } as AgentEvent);
}

async function emitReadToolCall(agent: FakeAgent, toolCallId = "tool-1"): Promise<void> {
	await agent.emit({
		type: "tool_execution_start",
		toolCallId,
		toolName: "read",
		args: { path: "src/index.ts" },
	} as unknown as AgentEvent);
	await agent.emit({
		type: "tool_execution_end",
		toolCallId,
		toolName: "read",
		result: { kind: "ok", output: "file contents" },
		isError: false,
	} as unknown as AgentEvent);
}

/**
 * Emit a successful edit tool call so a mutating receipt lands in the session
 * ledger. The action-scoped finish contract engages only when the turn actually
 * changed workspace state, so registration tests that expect an advisory must
 * seed a mutation like this.
 */
async function emitEditToolCall(agent: FakeAgent, path = "src/index.ts", toolCallId = "edit-1"): Promise<void> {
	await agent.emit({
		type: "tool_execution_start",
		toolCallId,
		toolName: "edit",
		args: { path },
	} as unknown as AgentEvent);
	await agent.emit({
		type: "tool_execution_end",
		toolCallId,
		toolName: "edit",
		result: { kind: "ok", output: "edited" },
		isError: false,
	} as unknown as AgentEvent);
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
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			middleware,
			toolRegistry: dispatchOnlyRegistry(),
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
		strictEqual(seenInputs[0]?.metadata?.requestContinuation, false);
		strictEqual(seenInputs[0]?.metadata?.activeToolNames, ToolNames.Dispatch);
		strictEqual(prompts.length, 1);
		const prompted = prompts[0] ?? "";
		ok(prompted.startsWith("<system-reminder>\nsteering: prefer small diffs\n</system-reminder>"));
		ok(prompted.endsWith("hello there"));
		// The injected block is plain visible text persisted with the user turn.
		const userEntry = entries.find((entry) => entry.kind === "message" && entry.role === "user");
		ok(userEntry && JSON.stringify(userEntry).includes("system-reminder"));
	});

	it("puts the Scout routing reminder in the literal broad-exploration request", async () => {
		const middleware = createMiddlewareBundle().contract;
		middleware.registerHook(createReadOnlyExplorationNudgeRegistration({ canRouteScout: () => true }));
		const prompts: string[] = [];
		const entries: SessionEntry[] = [];
		type OnPayload = (payload: Record<string, unknown>, model: unknown) => Promise<Record<string, unknown> | undefined>;
		let capturedOnPayload: OnPayload | null = null;
		const baseFactory = createFakeAgentFactory(async (_agent, input) => {
			prompts.push(String(input));
		}, []);
		const factory = ((options: { onPayload?: OnPayload }) => {
			capturedOnPayload = options.onPayload ?? null;
			return (baseFactory as unknown as (value: unknown) => unknown)(options);
		}) as never;
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			middleware,
			toolRegistry: dispatchOnlyRegistry(),
			createAgent: factory,
		} as never);

		await loop.submit("let’s just explore this repo and context");

		strictEqual(prompts.length, 1);
		const prompt = prompts[0] ?? "";
		ok(prompt.startsWith(`<system-reminder>\n${buildProactiveScoutRoutingMessage()}\n</system-reminder>`));
		ok(prompt.includes("let’s just explore this repo and context"));
		ok(prompt.includes("The harness already ran Scout for this request"));
		ok(prompt.includes("sealed Scout receipt"));
		ok(capturedOnPayload !== null);
		const onPayload = capturedOnPayload as OnPayload;
		const patched = await onPayload(
			{ tools: [{ type: "function", function: { name: ToolNames.Dispatch } }] },
			{ api: "openai-completions" },
		);
		strictEqual(patched?.tool_choice, "none");
	});

	it("fires terminal turn_end from a terminating artifact result with the synthetic evidence boundary", async () => {
		const seenInputs: MiddlewareHookInput[] = [];
		const middleware = createMiddlewareBundle().contract;
		middleware.registerHook({
			id: "test.terminal-turn-end-probe",
			description: "capture terminal tool turn_end inputs",
			hooks: ["turn_end"],
			evaluate(input) {
				seenInputs.push(input);
				return [];
			},
		});
		const entries: SessionEntry[] = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			middleware,
			createAgent: createFakeAgentFactory(async (agent) => {
				const toolCall = {
					role: "assistant",
					content: [{ type: "toolCall", id: "artifact-1", name: "artifact", arguments: { kind: "report" } }],
					stopReason: "toolUse",
					timestamp: Date.now(),
				} as unknown as AgentMessage;
				agent.state.messages.push(toolCall);
				await agent.emit({ type: "message_start", message: toolCall } as AgentEvent);
				await agent.emit({ type: "message_end", message: toolCall } as AgentEvent);
				await agent.emit({
					type: "tool_execution_start",
					toolCallId: "artifact-1",
					toolName: "artifact",
					args: { kind: "report" },
				} as unknown as AgentEvent);
				await agent.emit({
					type: "tool_execution_end",
					toolCallId: "artifact-1",
					toolName: "artifact",
					result: { content: [], details: {}, terminate: true },
					isError: false,
				} as unknown as AgentEvent);
				await agent.emit({ type: "agent_end", messages: [...agent.state.messages] } as AgentEvent);
			}, []),
		} as never);

		await loop.submit("write the final report artifact");

		strictEqual(seenInputs.length, 1);
		const input = seenInputs[0];
		strictEqual(input?.hook, "turn_end");
		strictEqual(input?.text, "");
		strictEqual(input?.metadata?.assistantTextChars, 0);
		strictEqual(input?.metadata?.stopReason, "stop");
		strictEqual(input?.metadata?.hasStructuredToolCall, true);
		strictEqual(input?.metadata?.terminalToolResult, true);
		strictEqual(input?.metadata?.terminalToolCallId, "artifact-1");
		strictEqual(input?.metadata?.terminalToolName, "artifact");
		const userEntry = entries.find((entry) => entry.kind === "message" && entry.role === "user");
		const terminalEntry = entries.find(
			(entry) =>
				entry.kind === "message" && entry.role === "assistant" && JSON.stringify(entry).includes("terminalToolResult"),
		);
		ok(userEntry?.turnId);
		ok(terminalEntry?.turnId);
		strictEqual(input?.turnId, terminalEntry.turnId);
		strictEqual(input?.metadata?.userTurnId, userEntry.turnId);
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
			knownTargets: () => new Set(["test-target"]),
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
		strictEqual(input?.metadata?.turnToolCalls, 0);
		ok(typeof input?.turnId === "string" && input.turnId.length > 0);
		const userEntry = entries.find((entry) => entry.kind === "message" && entry.role === "user");
		const assistantEntry = entries.find((entry) => entry.kind === "message" && entry.role === "assistant");
		ok(userEntry?.turnId);
		ok(assistantEntry?.turnId);
		strictEqual(input?.turnId, assistantEntry.turnId, "turn_end keeps the final assistant evidence boundary");
		strictEqual(input?.metadata?.userTurnId, userEntry.turnId, "turn_end also names the initiating user turn");
		ok(input?.turnId !== input?.metadata?.userTurnId, "live user and assistant ledger turns have distinct ids");
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
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			middleware,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				prompts.push(String(input));
				turn += 1;
				// Turn 1 mutates a file then claims done with no validation, which is
				// exactly what the action-scoped contract engages on.
				if (turn === 1) await emitEditToolCall(agent);
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

	it("auto-continues once when a turn announces work but calls no tools", async () => {
		const entries: SessionEntry[] = [];
		const middleware = createMiddlewareBundle().contract;
		const prompts: string[] = [];
		const notices: Array<{ level: string; text: string }> = [];
		let call = 0;
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			middleware,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				prompts.push(String(input));
				call += 1;
				await emitAssistantTurn(
					agent,
					assistantStopMessage(
						call === 1
							? "Let me read the key identity files to understand the current state before suggesting edits."
							: "Done.",
					),
				);
			}, []),
		} as never);
		loop.onEvent((event) => {
			if (event.type === "notice") notices.push({ level: event.level, text: event.text });
		});

		await loop.submit("start");

		strictEqual(prompts.length, 2, "the stalled turn should resubmit exactly once");
		strictEqual(prompts[0], "start");
		const continuation = prompts[1] ?? "";
		ok(continuation.startsWith("<system-reminder>"));
		ok(continuation.includes(STALLED_TURN_REQUEST_CONTINUATION_MESSAGE));
		ok(continuation.endsWith("</system-reminder>"));
		ok(
			entries.some(
				(entry) =>
					entry.kind === "message" &&
					entry.role === "user" &&
					(entry.payload as { synthetic?: unknown }).synthetic === true &&
					JSON.stringify(entry).includes(STALLED_TURN_REQUEST_CONTINUATION_MESSAGE),
			),
			"the continuation reminder should persist as a synthetic user ledger entry",
		);
		ok(notices.some((notice) => notice.level === "info" && notice.text === "turn ended with open work; nudge sent"));
	});

	it("warns and stops when the model stalls again after the one-shot nudge", async () => {
		const entries: SessionEntry[] = [];
		const middleware = createMiddlewareBundle().contract;
		const prompts: string[] = [];
		const notices: Array<{ level: string; text: string }> = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			middleware,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				prompts.push(String(input));
				await emitAssistantTurn(
					agent,
					assistantStopMessage(
						"Now let me update the fallback identity prompt, CLI help, banner, and bootstrap self-identity.",
					),
				);
			}, []),
		} as never);
		loop.onEvent((event) => {
			if (event.type === "notice") notices.push({ level: event.level, text: event.text });
		});

		await loop.submit("start");

		strictEqual(prompts.length, 2, "the second stalled turn must not resubmit again");
		ok(
			notices.some(
				(notice) => notice.level === "warning" && notice.text === "model stalled again after a nudge; waiting for you",
			),
		);
	});

	it("does not auto-continue a tool-calling turn that announces follow-up work", async () => {
		const entries: SessionEntry[] = [];
		const middleware = createMiddlewareBundle().contract;
		const prompts: string[] = [];
		const notices: Array<{ level: string; text: string }> = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			middleware,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				prompts.push(String(input));
				await emitReadToolCall(agent);
				await emitAssistantTurn(
					agent,
					assistantStopMessage(
						"Let me read the key identity files to understand the current state before suggesting edits.",
					),
				);
			}, []),
		} as never);
		loop.onEvent((event) => {
			if (event.type === "notice") notices.push({ level: event.level, text: event.text });
		});

		await loop.submit("start");

		strictEqual(prompts.length, 1);
		strictEqual(notices.length, 0);
	});

	it("resets the one-shot stalled-turn cap on the next real user prompt", async () => {
		const entries: SessionEntry[] = [];
		const middleware = createMiddlewareBundle().contract;
		const prompts: string[] = [];
		const notices: Array<{ level: string; text: string }> = [];
		let call = 0;
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: createSession(entries),
			readSessionEntries: () => entries,
			middleware,
			createAgent: createFakeAgentFactory(async (agent, input) => {
				prompts.push(String(input));
				call += 1;
				const text =
					call === 1 || call === 2 || call === 3
						? "Let me read the key identity files to understand the current state before suggesting edits."
						: "Done.";
				await emitAssistantTurn(agent, assistantStopMessage(text));
			}, []),
		} as never);
		loop.onEvent((event) => {
			if (event.type === "notice") notices.push({ level: event.level, text: event.text });
		});

		await loop.submit("first");
		strictEqual(prompts.length, 2);
		ok(notices.some((notice) => notice.level === "warning"));

		await loop.submit("second");

		strictEqual(prompts.length, 4, "a fresh user prompt should get one new auto-continuation");
		ok((prompts[3] ?? "").includes(STALLED_TURN_REQUEST_CONTINUATION_MESSAGE));
		strictEqual(
			notices.filter((notice) => notice.level === "info" && notice.text === "turn ended with open work; nudge sent")
				.length,
			2,
		);
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
			knownTargets: () => new Set(["test-target"]),
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
			knownTargets: () => new Set(["test-target"]),
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

describe("contracts/turn-hooks stalled-turn nudge", () => {
	const effectsFor = (
		text: string,
		metadata: MiddlewareHookInput["metadata"] = { turnToolCalls: 0, stopReason: "stop" },
	) =>
		runMiddlewareHook(
			{
				hook: "turn_end",
				text,
				metadata,
			},
			[STALLED_TURN_RULE_DEFINITION],
		).effects;

	it("fires for the live transcript action announcements", () => {
		for (const text of [
			"Let me read the key identity files to understand the current state before suggesting edits.",
			"Now let me update the fallback identity prompt, CLI help, banner, and bootstrap self-identity.",
		]) {
			const effects = effectsFor(text);
			strictEqual(effects.length, 1, text);
			strictEqual(effects[0]?.kind, "request_continuation");
			ok(effects[0]?.kind === "request_continuation" && effects[0].message === STALLED_TURN_REQUEST_CONTINUATION_MESSAGE);
		}
	});

	it("does not fire for questions, completion headers, let-me-know phrasing, or real tool activity", () => {
		for (const text of [
			"What would you like to work on?",
			"All done. Here is a summary of every identity touchpoint that was edited:",
			"Let me know if you want me to proceed.",
			"Summary:",
		]) {
			strictEqual(effectsFor(text).length, 0, text);
		}
		strictEqual(
			effectsFor("Let me read the key identity files to understand the current state before suggesting edits.", {
				turnToolCalls: 1,
				stopReason: "stop",
			}).length,
			0,
		);
	});

	it("only fires on absent or normal stop reasons", () => {
		strictEqual(
			effectsFor("Next I will inspect the files.", { turnToolCalls: 0 }).length,
			1,
			"absent stopReason is normal",
		);
		for (const stopReason of ["stop", "end_turn", "stop_sequence", "stop-sequence-model"]) {
			strictEqual(effectsFor("Next I will inspect the files.", { turnToolCalls: 0, stopReason }).length, 1, stopReason);
		}
		for (const stopReason of ["aborted", "cancelled", "error", "length", "toolUse"]) {
			strictEqual(effectsFor("Next I will inspect the files.", { turnToolCalls: 0, stopReason }).length, 0, stopReason);
		}
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

	// A successful edit receipt: the action-scoped trigger. Registration tests
	// that expect the contract to engage must seed a mutation like this.
	const mutationEntries = (path = "src/parser.ts"): SessionEntry[] =>
		[
			{
				kind: "message",
				turnId: "turn-c",
				parentTurnId: null,
				timestamp: "t",
				role: "tool_call",
				payload: { name: "edit", toolCallId: "c1", args: { path } },
			},
			{
				kind: "message",
				turnId: "turn-r",
				parentTurnId: null,
				timestamp: "t",
				role: "tool_result",
				payload: { toolName: "edit", toolCallId: "c1", isError: false, result: { kind: "ok" } },
			},
		] as unknown as SessionEntry[];

	// A read receipt: never a mutation, so it can never engage the contract.
	const readOnlyEntries = (): SessionEntry[] =>
		[
			{
				kind: "message",
				turnId: "turn-c",
				parentTurnId: null,
				timestamp: "t",
				role: "tool_call",
				payload: { name: "read", toolCallId: "c1", args: { path: "src/parser.ts" } },
			},
			{
				kind: "message",
				turnId: "turn-r",
				parentTurnId: null,
				timestamp: "t",
				role: "tool_result",
				payload: { toolName: "read", toolCallId: "c1", isError: false, result: { kind: "ok" } },
			},
		] as unknown as SessionEntry[];

	it("emits a warn reminder when a turn mutated a file without evidence", () => {
		const registration = createFinishContractRegistration({ readSessionEntries: () => mutationEntries() });
		const effects = registration.evaluate(baseInput());
		strictEqual(effects.length, 1);
		strictEqual(effects[0]?.kind, "inject_reminder");
		ok(effects[0]?.kind === "inject_reminder" && effects[0].severity === "warn");
	});

	it("stays silent on aborted turns, without a session, and when the mutation is validated", () => {
		const registration = createFinishContractRegistration({ readSessionEntries: () => mutationEntries() });
		strictEqual(registration.evaluate(baseInput({ metadata: { stopReason: "aborted" } })).length, 0);

		const sessionless = createFinishContractRegistration({ readSessionEntries: () => null });
		strictEqual(sessionless.evaluate(baseInput()).length, 0);

		// Mutation + a protected-artifact record (validation evidence) clears it.
		const withEvidence = createFinishContractRegistration({
			readSessionEntries: () =>
				[
					...mutationEntries(),
					{ kind: "protectedArtifact", action: "protect", artifact: { path: "report.md" }, turnId: "turn-1" },
				] as unknown as SessionEntry[],
		});
		strictEqual(withEvidence.evaluate(baseInput()).length, 0);
	});

	it("re-prompts with request_continuation at high rigor when a mutation has no evidence", () => {
		const registration = createFinishContractRegistration({
			readSessionEntries: () => mutationEntries(),
			resolveRigor: () => "high",
		});
		const effects = registration.evaluate(baseInput());
		strictEqual(effects.length, 2);
		const continuation = effects.find((effect) => effect.kind === "request_continuation");
		ok(continuation, "high rigor must withhold completion with a request_continuation");
		ok(continuation?.kind === "request_continuation" && continuation.message === HIGH_RIGOR_REVALIDATION_MESSAGE);
		const reminder = effects.find((effect) => effect.kind === "inject_reminder");
		ok(reminder?.kind === "inject_reminder" && reminder.severity === "warn");
		ok(reminder?.kind === "inject_reminder" && reminder.message === HIGH_RIGOR_REVALIDATION_MESSAGE);
	});

	it("does not request high-rigor continuation after a prior hard-block effect", () => {
		const finish = createFinishContractRegistration({
			readSessionEntries: () => mutationEntries(),
			resolveRigor: () => "high",
		});
		const result = runMiddlewareRegistrations(
			baseInput({
				text: `Done. Implemented the parser and updated the tests. ${"I will call the read tool now. ".repeat(8)}${"padding ".repeat(180)}`,
				metadata: {
					stopReason: "stop",
					runtimeId: "lmstudio-native",
					activeToolNames: "read",
				},
			}),
			[createToolProseRegistration(), finish],
		);

		ok(result.effects.some((effect) => effect.kind === "inject_reminder" && effect.severity === "hard-block"));
		ok(!result.effects.some((effect) => effect.kind === "request_continuation"));
	});

	it("keeps the soft warn advisory at normal rigor with no request_continuation", () => {
		const registration = createFinishContractRegistration({
			readSessionEntries: () => mutationEntries(),
			resolveRigor: () => "normal",
		});
		const effects = registration.evaluate(baseInput());
		strictEqual(effects.length, 1);
		strictEqual(effects[0]?.kind, "inject_reminder");
		ok(effects[0]?.kind === "inject_reminder" && effects[0].severity === "warn");
		ok(!effects.some((effect) => effect.kind === "request_continuation"));
	});

	it("never gates a no-mutation turn, even at high rigor", () => {
		const readOnly = createFinishContractRegistration({
			readSessionEntries: () => readOnlyEntries(),
			resolveRigor: () => "high",
		});
		strictEqual(
			readOnly.evaluate(baseInput({ text: "Reads complete; ready for next instruction." })).length,
			0,
			"a read-only turn stays exempt at high rigor",
		);

		const noReceipt = createFinishContractRegistration({
			readSessionEntries: () => [],
			resolveRigor: () => "high",
		});
		strictEqual(
			noReceipt.evaluate(baseInput({ text: "Done. The parser is implemented and ready for review." })).length,
			0,
			"a turn that ran no tools stays exempt at high rigor",
		);
	});

	it("records every decision to the audit sink with mutated paths, reason, and rigor", () => {
		const recorded: CompletionContractAuditInput[] = [];
		const engage = createFinishContractRegistration({
			readSessionEntries: () => mutationEntries("src/app.ts"),
			resolveRigor: () => "high",
			recordDecision: (record) => recorded.push(record),
		});
		engage.evaluate(baseInput());
		strictEqual(recorded.length, 1);
		strictEqual(recorded[0]?.decision, "engage");
		strictEqual(recorded[0]?.reason, "unvalidated_mutation");
		strictEqual(recorded[0]?.rigor, "high");
		strictEqual(recorded[0]?.turnId, "turn-9");
		deepStrictEqual(recorded[0]?.mutatedPaths, ["src/app.ts"]);

		const ok2 = createFinishContractRegistration({
			readSessionEntries: () => readOnlyEntries(),
			recordDecision: (record) => recorded.push(record),
		});
		ok2.evaluate(baseInput());
		strictEqual(recorded.length, 2);
		strictEqual(recorded[1]?.decision, "ok");
		strictEqual(recorded[1]?.reason, "no_mutation");
	});

	it("does not let synthetic request-continuation reminders reset the finish-contract mutation window", () => {
		const recorded: CompletionContractAuditInput[] = [];
		const entries = [
			...mutationEntries("src/app.ts"),
			{
				kind: "message",
				role: "user",
				turnId: "turn-reminder",
				payload: { text: "<system-reminder>validate</system-reminder>", synthetic: true },
			},
			{
				kind: "message",
				role: "tool_call",
				turnId: "turn-validate",
				payload: { name: "bash", toolCallId: "call-validate", args: { command: "npm run test" } },
			},
			{
				kind: "message",
				role: "tool_result",
				turnId: "turn-validate",
				payload: { toolName: "bash", toolCallId: "call-validate", result: { details: { exitCode: 0 } } },
			},
		];
		const registration = createFinishContractRegistration({
			readSessionEntries: () => entries,
			resolveRigor: () => "high",
			recordDecision: (record) => recorded.push(record),
		});
		registration.evaluate(baseInput({ text: "Validated and complete." }));
		strictEqual(recorded[0]?.decision, "ok");
		strictEqual(recorded[0]?.reason, "validation_evidence");
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

describe("contracts/turn-hooks on_compaction", () => {
	it("fires observe-only on_compaction before the llm summary stage", async () => {
		const seenInputs: MiddlewareHookInput[] = [];
		const middleware = createMiddlewareBundle().contract;
		middleware.registerHook({
			id: "test.compaction-probe",
			description: "observe compaction lifecycle",
			hooks: ["on_compaction"],
			evaluate(input) {
				seenInputs.push(input);
				// Effects from on_compaction are discarded by design; emit one
				// to prove the chat-loop does not deliver it anywhere.
				return [{ kind: "inject_reminder", message: "must be discarded", severity: "warn" }];
			},
		});
		const entries: SessionEntry[] = [];
		const session = createSession(entries);
		session.create({ cwd: process.cwd() });
		const prompts: string[] = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session,
			readSessionEntries: () => entries,
			middleware,
			autoCompact: async () => ({
				summary: "summary text",
				firstKeptEntryIndex: 0,
				firstKeptTurnId: "t-1",
				tokensBefore: 100,
				messagesSummarized: 2,
				isSplitTurn: false,
			}),
			createAgent: createFakeAgentFactory(async (agent, input) => {
				prompts.push(String(input));
				await emitAssistantTurn(agent, assistantStopMessage("ok"));
			}, []),
		} as never);

		await loop.compact();

		strictEqual(seenInputs.length, 1);
		strictEqual(seenInputs[0]?.hook, "on_compaction");
		strictEqual(seenInputs[0]?.metadata?.stage, "llm_summary");
		strictEqual(seenInputs[0]?.metadata?.trigger, "force");
		strictEqual(seenInputs[0]?.sessionId, "session-1");

		// The discarded reminder must not leak into the next request.
		await loop.submit("after compaction");
		ok(!(prompts[0] ?? "").includes("must be discarded"));
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
