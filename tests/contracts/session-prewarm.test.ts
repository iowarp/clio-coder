import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { SessionContract, SessionEntryInput, SessionMeta, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import type { AgentEvent, AgentMessage, EngineModel } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";
import { PREWARM_MAX_TOKENS, PREWARM_USER_TEXT, runPrewarmRound } from "../../src/interactive/prewarm.js";

// --- shared fixtures --------------------------------------------------------

function settings(enabled = true): ClioSettings {
	const value = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	value.chat.target = "test-target";
	value.chat.model = "model";
	value.chat.thinkingLevel = "off";
	value.targets = [
		{
			id: "test-target",
			runtime: "fake-runtime",
			defaultModel: "model",
			capabilities: { contextWindow: 100_000, maxTokens: 4096, tools: true, chat: true },
		},
	];
	value.chat.prewarm = enabled;
	return value;
}

function providers(tier?: RuntimeDescriptor["tier"]): ProvidersContract {
	const target: TargetDescriptor = {
		id: "test-target",
		runtime: "fake-runtime",
		defaultModel: "model",
		capabilities: { contextWindow: 100_000, maxTokens: 4096, tools: true, chat: true },
	};
	const runtime: RuntimeDescriptor = {
		id: "fake-runtime",
		displayName: "Fake Runtime",
		kind: "http",
		...(tier ? { tier } : {}),
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 100_000, maxTokens: 4096 },
		synthesizeModel: () => fakeModel() as never,
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

function fakeModel(): EngineModel {
	return {
		id: "model",
		name: "model",
		api: "openai-completions",
		provider: "fake-runtime",
		baseUrl: "http://127.0.0.1:1/v1",
		contextWindow: 100_000,
		maxTokens: 4096,
		reasoning: false,
		input: [],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as unknown as EngineModel;
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
			entries.push({
				kind: "message",
				turnId: id,
				parentTurnId: turn.parentId,
				timestamp: turn.at ?? new Date().toISOString(),
				role: turn.kind,
				payload: turn.payload,
			});
			return { ...turn, id, at: turn.at ?? new Date().toISOString() };
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
		setName: () => {},
		deleteSession: () => {},
		history: () => (current ? [current] : []),
		close: async () => {
			current = null;
		},
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
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
	emit(event: AgentEvent): Promise<void>;
	prompt(input: string): Promise<void>;
	continue(): Promise<void>;
	followUp(): void;
	abort(): void;
	clearAllQueues(): void;
	clearFollowUpQueue(): void;
	clearSteeringQueue(): void;
}

function createFakeAgentFactory(promptImpl: (agent: FakeAgent, text: string) => Promise<void>) {
	return ((options: { initialState?: Partial<FakeAgent["state"]> } = {}) => {
		const listeners: Array<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void> = [];
		const state = {
			systemPrompt: options.initialState?.systemPrompt ?? "session prompt",
			model: options.initialState?.model ?? fakeModel(),
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
			subscribe(listener) {
				listeners.push(listener);
				return () => {};
			},
			async emit(event: AgentEvent) {
				for (const listener of listeners) await listener(event, controller.signal);
			},
			async prompt(input: string) {
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

/** A pre-warm round that records what it was asked to send and answers with fixed usage. */
function recordingPrewarm(
	log: Array<{ systemPrompt: string; messages: ReadonlyArray<AgentMessage>; thinkingLevel: string }>,
	usage: { input: number; cacheRead: number } = { input: 12, cacheRead: 0 },
): typeof runPrewarmRound {
	return (async (input: Parameters<typeof runPrewarmRound>[0]) => {
		log.push({
			systemPrompt: input.state.systemPrompt,
			messages: [...input.state.messages],
			thinkingLevel: input.state.thinkingLevel,
		});
		return {
			aborted: false,
			usage: {
				input: usage.input,
				output: 1,
				cacheRead: usage.cacheRead,
				cacheWrite: 0,
				totalTokens: usage.input + usage.cacheRead + 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			backend: null,
			timing: { ttftMs: 5, apiMs: 9 },
			errorMessage: null,
		};
	}) as unknown as typeof runPrewarmRound;
}

function assistantTurn(usage: { input: number; cacheRead: number }): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		stopReason: "stop",
		usage: {
			input: usage.input,
			output: 4,
			cacheRead: usage.cacheRead,
			cacheWrite: 0,
			totalTokens: usage.input + usage.cacheRead + 4,
		},
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

// --- payload equality -------------------------------------------------------

/**
 * The bytes ahead of the user turn: everything the chat template renders before
 * the operator's message. Serialized the same way for both callers so the
 * comparison is over content, not object identity.
 */
function prefixBytes(context: { systemPrompt?: string; messages: ReadonlyArray<unknown>; tools?: unknown }): string {
	return JSON.stringify({
		systemPrompt: context.systemPrompt,
		tools: context.tools,
		messages: context.messages.slice(0, -1),
	});
}

interface CapturedRequest {
	context: { systemPrompt?: string; messages: ReadonlyArray<unknown>; tools?: unknown };
	options: { maxTokens?: number; reasoning?: unknown } | undefined;
}

function capturingStreamFn(captured: CapturedRequest[]) {
	return ((_model: unknown, context: CapturedRequest["context"], options: CapturedRequest["options"]) => {
		captured.push({ context, options });
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "fake-runtime",
			model: "model",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
			stopReason: "stop",
			timestamp: Date.now(),
		} as unknown as AssistantMessage;
		const stream: AssistantMessageEventStream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: message } as never);
		stream.push({ type: "done", reason: "stop", message } as never);
		stream.end(message);
		return stream;
	}) as never;
}

async function prefixesFor(
	history: AgentMessage[],
): Promise<{ prewarm: string; turn: string; captured: CapturedRequest[] }> {
	const captured: CapturedRequest[] = [];
	const streamFn = capturingStreamFn(captured);
	const tools = [
		{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } },
		{ name: "write", description: "write a file", parameters: { type: "object", properties: {} } },
	];
	const handle = createEngineAgent({
		initialState: {
			systemPrompt: "compiled session prompt",
			model: fakeModel() as never,
			thinkingLevel: "off",
			tools: tools as never,
			messages: [...history] as never,
		},
		streamFn,
	});

	await runPrewarmRound({
		model: handle.agent.state.model as EngineModel,
		state: {
			systemPrompt: handle.agent.state.systemPrompt,
			messages: handle.agent.state.messages as ReadonlyArray<AgentMessage>,
			tools: handle.agent.state.tools,
			thinkingLevel: handle.agent.state.thinkingLevel ?? "off",
		},
		streamFn,
	});
	await handle.agent.prompt("the operator's actual question");

	const prewarmRequest = captured[0];
	const turnRequest = captured[1];
	ok(prewarmRequest && turnRequest, "both requests were captured");
	return { prewarm: prefixBytes(prewarmRequest.context), turn: prefixBytes(turnRequest.context), captured };
}

describe("contracts/session pre-warm payload", () => {
	it("sends the same bytes ahead of the user turn as the next real turn, for a fresh session", async () => {
		const { prewarm, turn, captured } = await prefixesFor([]);
		strictEqual(prewarm, turn, "a fresh session's pre-warm prefix is the next turn's prefix");
		strictEqual(captured[0]?.options?.maxTokens, PREWARM_MAX_TOKENS, "the pre-warm asks for one token");
		strictEqual(captured[0]?.options?.reasoning, undefined, "thinking off maps onto an absent reasoning option");
		const appended = captured[0]?.context.messages.at(-1) as { content?: Array<{ text?: string }> } | undefined;
		strictEqual(appended?.content?.[0]?.text, PREWARM_USER_TEXT, "one character closes the prefix at the user turn");
	});

	it("sends the same bytes ahead of the user turn as the next real turn, for a resumed session", async () => {
		const history = [
			{ role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				stopReason: "stop",
				timestamp: 2,
			},
			{ role: "user", content: [{ type: "text", text: "second" }], timestamp: 3 },
			{
				role: "assistant",
				content: [{ type: "text", text: "another answer" }],
				stopReason: "stop",
				timestamp: 4,
			},
		] as unknown as AgentMessage[];
		const { prewarm, turn } = await prefixesFor(history);
		strictEqual(prewarm, turn, "a resumed session's pre-warm prefix is the next turn's prefix");
		ok(prewarm.includes("another answer"), "the replayed history is in the pre-warmed prefix");
	});
});

// --- gating, cancellation, ledger -------------------------------------------

describe("contracts/session pre-warm admission", () => {
	it("pre-warms at session start on a local-native target and records the round", async () => {
		const entries: SessionEntry[] = [];
		const rounds: Array<{ systemPrompt: string; messages: ReadonlyArray<AgentMessage>; thinkingLevel: string }> = [];
		const session = createSession(entries);
		session.create();
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers("local-native"),
			knownTargets: () => new Set(["test-target"]),
			session,
			readSessionEntries: () => entries,
			runPrewarm: recordingPrewarm(rounds),
			createAgent: createFakeAgentFactory(async () => {}),
		} as never);

		const outcome = await loop.whenPrewarmSettled();
		deepStrictEqual(outcome, { ran: true, trigger: "session-start" });
		strictEqual(rounds.length, 1, "exactly one pre-warm at session start");

		const recorded = entries.filter((entry) => entry.kind === "custom" && entry.customType === "prewarm");
		strictEqual(recorded.length, 1, "the round is recorded once");
		const entry = recorded[0];
		ok(entry && entry.kind === "custom");
		strictEqual(entry.display, false, "a pre-warm is never rendered and never a model message");
		const data = entry.data as {
			trigger: string;
			promptTokens: number | null;
			timing: { ttftMs: number | null; apiMs: number };
			promptCache: { input: number; cacheRead: number; cacheWrite: number };
		};
		strictEqual(data.trigger, "session-start");
		strictEqual(data.promptTokens, 12);
		deepStrictEqual(data.timing, { ttftMs: 5, apiMs: 9 });
		deepStrictEqual(data.promptCache, { input: 12, cacheRead: 0, cacheWrite: 0 });

		// Zero tokens toward the context estimate: the entry is not a message and
		// the ledger's own accounting never sees it.
		const ledger = loop.contextLedger();
		strictEqual(ledger.usedTokens, 0, "the pre-warm contributes nothing to the context estimate");
		deepStrictEqual(ledger.prewarm, { tokens: 12, ms: 9, aborted: false });
		loop.dispose();
	});

	it("never pre-warms off the local-native tier, whatever the setting says", async () => {
		const rounds: Array<{ systemPrompt: string; messages: ReadonlyArray<AgentMessage>; thinkingLevel: string }> = [];
		const loop = createChatLoop({
			getSettings: () => settings(true),
			providers: providers("cloud"),
			knownTargets: () => new Set(["test-target"]),
			runPrewarm: recordingPrewarm(rounds),
			createAgent: createFakeAgentFactory(async () => {}),
		} as never);

		deepStrictEqual(await loop.whenPrewarmSettled(), { ran: false, reason: "tier" });
		strictEqual(rounds.length, 0, "a cloud target is never pre-warmed");
		loop.dispose();
	});

	it("stands down while a dispatch is outstanding", async () => {
		const rounds: Array<{ systemPrompt: string; messages: ReadonlyArray<AgentMessage>; thinkingLevel: string }> = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers("local-native"),
			knownTargets: () => new Set(["test-target"]),
			hasActiveDispatch: () => true,
			runPrewarm: recordingPrewarm(rounds),
			createAgent: createFakeAgentFactory(async () => {}),
		} as never);

		deepStrictEqual(await loop.whenPrewarmSettled(), { ran: false, reason: "dispatch-active" });
		strictEqual(rounds.length, 0);
		loop.dispose();
	});

	it("does not pre-warm when the setting is off or the surface has no operator", async () => {
		const disabled = createChatLoop({
			getSettings: () => settings(false),
			providers: providers("local-native"),
			knownTargets: () => new Set(["test-target"]),
			runPrewarm: recordingPrewarm([]),
			createAgent: createFakeAgentFactory(async () => {}),
		} as never);
		deepStrictEqual(await disabled.whenPrewarmSettled(), { ran: false, reason: "disabled" });
		disabled.dispose();

		const headless = createChatLoop({
			getSettings: () => settings(),
			providers: providers("local-native"),
			knownTargets: () => new Set(["test-target"]),
			isLatencySurface: () => false,
			runPrewarm: recordingPrewarm([]),
			createAgent: createFakeAgentFactory(async () => {}),
		} as never);
		deepStrictEqual(await headless.whenPrewarmSettled(), { ran: false, reason: "surface" });
		headless.dispose();
	});

	/**
	 * Submitting always lets go of the round in flight. Whether it also aborts the
	 * request is gated on the backend: the operator's llama.cpp router finishes a
	 * cancelled prefill anyway, so aborting there discards the usage of work the
	 * server performed and frees nothing. Both branches are pinned here.
	 */
	const submitDuringPrewarm = async (
		abortPrewarmOnSubmit: boolean | undefined,
	): Promise<{ signal: AbortSignal; entries: SessionEntry[]; ledgerPrewarm: unknown }> => {
		let observedSignal: AbortSignal | null = null;
		let releaseRound: () => void = () => {};
		const roundEntered = new Promise<void>((resolve) => {
			releaseRound = resolve;
		});
		let finishRound: () => void = () => {};
		const roundHeld = new Promise<void>((resolve) => {
			finishRound = resolve;
		});
		const blockingPrewarm = (async (input: Parameters<typeof runPrewarmRound>[0]) => {
			observedSignal = input.signal ?? null;
			releaseRound();
			await roundHeld;
			return {
				aborted: input.signal?.aborted === true,
				usage: { input: 900, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 901, cost: {} },
				backend: null,
				timing: { ttftMs: null, apiMs: 3 },
				errorMessage: null,
			};
		}) as unknown as typeof runPrewarmRound;

		const entries: SessionEntry[] = [];
		const session = createSession(entries);
		session.create();
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers("local-native"),
			knownTargets: () => new Set(["test-target"]),
			session,
			readSessionEntries: () => entries,
			runPrewarm: blockingPrewarm,
			...(abortPrewarmOnSubmit === undefined ? {} : { abortPrewarmOnSubmit }),
			createAgent: createFakeAgentFactory(async (agent) => {
				const message = assistantTurn({ input: 10, cacheRead: 0 });
				agent.state.messages.push(message);
				await agent.emit({ type: "message_end", message });
				await agent.emit({ type: "agent_end", messages: [message] });
			}),
		} as never);

		await roundEntered;
		const signal = observedSignal as unknown as AbortSignal;
		ok(signal, "the round was handed a signal");
		strictEqual(signal.aborted, false, "the pre-warm starts un-aborted");

		const submit = loop.submit("the operator's turn");
		const abortedAtKeystroke = signal.aborted;
		finishRound();
		await submit;
		await loop.whenPrewarmSettled();
		const ledgerPrewarm = loop.contextLedger().prewarm;
		loop.dispose();
		return { signal: { aborted: abortedAtKeystroke } as AbortSignal, entries, ledgerPrewarm };
	};

	it("lets go of the pre-warm on submit without aborting a request the backend would finish anyway", async () => {
		const { signal, entries, ledgerPrewarm } = await submitDuringPrewarm(undefined);
		strictEqual(
			signal.aborted,
			false,
			"the measured backend finishes a cancelled prefill, so the request is not aborted",
		);
		const recorded = entries.filter((entry) => entry.kind === "custom" && entry.customType === "prewarm");
		strictEqual(recorded.length, 1, "the prefill the server performed is still recorded");
		const entry = recorded[0];
		ok(entry && entry.kind === "custom");
		strictEqual((entry.data as { detached?: boolean }).detached, true, "the round is marked as one the submit let go of");
		strictEqual(ledgerPrewarm, null, "a let-go round never claims the next turn's prefix is resident");
	});

	/**
	 * The seam brief 06 (#250) fills. Endpoint capacity has to see the pre-warm as
	 * one held request on the endpoint for exactly as long as the request is out,
	 * so the claim is taken before the round is sent and released in a finally.
	 */
	it("holds one endpoint slot for the duration of the round", async () => {
		const events: string[] = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers("local-native"),
			knownTargets: () => new Set(["test-target"]),
			registerPrewarmEndpointSlot: (runtime: { targetId: string }) => {
				events.push(`claim:${runtime.targetId}`);
				return () => events.push("release");
			},
			runPrewarm: (async () => {
				events.push("sent");
				throw new Error("the backend refused the pre-warm");
			}) as unknown as typeof runPrewarmRound,
			createAgent: createFakeAgentFactory(async () => {}),
		} as never);

		await loop.whenPrewarmSettled();
		deepStrictEqual(events, ["claim:test-target", "sent", "release"], "the slot is released even when the round throws");
		loop.dispose();
	});

	it("aborts the request on submit when the backend honors cancellation", async () => {
		const { signal, entries } = await submitDuringPrewarm(true);
		strictEqual(signal.aborted, true, "the keystroke aborts the pre-warm before admission");
		strictEqual(
			entries.filter((entry) => entry.kind === "custom" && entry.customType === "prewarm").length,
			1,
			"an aborted round still records what it spent",
		);
	});
});

// --- the regression the archive demands -------------------------------------

/**
 * A three-turn run on a fake local-native provider. `34_claude_code_quality_update.md`
 * records a cache optimization meant to run once on resume that ran every turn
 * and passed every review; the shape of that bug is a pre-warm that fires on a
 * turn boundary instead of a session boundary, so this counts the rounds
 * directly and watches the provider's cache reads for the collapse a spurious
 * request would cause.
 */
describe("contracts/session pre-warm runs once per session, not once per turn", () => {
	it("pre-warms before the first turn only, and cache reads do not fall across turns two and three", async () => {
		const entries: SessionEntry[] = [];
		const session = createSession(entries);
		session.create();
		const rounds: Array<{ systemPrompt: string; messages: ReadonlyArray<AgentMessage>; thinkingLevel: string }> = [];
		// A one-slot prefix cache: the server keeps the last request's messages and
		// serves the common prefix from cache. A pre-warm between turns can only
		// lower the next turn's cache reads if it sent a different prefix.
		let slot: string[] = [];
		const chargeAgainstSlot = (messages: ReadonlyArray<AgentMessage>): { input: number; cacheRead: number } => {
			const request = messages.map((message) => JSON.stringify(message));
			let shared = 0;
			while (shared < request.length && shared < slot.length && request[shared] === slot[shared]) shared += 1;
			slot = request;
			return { cacheRead: shared * 10, input: (request.length - shared) * 10 };
		};

		const promptsSeen: number[] = [];
		const loop = createChatLoop({
			getSettings: () => settings(),
			providers: providers("local-native"),
			knownTargets: () => new Set(["test-target"]),
			session,
			readSessionEntries: () => entries,
			runPrewarm: (async (input: Parameters<typeof runPrewarmRound>[0]) => {
				rounds.push({
					systemPrompt: input.state.systemPrompt,
					messages: [...input.state.messages],
					thinkingLevel: input.state.thinkingLevel,
				});
				const usage = chargeAgainstSlot([
					...input.state.messages,
					{ role: "user", content: [{ type: "text", text: PREWARM_USER_TEXT }] } as unknown as AgentMessage,
				]);
				return {
					aborted: false,
					usage: { ...usage, output: 1, cacheWrite: 0, totalTokens: usage.input + usage.cacheRead + 1, cost: {} },
					backend: null,
					timing: { ttftMs: 1, apiMs: 2 },
					errorMessage: null,
				};
			}) as unknown as typeof runPrewarmRound,
			createAgent: createFakeAgentFactory(async (agent, text) => {
				agent.state.messages.push({
					role: "user",
					content: [{ type: "text", text }],
					timestamp: 0,
				} as unknown as AgentMessage);
				promptsSeen.push(rounds.length);
				const usage = chargeAgainstSlot(agent.state.messages);
				const message = assistantTurn(usage);
				agent.state.messages.push(message);
				await agent.emit({ type: "message_end", message });
				await agent.emit({ type: "agent_end", messages: [message] });
			}),
		} as never);

		await loop.whenPrewarmSettled();
		strictEqual(rounds.length, 1, "one pre-warm before the first turn");

		await loop.submit("turn one");
		await loop.submit("turn two");
		await loop.submit("turn three");
		await loop.whenPrewarmSettled();

		strictEqual(rounds.length, 1, "no further pre-warm ran between the turns");
		deepStrictEqual(promptsSeen, [1, 1, 1], "every turn saw the same single pre-warm behind it");
		strictEqual(
			entries.filter((entry) => entry.kind === "custom" && entry.customType === "prewarm").length,
			1,
			"one pre-warm ledger entry for the session",
		);

		const cacheReads = entries
			.filter(
				(entry): entry is Extract<SessionEntry, { kind: "message" }> =>
					entry.kind === "message" && entry.role === "assistant",
			)
			.map((entry) => (entry.payload as { promptCache?: { cacheRead?: number } }).promptCache?.cacheRead ?? 0);
		strictEqual(cacheReads.length, 3, "three settled turns");
		const [, second, third] = cacheReads;
		ok(second !== undefined && third !== undefined);
		ok(second >= (cacheReads[0] ?? 0), `turn two's cache reads did not fall: ${second}`);
		ok(third >= second, `turn three's cache reads did not fall: ${third} < ${second}`);
		loop.dispose();
	});
});
