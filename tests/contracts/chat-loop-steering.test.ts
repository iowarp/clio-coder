import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { SessionContract, SessionEntryInput, SessionMeta, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { type ChatLoopEvent, createChatLoop, type QueuedChatMessage } from "../../src/interactive/chat-loop.js";

function settings(): ClioSettings {
	const value = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	value.orchestrator.target = "test-target";
	value.orchestrator.model = "model";
	value.targets = [
		{
			id: "test-target",
			runtime: "fake-runtime",
			defaultModel: "model",
			capabilities: { contextWindow: 1000, maxTokens: 256, tools: true, chat: true },
		},
	];
	return value;
}

function providers(): ProvidersContract {
	const target: TargetDescriptor = {
		id: "test-target",
		runtime: "fake-runtime",
		defaultModel: "model",
		capabilities: { contextWindow: 1000, maxTokens: 256, tools: true, chat: true },
	};
	const runtime: RuntimeDescriptor = {
		id: "fake-runtime",
		displayName: "Fake Runtime",
		kind: "http",
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
		setName: () => {},
		deleteSession: () => {},
		history: () => (current ? [current] : []),
		close: async () => {
			current = null;
		},
	};
}

/**
 * Fake engine agent that records queue calls and lets each test script the
 * run via `promptImpl`. Mirrors the engine surface chat-loop touches: steer,
 * followUp, clearSteeringQueue, clearFollowUpQueue, clearAllQueues, abort.
 */
interface SteeringFakeAgent {
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
	steer(message: AgentMessage): void;
	followUp(message: AgentMessage): void;
	abort(): void;
	clearSteeringQueue(): void;
	clearFollowUpQueue(): void;
	clearAllQueues(): void;
}

interface SteeringHarnessLog {
	prompts: string[];
	steered: AgentMessage[];
	followedUp: AgentMessage[];
	clearSteeringCalls: number;
	clearAllCalls: number;
	abortCalls: number;
	/** Fired on every `agent.abort()`; a test scripts the aborted run's settlement here. */
	onAbort?: () => void;
}

function createSteeringAgentFactory(
	log: SteeringHarnessLog,
	promptImpl: (agent: SteeringFakeAgent, input: string, call: number) => Promise<void>,
) {
	return ((options: { initialState?: { messages?: AgentMessage[] } } = {}) => {
		const listeners: Array<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void> = [];
		const controller = new AbortController();
		const agent: SteeringFakeAgent = {
			state: {
				systemPrompt: "",
				model: undefined,
				thinkingLevel: "off",
				tools: [],
				messages: options.initialState?.messages ?? [],
				errorMessage: undefined,
			},
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
				log.prompts.push(input);
				await promptImpl(agent, input, log.prompts.length);
			},
			steer(message: AgentMessage) {
				log.steered.push(message);
			},
			followUp(message: AgentMessage) {
				log.followedUp.push(message);
			},
			abort() {
				log.abortCalls += 1;
				log.onAbort?.();
			},
			clearSteeringQueue() {
				log.clearSteeringCalls += 1;
				log.steered.length = 0;
			},
			clearFollowUpQueue() {
				log.followedUp.length = 0;
			},
			clearAllQueues() {
				log.clearAllCalls += 1;
				log.steered.length = 0;
				log.followedUp.length = 0;
			},
		};
		return { agent, state: () => agent.state };
	}) as never;
}

function emptyLog(): SteeringHarnessLog {
	return { prompts: [], steered: [], followedUp: [], clearSteeringCalls: 0, clearAllCalls: 0, abortCalls: 0 };
}

function assistantDone(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

interface Gate {
	wait: Promise<void>;
	release: () => void;
}

function gate(): Gate {
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { wait, release };
}

interface LoopGuards {
	hasParkedCalls?: () => boolean;
	hasAttachedDispatch?: () => boolean;
}

function createLoop(
	log: SteeringHarnessLog,
	promptImpl: Parameters<typeof createSteeringAgentFactory>[1],
	guards: LoopGuards = {},
) {
	const entries: SessionEntry[] = [];
	// The interrupt guards read only `hasParkedCalls` off the registry; the
	// tool-surface resolution the loop also performs sees an empty registry.
	const toolRegistry = guards.hasParkedCalls
		? { hasParkedCalls: guards.hasParkedCalls, listRegistered: () => [], get: () => undefined }
		: undefined;
	return createChatLoop({
		getSettings: () => settings(),
		providers: providers(),
		knownTargets: () => new Set(["test-target"]),
		session: createSession(entries),
		readSessionEntries: () => entries,
		createAgent: createSteeringAgentFactory(log, promptImpl),
		...(toolRegistry ? { toolRegistry } : {}),
		...(guards.hasAttachedDispatch ? { hasAttachedDispatch: guards.hasAttachedDispatch } : {}),
	} as never);
}

function abortedMessage(): AgentMessage {
	return {
		role: "assistant",
		content: [],
		stopReason: "aborted",
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

/**
 * A first run that blocks until it is aborted, then settles as an aborted
 * message; every later run completes immediately. Interrupt tests script the
 * engine this way so the cancel → settle → submit order is observable.
 */
function abortableFirstRun(log: SteeringHarnessLog): Parameters<typeof createSteeringAgentFactory>[1] {
	const abortGate = gate();
	log.onAbort = () => abortGate.release();
	return async (agent, _input, call) => {
		if (call > 1) {
			const done = assistantDone("done");
			await agent.emit({ type: "message_end", message: done });
			await agent.emit({ type: "agent_end", messages: [done] });
			return;
		}
		await abortGate.wait;
		await agent.emit({ type: "agent_end", messages: [abortedMessage()] });
	};
}

describe("contracts/chat-loop steering queue routing", () => {
	it("routes Enter-while-streaming to agent.steer and dequeues the mirror when the engine injects it", async () => {
		const log = emptyLog();
		const runGate = gate();
		const loop = createLoop(log, async (agent, _input, call) => {
			if (call > 1) return;
			await runGate.wait;
			// Engine-style drain: the steered message enters the transcript via
			// message_start/message_end before the next assistant response.
			for (const message of [...log.steered]) {
				await agent.emit({ type: "message_start", message });
				await agent.emit({ type: "message_end", message });
			}
			const done = assistantDone("pivoted");
			await agent.emit({ type: "message_end", message: done });
			await agent.emit({ type: "agent_end", messages: [done] });
		});
		const queueEvents: QueuedChatMessage[][] = [];
		const injectedTurns: Array<{ text: string; kind: string }> = [];
		loop.onEvent((event: ChatLoopEvent) => {
			if (event.type === "queue_update") queueEvents.push(event.messages);
			if (event.type === "queued_user_turn") injectedTurns.push({ text: event.text, kind: event.kind });
		});

		const firstRun = loop.submit("start a long task");
		await settle();
		strictEqual(loop.isStreaming(), true);

		await loop.submit("actually only list directories");
		strictEqual(log.steered.length, 1, "Enter while streaming must ride the steering queue");
		strictEqual(log.followedUp.length, 0);
		deepStrictEqual(loop.queuedMessages(), {
			steer: ["actually only list directories"],
			followUp: [],
		});
		deepStrictEqual(queueEvents.at(-1), [{ text: "actually only list directories", kind: "steer" }]);
		deepStrictEqual(injectedTurns, [], "enqueue must not render a transcript turn yet");

		runGate.release();
		await firstRun;
		deepStrictEqual(loop.queuedMessages(), { steer: [], followUp: [] });
		deepStrictEqual(queueEvents.at(-1), [], "mirror empties when the engine injects the steer");
		deepStrictEqual(
			injectedTurns,
			[{ text: "actually only list directories", kind: "steer" }],
			"the transcript turn renders exactly at injection",
		);
		strictEqual(log.prompts.length, 1, "a consumed steer must not resubmit");
	});

	it("keeps alt+enter (queueFollowUp) on the follow-up queue", async () => {
		const log = emptyLog();
		const runGate = gate();
		const loop = createLoop(log, async (agent, _input, call) => {
			if (call > 1) return;
			await runGate.wait;
			for (const message of [...log.followedUp]) {
				await agent.emit({ type: "message_start", message });
				await agent.emit({ type: "message_end", message });
			}
			const done = assistantDone("done");
			await agent.emit({ type: "message_end", message: done });
			await agent.emit({ type: "agent_end", messages: [done] });
		});

		const injectedTurns: Array<{ text: string; kind: string }> = [];
		loop.onEvent((event: ChatLoopEvent) => {
			if (event.type === "queued_user_turn") injectedTurns.push({ text: event.text, kind: event.kind });
		});

		const firstRun = loop.submit("start");
		await settle();
		strictEqual(loop.queueFollowUp("and then summarize"), true);
		strictEqual(log.followedUp.length, 1, "alt+enter must ride the follow-up queue");
		strictEqual(log.steered.length, 0);
		deepStrictEqual(loop.queuedMessages(), { steer: [], followUp: ["and then summarize"] });
		deepStrictEqual(injectedTurns, [], "a queued follow-up must not render before injection");

		runGate.release();
		await firstRun;
		deepStrictEqual(loop.queuedMessages(), { steer: [], followUp: [] });
		deepStrictEqual(
			injectedTurns,
			[{ text: "and then summarize", kind: "follow-up" }],
			"the follow-up renders as a user turn when the engine injects it",
		);
	});

	it("resubmits a stranded steer as a fresh prompt when the run ends without draining it", async () => {
		const log = emptyLog();
		const runGate = gate();
		const loop = createLoop(log, async (agent, _input, call) => {
			if (call === 1) {
				await runGate.wait;
				// The run ends WITHOUT draining the steering queue: the engine
				// outer loop polls only follow-ups before agent_end.
				const done = assistantDone("finished before the steer landed");
				await agent.emit({ type: "message_end", message: done });
				await agent.emit({ type: "agent_end", messages: [done] });
				return;
			}
			const done = assistantDone("resubmitted run");
			await agent.emit({ type: "message_end", message: done });
			await agent.emit({ type: "agent_end", messages: [done] });
		});

		const injectedTurns: Array<{ text: string; kind: string }> = [];
		loop.onEvent((event: ChatLoopEvent) => {
			if (event.type === "queued_user_turn") injectedTurns.push({ text: event.text, kind: event.kind });
		});

		const firstRun = loop.submit("start");
		await settle();
		await loop.submit("too late correction");
		strictEqual(log.steered.length, 1);

		runGate.release();
		await firstRun;
		strictEqual(log.prompts.length, 2, "stranded steer must resubmit as a fresh prompt");
		ok(log.prompts[1]?.includes("too late correction"), `second prompt carries the steer text: ${log.prompts[1]}`);
		ok(log.clearSteeringCalls >= 1, "the engine steering queue is cleared before the resubmit");
		deepStrictEqual(
			injectedTurns,
			[{ text: "too late correction", kind: "steer" }],
			"the resubmitted steer renders exactly one transcript turn",
		);
		deepStrictEqual(loop.queuedMessages(), { steer: [], followUp: [] });
	});

	it("clears both queues on cancel so a cancelled run neither delivers nor resubmits", async () => {
		const log = emptyLog();
		const runGate = gate();
		const loop = createLoop(log, async (agent, _input, call) => {
			if (call > 1) return;
			await runGate.wait;
			const aborted = {
				role: "assistant",
				content: [],
				stopReason: "aborted",
				timestamp: Date.now(),
			} as unknown as AgentMessage;
			await agent.emit({ type: "agent_end", messages: [aborted] });
		});

		const injectedTurns: string[] = [];
		loop.onEvent((event: ChatLoopEvent) => {
			if (event.type === "queued_user_turn") injectedTurns.push(event.text);
		});

		const firstRun = loop.submit("start");
		await settle();
		await loop.submit("steer me");
		loop.queueFollowUp("follow up later");
		deepStrictEqual(loop.queuedMessages(), { steer: ["steer me"], followUp: ["follow up later"] });

		loop.cancel();
		strictEqual(log.clearAllCalls, 1, "cancel must clear both engine queues");
		deepStrictEqual(loop.queuedMessages(), { steer: [], followUp: [] });

		runGate.release();
		await firstRun;
		strictEqual(log.prompts.length, 1, "a cancelled steer must not resubmit");
		deepStrictEqual(injectedTurns, [], "a cancelled queue must not render transcript turns");
	});

	it("restores both kinds to the editor via clearQueuedFollowUps in enqueue order", async () => {
		const log = emptyLog();
		const runGate = gate();
		const loop = createLoop(log, async (agent, _input, call) => {
			if (call > 1) return;
			await runGate.wait;
			const done = assistantDone("done");
			await agent.emit({ type: "agent_end", messages: [done] });
		});

		const firstRun = loop.submit("start");
		await settle();
		await loop.submit("first correction");
		loop.queueFollowUp("then this");
		await loop.submit("second correction");

		const restored = loop.clearQueuedFollowUps();
		deepStrictEqual(restored, ["first correction", "then this", "second correction"]);
		strictEqual(log.clearAllCalls, 1);
		deepStrictEqual(loop.queuedMessages(), { steer: [], followUp: [] });

		runGate.release();
		await firstRun;
		strictEqual(log.prompts.length, 1, "restored steers must not resubmit");
	});

	it("steers with a plain user message: no reminder framing, no double-injection", async () => {
		const log = emptyLog();
		const runGate = gate();
		const loop = createLoop(log, async (agent, _input, call) => {
			if (call > 1) return;
			await runGate.wait;
			for (const message of [...log.steered]) {
				await agent.emit({ type: "message_start", message });
				await agent.emit({ type: "message_end", message });
			}
			const done = assistantDone("done");
			await agent.emit({ type: "message_end", message: done });
			await agent.emit({ type: "agent_end", messages: [done] });
		});

		const firstRun = loop.submit("start");
		await settle();
		await loop.submit("pivot now");
		const steerMessage = log.steered[0] as { role?: string; content?: unknown } | undefined;
		strictEqual(steerMessage?.role, "user");
		strictEqual(steerMessage?.content, "pivot now", "steer text must not be wrapped in system-reminder framing");

		runGate.release();
		await firstRun;
	});

	it("allows programmatic steering of the loop", async () => {
		const log = emptyLog();
		const runGate = gate();
		const loop = createLoop(log, async (agent, _input, call) => {
			if (call > 1) return;
			await runGate.wait;
			for (const message of [...log.steered]) {
				await agent.emit({ type: "message_start", message });
				await agent.emit({ type: "message_end", message });
			}
			const done = assistantDone("pivoted");
			await agent.emit({ type: "message_end", message: done });
			await agent.emit({ type: "agent_end", messages: [done] });
		});

		const firstRun = loop.submit("start a long task");
		await settle();
		strictEqual(loop.isStreaming(), true);

		const steered = loop.steer("programmatic correction");
		strictEqual(steered, true);
		strictEqual(log.steered.length, 1, "programmatic steer must ride the steering queue");
		deepStrictEqual(loop.queuedMessages(), {
			steer: ["programmatic correction"],
			followUp: [],
		});

		runGate.release();
		await firstRun;
		deepStrictEqual(loop.queuedMessages(), { steer: [], followUp: [] });
	});
});

describe("contracts/chat-loop steering modes (issue #89)", () => {
	it("defaults Enter-while-streaming to next slot and honors end-of-turn through submit", async () => {
		const log = emptyLog();
		const runGate = gate();
		const loop = createLoop(log, async (agent, _input, call) => {
			if (call > 1) return;
			await runGate.wait;
			const done = assistantDone("done");
			await agent.emit({ type: "agent_end", messages: [done] });
		});

		const firstRun = loop.submit("start");
		await settle();
		await loop.submit("mid-run correction");
		await loop.submit("after you finish", { steering: "end-of-turn" });
		await loop.submit("explicit next slot", { steering: "next-slot" });
		deepStrictEqual(loop.queuedMessages(), {
			steer: ["mid-run correction", "explicit next slot"],
			followUp: ["after you finish"],
		});
		strictEqual(log.steered.length, 2, "next-slot rides the engine steering queue");
		strictEqual(log.followedUp.length, 1, "end-of-turn rides the engine follow-up queue");
		strictEqual(log.abortCalls, 0, "neither queued mode touches the run");

		runGate.release();
		await firstRun;
	});

	it("interrupt cancels the run, waits for it to settle, then submits the message as a fresh prompt", async () => {
		const log = emptyLog();
		const loop = createLoop(log, abortableFirstRun(log));
		const order: string[] = [];
		loop.onEvent((event: ChatLoopEvent) => {
			if (event.type === "notice" && event.text.includes("interrupt")) order.push(`notice:${event.text}`);
			if (event.type === "queued_user_turn") order.push(`user:${event.kind}:${event.text}`);
		});

		const firstRun = loop.submit("start a long task");
		await settle();
		strictEqual(loop.isStreaming(), true);
		strictEqual(loop.interruptRefusal(), null, "nothing parked, nothing attached: interrupt is allowed");

		await loop.submit("stop, read this now", { steering: "interrupt" });
		await firstRun;

		strictEqual(log.abortCalls, 1, "interrupt aborts the in-flight run");
		deepStrictEqual(log.prompts, ["start a long task", "stop, read this now"], "the message lands as a fresh prompt");
		deepStrictEqual(log.steered, [], "an interrupt never enters the steering queue");
		strictEqual(loop.isStreaming(), false);
		deepStrictEqual(order, [
			"notice:[Clio Coder] run interrupted by operator; delivering the new message now.",
			"user:interrupt:stop, read this now",
		]);
	});

	it("interrupt clears queued steers and follow-ups with the cancelled run", async () => {
		const log = emptyLog();
		const loop = createLoop(log, abortableFirstRun(log));

		const firstRun = loop.submit("start");
		await settle();
		await loop.submit("earlier correction");
		loop.queueFollowUp("earlier follow-up");
		await loop.submit("now", { steering: "interrupt" });
		await firstRun;

		strictEqual(log.clearAllCalls, 1, "the cancel drains both engine queues before the abort settles");
		deepStrictEqual(loop.queuedMessages(), { steer: [], followUp: [] });
		deepStrictEqual(
			log.prompts,
			["start", "now"],
			"queued texts do not resubmit; the caller restores them to the editor",
		);
	});

	it("refuses interrupt while a permission ask is parked and falls back to next slot, saying so", async () => {
		const log = emptyLog();
		const runGate = gate();
		let parked = true;
		const loop = createLoop(
			log,
			async (agent, _input, call) => {
				if (call > 1) return;
				await runGate.wait;
				await agent.emit({ type: "agent_end", messages: [assistantDone("done")] });
			},
			{ hasParkedCalls: () => parked },
		);
		const notices: string[] = [];
		loop.onEvent((event: ChatLoopEvent) => {
			// The harness target is deliberately tiny, so the first submit also emits
			// a context-window advisory; only the interrupt notice is under test.
			if (event.type === "notice" && event.text.includes("interrupt")) notices.push(`${event.level}:${event.text}`);
		});

		const firstRun = loop.submit("start");
		await settle();
		ok(loop.interruptRefusal()?.includes("permission ask is parked"));

		await loop.submit("answer differently", { steering: "interrupt" });
		strictEqual(log.abortCalls, 0, "a parked ask is already waiting on the operator; nothing is cancelled");
		deepStrictEqual(loop.queuedMessages(), { steer: ["answer differently"], followUp: [] });
		strictEqual(notices.length, 1);
		ok(notices[0]?.startsWith("warning:[Clio Coder] interrupt refused: a permission ask is parked"), notices[0]);
		ok(notices[0]?.endsWith("Queued for the next slot instead."), notices[0]);

		parked = false;
		strictEqual(loop.interruptRefusal(), null, "the refusal lifts as soon as the ask is answered");
		runGate.release();
		await firstRun;
	});

	it("refuses interrupt while an attached dispatch is running and falls back to next slot, saying so", async () => {
		const log = emptyLog();
		const runGate = gate();
		const loop = createLoop(
			log,
			async (agent, _input, call) => {
				if (call > 1) return;
				await runGate.wait;
				await agent.emit({ type: "agent_end", messages: [assistantDone("done")] });
			},
			{ hasAttachedDispatch: () => true },
		);
		const notices: string[] = [];
		loop.onEvent((event: ChatLoopEvent) => {
			// The harness target is deliberately tiny, so the first submit also emits
			// a context-window advisory; only the interrupt notice is under test.
			if (event.type === "notice" && event.text.includes("interrupt")) notices.push(`${event.level}:${event.text}`);
		});

		const firstRun = loop.submit("start");
		await settle();
		ok(loop.interruptRefusal()?.includes("attached dispatch is running"));

		await loop.submit("also check X", { steering: "interrupt" });
		strictEqual(log.abortCalls, 0, "the worker's run is not killed");
		deepStrictEqual(loop.queuedMessages(), { steer: ["also check X"], followUp: [] });
		strictEqual(notices.length, 1);
		ok(notices[0]?.startsWith("warning:[Clio Coder] interrupt refused: an attached dispatch is running"), notices[0]);
		ok(notices[0]?.includes("@<agent>"), "the notice names the explicit steer route");

		runGate.release();
		await firstRun;
	});

	it("interrupt while idle is a plain submit", async () => {
		const log = emptyLog();
		const loop = createLoop(log, async (agent) => {
			await agent.emit({ type: "agent_end", messages: [assistantDone("done")] });
		});
		strictEqual(loop.interruptRefusal(), null);
		await loop.submit("hello", { steering: "interrupt" });
		deepStrictEqual(log.prompts, ["hello"]);
		strictEqual(log.abortCalls, 0);
	});
});
