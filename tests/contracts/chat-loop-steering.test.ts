import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { EndpointStatus, ProvidersContract } from "../../src/domains/providers/contract.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { EndpointDescriptor } from "../../src/domains/providers/types/endpoint-descriptor.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { SessionContract, SessionEntryInput, SessionMeta, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { type ChatLoopEvent, createChatLoop, type QueuedChatMessage } from "../../src/interactive/chat-loop.js";

function settings(): ClioSettings {
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
	return value;
}

function providers(): ProvidersContract {
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
		switchTurn: () => current as SessionMeta,
		editLabel: () => {},
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
			abort() {},
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
	return { prompts: [], steered: [], followedUp: [], clearSteeringCalls: 0, clearAllCalls: 0 };
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

function createLoop(log: SteeringHarnessLog, promptImpl: Parameters<typeof createSteeringAgentFactory>[1]) {
	const entries: SessionEntry[] = [];
	return createChatLoop({
		getSettings: () => settings(),
		providers: providers(),
		knownEndpoints: () => new Set(["test-target"]),
		session: createSession(entries),
		readSessionEntries: () => entries,
		createAgent: createSteeringAgentFactory(log, promptImpl),
	} as never);
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
		loop.onEvent((event: ChatLoopEvent) => {
			if (event.type === "queue_update") queueEvents.push(event.messages);
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

		runGate.release();
		await firstRun;
		deepStrictEqual(loop.queuedMessages(), { steer: [], followUp: [] });
		deepStrictEqual(queueEvents.at(-1), [], "mirror empties when the engine injects the steer");
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

		const firstRun = loop.submit("start");
		await settle();
		strictEqual(loop.queueFollowUp("and then summarize"), true);
		strictEqual(log.followedUp.length, 1, "alt+enter must ride the follow-up queue");
		strictEqual(log.steered.length, 0);
		deepStrictEqual(loop.queuedMessages(), { steer: [], followUp: ["and then summarize"] });

		runGate.release();
		await firstRun;
		deepStrictEqual(loop.queuedMessages(), { steer: [], followUp: [] });
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

		const firstRun = loop.submit("start");
		await settle();
		await loop.submit("too late correction");
		strictEqual(log.steered.length, 1);

		runGate.release();
		await firstRun;
		strictEqual(log.prompts.length, 2, "stranded steer must resubmit as a fresh prompt");
		ok(log.prompts[1]?.includes("too late correction"), `second prompt carries the steer text: ${log.prompts[1]}`);
		ok(log.clearSteeringCalls >= 1, "the engine steering queue is cleared before the resubmit");
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
});
