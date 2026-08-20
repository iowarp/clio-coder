import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { SessionContract, SessionEntryInput, SessionMeta, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { type ChatLoop, type ChatLoopEvent, createChatLoop } from "../../src/interactive/chat-loop.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const strip = (s: string): string => s.replace(ANSI, "");
const SETTLE_MARKER = "no result: the call did not complete";

// --- Minimal chat-loop harness (mirrors tests/contracts/chat-loop.test.ts). ---

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

function createFakeAgentFactory(promptImpl: (agent: FakeAgent, input: AgentMessage | AgentMessage[]) => Promise<void>) {
	return ((options: { initialState?: { messages?: AgentMessage[] } } = {}) => {
		const listeners: Array<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void> = [];
		const state = {
			systemPrompt: "",
			model: undefined as unknown,
			thinkingLevel: "off",
			tools: [] as unknown[],
			messages: options.initialState?.messages ?? [],
			errorMessage: undefined as string | undefined,
		};
		const controller = new AbortController();
		const agent: FakeAgent = {
			state,
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

function inputMessages(input: AgentMessage | AgentMessage[]): AgentMessage[] {
	return Array.isArray(input) ? input : [input];
}

const openTool = async (agent: FakeAgent): Promise<void> => {
	await agent.emit({
		type: "tool_execution_start",
		toolCallId: "c1",
		toolName: "bash",
		args: { command: "ls" },
	} as never);
};

const abortedMessage = (): AgentMessage =>
	({
		role: "assistant",
		content: [],
		stopReason: "aborted",
		errorMessage: "Request was aborted.",
		timestamp: Date.now(),
	}) as unknown as AgentMessage;

interface PathResult {
	agentEndCount: number;
	panelText: string;
	entries: SessionEntry[];
}

/**
 * Drive one termination path through the real chat-loop wired to a real
 * chat-panel. The fake agent's `abort()` is a no-op (like the unit harness), so
 * each path's `promptImpl` emits the terminal `agent_end` that pi-agent-core's
 * `handleRunFailure` delivers on the real abort path. Returns the forwarded
 * agent_end count and the settled panel render.
 */
async function drivePath(
	promptImpl: (agent: FakeAgent, input: AgentMessage | AgentMessage[], loop: ChatLoop) => Promise<void>,
): Promise<PathResult> {
	const bus = createSafeEventBus();
	const entries: SessionEntry[] = [];
	const session = createSession(entries);
	const panel = createChatPanel();
	let agentEndCount = 0;
	const holder: { loop?: ChatLoop } = {};
	const loop = createChatLoop({
		getSettings: () => settings(),
		providers: providers(),
		knownTargets: () => new Set(["test-target"]),
		session,
		readSessionEntries: () => entries,
		bus,
		createAgent: createFakeAgentFactory(async (agent, input) => {
			// biome-ignore lint/style/noNonNullAssertion: holder.loop is set below before submit.
			await promptImpl(agent, input, holder.loop!);
		}),
	} as never);
	holder.loop = loop;
	loop.onEvent((event: ChatLoopEvent) => {
		if (event.type === "agent_end") agentEndCount += 1;
		panel.applyEvent(event);
	});

	await loop.submit("go");

	return { agentEndCount, panelText: strip(panel.render(120).join("\n")), entries };
}

describe("chat-panel agent_end settles open tool segments (S3 Part B mechanism)", () => {
	it("an agent_end settles a tool segment whose tool_execution_end never arrived", () => {
		const panel = createChatPanel();
		panel.applyEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
		ok(!strip(panel.render(120).join("\n")).includes(SETTLE_MARKER), "segment is still running before agent_end");
		panel.applyEvent({ type: "agent_end", messages: [] });
		ok(strip(panel.render(120).join("\n")).includes(SETTLE_MARKER), "agent_end settled the unfinished segment");
	});

	it("a properly finished tool segment is not clobbered by a later agent_end", () => {
		const panel = createChatPanel();
		panel.applyEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
		panel.applyEvent({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "listing output" }] },
			isError: false,
		} as ChatLoopEvent);
		panel.applyEvent({ type: "agent_end", messages: [] });
		const rendered = strip(panel.render(120).join("\n"));
		ok(rendered.includes("listing output"), "the real result survives");
		ok(!rendered.includes(SETTLE_MARKER), "a finished segment is never re-settled as incomplete");
	});
});

describe("chat-loop agent_end invariant across termination paths (S3 Part B)", () => {
	it("normal completion delivers agent_end and settles an open tool segment", async () => {
		const result = await drivePath(async (agent, input) => {
			agent.state.messages.push(...inputMessages(input));
			await openTool(agent);
			const msg = {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
				timestamp: Date.now(),
			} as unknown as AgentMessage;
			await agent.emit({ type: "message_end", message: msg });
			await agent.emit({ type: "agent_end", messages: [msg] });
		});
		ok(result.agentEndCount >= 1, "at least one terminal agent_end");
		ok(result.panelText.includes(SETTLE_MARKER), "the open segment is settled");
	});

	it("a provider error delivers agent_end and settles an open tool segment", async () => {
		const result = await drivePath(async (agent, input) => {
			agent.state.messages.push(...inputMessages(input));
			await openTool(agent);
			const err = {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "provider exploded",
				timestamp: Date.now(),
			} as unknown as AgentMessage;
			agent.state.messages.push(err);
			await agent.emit({ type: "message_end", message: err });
			await agent.emit({ type: "agent_end", messages: [err] });
		});
		ok(result.agentEndCount >= 1, "provider error still delivers a terminal agent_end");
		ok(result.panelText.includes(SETTLE_MARKER), "the open segment is settled");
	});

	it("an operator abort (bare cancel) settles an open tool segment", async () => {
		const result = await drivePath(async (agent, input, loop) => {
			agent.state.messages.push(...inputMessages(input));
			await openTool(agent);
			// Bare cancel: the loop synthesizes an agent_end via emitNotice; the
			// real agent then also delivers an abort-driven agent_end. Both settle.
			loop.cancel();
			const aborted = abortedMessage();
			agent.state.messages.push(aborted);
			await agent.emit({ type: "message_end", message: aborted });
			await agent.emit({ type: "agent_end", messages: [aborted] });
		});
		ok(result.agentEndCount >= 1, "a bare cancel never strands the turn without an agent_end");
		ok(result.panelText.includes(SETTLE_MARKER), "the open segment is settled");
	});

	it("a loop-guard stop delivers exactly one agent_end and settles an open tool segment", async () => {
		const REASON = "[Clio Coder] loop guard stopped this turn: bash was called with identical arguments 3 times.";
		const result = await drivePath(async (agent, input, loop) => {
			agent.state.messages.push(...inputMessages(input));
			await openTool(agent);
			// Loop-guard stop: cancel-with-reason emits only the closing message_end;
			// the terminal agent_end comes solely from the abort (proven against
			// pi-agent-core's handleRunFailure). Exactly one agent_end reaches the
			// panel because the empty aborted message_end is suppressed.
			loop.cancel({ reason: REASON, source: "loop_guard", auditReason: "loop: bash repeated 3x" });
			const aborted = abortedMessage();
			agent.state.messages.push(aborted);
			await agent.emit({ type: "message_end", message: aborted });
			await agent.emit({ type: "agent_end", messages: [aborted] });
		});
		strictEqual(result.agentEndCount, 1, "loop-guard stop forwards exactly one terminal agent_end");
		ok(result.panelText.includes(SETTLE_MARKER), "the open segment is settled");
	});

	it("a loop-guard lockout finishes normally and settles a tool blocked mid-turn", async () => {
		const result = await drivePath(async (agent, input) => {
			agent.state.messages.push(...inputMessages(input));
			await openTool(agent);
			// Lockout disables further tools but the turn runs to a normal agent_end.
			const msg = {
				role: "assistant",
				content: [{ type: "text", text: "answering from what I already gathered" }],
				stopReason: "stop",
				timestamp: Date.now(),
			} as unknown as AgentMessage;
			await agent.emit({ type: "message_end", message: msg });
			await agent.emit({ type: "agent_end", messages: [msg] });
		});
		strictEqual(result.agentEndCount, 1, "a lockout leaves exactly one terminal agent_end");
		ok(result.panelText.includes(SETTLE_MARKER), "the blocked segment is settled");
	});

	it("a permission-cancel resolves the tool as a clean rejection (no stranded segment)", async () => {
		const result = await drivePath(async (agent, input) => {
			agent.state.messages.push(...inputMessages(input));
			await openTool(agent);
			// cancelParkedCalls resolves the parked tool with a blocked verdict, so
			// pi-agent-core emits tool_execution_end and the run reaches a normal
			// agent_end; the segment finishes cleanly, never stranded.
			await agent.emit({
				type: "tool_execution_end",
				toolCallId: "c1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "User cancelled this tool call from the prompt" }] },
				isError: true,
			} as never);
			const msg = {
				role: "assistant",
				content: [{ type: "text", text: "understood, standing by" }],
				stopReason: "stop",
				timestamp: Date.now(),
			} as unknown as AgentMessage;
			await agent.emit({ type: "message_end", message: msg });
			await agent.emit({ type: "agent_end", messages: [msg] });
		});
		strictEqual(result.agentEndCount, 1, "the run reaches exactly one terminal agent_end");
		ok(result.panelText.includes("User cancelled this tool call"), "the blocked result renders");
		ok(!result.panelText.includes(SETTLE_MARKER), "a cleanly rejected tool is not settled as incomplete");
	});
});
