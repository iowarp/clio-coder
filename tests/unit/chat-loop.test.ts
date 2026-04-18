import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ToolName } from "../../src/core/tool-names.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import type { ModeName } from "../../src/domains/modes/matrix.js";
import type { CompileForTurnInput, PromptsContract } from "../../src/domains/prompts/contract.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { ClioSessionMeta, ClioTurnRecord } from "../../src/engine/session.js";
import type { AgentEvent, AgentMessage, AgentState, Model } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";

// ---------------------------------------------------------------------------
// Stub builders
// ---------------------------------------------------------------------------

function buildSettings(overrides: Partial<ClioSettings> = {}): ClioSettings {
	const base = structuredClone(DEFAULT_SETTINGS);
	base.orchestrator = { provider: "anthropic", model: "claude-sonnet-4-6" };
	return { ...base, ...overrides };
}

function stubModel(): Model<never> {
	return {
		provider: "anthropic",
		id: "claude-sonnet-4-6",
		contextWindow: 200_000,
		maxTokens: 8_192,
		reasoning: false,
		input: 0,
		output: 0,
	} as unknown as Model<never>;
}

interface RecordingPrompts extends PromptsContract {
	calls: CompileForTurnInput[];
	hashesByMode: Map<string, string>;
}

function recordingPrompts(): RecordingPrompts {
	const calls: CompileForTurnInput[] = [];
	const hashesByMode = new Map<string, string>();
	return {
		compileForTurn(input) {
			calls.push(input);
			const mode = input.overrideMode ?? "default";
			const safety = input.safetyLevel ?? "auto-edit";
			const hash = `hash-${mode}-${safety}-${calls.length}`;
			hashesByMode.set(`${mode}|${safety}`, hash);
			return {
				text: `compiled-for-${mode}-${safety}`,
				staticCompositionHash: `static-${mode}-${safety}`,
				renderedPromptHash: hash,
				fragmentManifest: [],
				dynamicInputs: input.dynamicInputs,
			};
		},
		reload() {},
		calls,
		hashesByMode,
	};
}

function stubModes(initial: ModeName = "default"): ModesContract & { set: (m: ModeName) => void } {
	let current: ModeName = initial;
	return {
		current: () => current,
		setMode: (next) => {
			current = next;
			return current;
		},
		cycleNormal: () => current,
		visibleTools: () => new Set<ToolName>(),
		isToolVisible: () => true,
		isActionAllowed: () => true,
		requestSuper: () => {},
		confirmSuper: () => current,
		set: (m) => {
			current = m;
		},
	};
}

interface FakeAgent {
	state: Partial<AgentState> & { systemPrompt: string; tools: unknown[]; messages: unknown[] };
	subscribers: Array<(event: AgentEvent) => void>;
	subscribe(cb: (event: AgentEvent) => void): () => void;
	prompt(text: string): Promise<void>;
	abort(): void;
	sessionId?: string;
	promptCalls: string[];
}

function fakeAgent(initial: Partial<FakeAgent["state"]> = {}): FakeAgent {
	const state: FakeAgent["state"] = {
		systemPrompt: "",
		model: stubModel(),
		thinkingLevel: "off",
		tools: [],
		messages: [],
		...initial,
	} as FakeAgent["state"];
	const subscribers: Array<(event: AgentEvent) => void> = [];
	const promptCalls: string[] = [];
	return {
		state,
		subscribers,
		promptCalls,
		subscribe(cb) {
			subscribers.push(cb);
			return () => {};
		},
		async prompt(text: string): Promise<void> {
			promptCalls.push(text);
			const assistantMsg: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ack" }],
				stopReason: "stop",
				timestamp: Date.now(),
			} as AgentMessage;
			for (const cb of subscribers) {
				cb({ type: "message_end", message: assistantMsg } as unknown as AgentEvent);
				cb({ type: "agent_end", messages: [assistantMsg] } as unknown as AgentEvent);
			}
		},
		abort() {},
	};
}

interface RecordingSession {
	contract: SessionContract;
	appends: Array<{ kind: string; payload: unknown; renderedPromptHash?: string | undefined }>;
	meta: ClioSessionMeta;
}

function recordingSession(): RecordingSession {
	const meta: ClioSessionMeta = {
		id: "sess-1",
		cwd: "/tmp/clio",
		cwdHash: "h",
		createdAt: "2026-04-17T00:00:00.000Z",
		endedAt: null,
		model: null,
		provider: null,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.1.0",
		piMonoVersion: "0.67.4",
		platform: "linux",
		nodeVersion: "v20",
	};
	const appends: RecordingSession["appends"] = [];
	let counter = 0;
	const contract: SessionContract = {
		current: () => meta,
		create: () => meta,
		append: (input) => {
			counter++;
			const record: ClioTurnRecord = {
				id: `turn-${counter}`,
				parentId: input.parentId,
				at: "2026-04-17T00:00:01.000Z",
				kind: input.kind,
				payload: input.payload,
			};
			const recorded: RecordingSession["appends"][number] = {
				kind: input.kind,
				payload: input.payload,
			};
			if (input.renderedPromptHash !== undefined) {
				record.renderedPromptHash = input.renderedPromptHash;
				recorded.renderedPromptHash = input.renderedPromptHash;
			}
			appends.push(recorded);
			return record;
		},
		appendEntry: (entry) =>
			({
				...entry,
				turnId: entry.turnId ?? "entry",
				timestamp: entry.timestamp ?? "2026-04-17T00:00:02.000Z",
			}) as unknown as SessionEntry,
		checkpoint: async () => {},
		resume: () => meta,
		fork: () => meta,
		tree: () => ({
			sessionId: meta.id,
			meta: {
				id: meta.id,
				cwd: meta.cwd,
				createdAt: meta.createdAt,
				endedAt: meta.endedAt,
				model: meta.model,
				provider: meta.provider,
			},
			leafId: null,
			rootIds: [],
			nodesById: {},
		}),
		switchBranch: () => meta,
		editLabel: () => {},
		deleteSession: () => {},
		history: () => [],
		close: async () => {},
	};
	return { contract, appends, meta };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("interactive/chat-loop prompt compilation", () => {
	it("writes compiled systemPrompt to agent state on first submit", async () => {
		const prompts = recordingPrompts();
		const modes = stubModes("default");
		const agent = fakeAgent();
		const session = recordingSession();
		const chat = createChatLoop({
			getSettings: () => buildSettings(),
			modes,
			knownProviders: () => new Set(["anthropic"]),
			session: session.contract,
			prompts,
			getModel: () => stubModel(),
			registerLocalProviders: () => {},
			createAgent: (opts) => {
				if (opts?.initialState) {
					Object.assign(agent.state, opts.initialState);
				}
				return {
					agent: agent as unknown as ReturnType<typeof import("../../src/engine/agent.js").createEngineAgent>["agent"],
					state: () => agent.state as unknown as AgentState,
				};
			},
		});
		await chat.submit("hello");
		strictEqual(agent.state.systemPrompt, "compiled-for-default-auto-edit");
		ok(prompts.calls.length >= 1);
	});

	it("recompiles systemPrompt on mode change and produces a different hash", async () => {
		const prompts = recordingPrompts();
		const modes = stubModes("default");
		const agent = fakeAgent();
		const session = recordingSession();
		const chat = createChatLoop({
			getSettings: () => buildSettings(),
			modes,
			knownProviders: () => new Set(["anthropic"]),
			session: session.contract,
			prompts,
			getModel: () => stubModel(),
			registerLocalProviders: () => {},
			createAgent: (opts) => {
				if (opts?.initialState) {
					Object.assign(agent.state, opts.initialState);
				}
				return {
					agent: agent as unknown as ReturnType<typeof import("../../src/engine/agent.js").createEngineAgent>["agent"],
					state: () => agent.state as unknown as AgentState,
				};
			},
		});
		await chat.submit("first");
		const firstPrompt = agent.state.systemPrompt;
		modes.set("advise");
		await chat.submit("second");
		notStrictEqual(agent.state.systemPrompt, firstPrompt);
		// Every appended user turn must carry a non-empty renderedPromptHash,
		// and the two user submits should have different hashes (different modes).
		const userAppends = session.appends.filter((a) => a.kind === "user");
		strictEqual(userAppends.length, 2);
		ok(userAppends[0]?.renderedPromptHash && userAppends[0].renderedPromptHash.length > 0);
		ok(userAppends[1]?.renderedPromptHash && userAppends[1].renderedPromptHash.length > 0);
		notStrictEqual(userAppends[0]?.renderedPromptHash, userAppends[1]?.renderedPromptHash);
	});

	it("recompiles systemPrompt when safetyLevel changes in settings", async () => {
		const prompts = recordingPrompts();
		const modes = stubModes("default");
		const agent = fakeAgent();
		const session = recordingSession();
		let safety: ClioSettings["safetyLevel"] = "auto-edit";
		const chat = createChatLoop({
			getSettings: () => buildSettings({ safetyLevel: safety }),
			modes,
			knownProviders: () => new Set(["anthropic"]),
			session: session.contract,
			prompts,
			getModel: () => stubModel(),
			registerLocalProviders: () => {},
			createAgent: (opts) => {
				if (opts?.initialState) {
					Object.assign(agent.state, opts.initialState);
				}
				return {
					agent: agent as unknown as ReturnType<typeof import("../../src/engine/agent.js").createEngineAgent>["agent"],
					state: () => agent.state as unknown as AgentState,
				};
			},
		});
		await chat.submit("first");
		const firstPrompt = agent.state.systemPrompt;
		safety = "suggest";
		await chat.submit("second");
		notStrictEqual(agent.state.systemPrompt, firstPrompt);
	});

	it("threads renderedPromptHash onto appended user AND assistant turns", async () => {
		const prompts = recordingPrompts();
		const modes = stubModes("default");
		const agent = fakeAgent();
		const session = recordingSession();
		const chat = createChatLoop({
			getSettings: () => buildSettings(),
			modes,
			knownProviders: () => new Set(["anthropic"]),
			session: session.contract,
			prompts,
			getModel: () => stubModel(),
			registerLocalProviders: () => {},
			createAgent: (opts) => {
				if (opts?.initialState) {
					Object.assign(agent.state, opts.initialState);
				}
				return {
					agent: agent as unknown as ReturnType<typeof import("../../src/engine/agent.js").createEngineAgent>["agent"],
					state: () => agent.state as unknown as AgentState,
				};
			},
		});
		await chat.submit("turn 1");
		const hashesOnTurns = session.appends.map((a) => a.renderedPromptHash);
		ok(
			hashesOnTurns.every((h) => typeof h === "string" && h.length > 0),
			`expected every append to carry renderedPromptHash, got ${JSON.stringify(hashesOnTurns)}`,
		);
		const kinds = session.appends.map((a) => a.kind);
		deepStrictEqual(kinds, ["user", "assistant"]);
	});

	it("falls back to the built-in identity text when prompts contract is not wired", async () => {
		const modes = stubModes("default");
		const agent = fakeAgent();
		const session = recordingSession();
		const chat = createChatLoop({
			getSettings: () => buildSettings(),
			modes,
			knownProviders: () => new Set(["anthropic"]),
			session: session.contract,
			getModel: () => stubModel(),
			registerLocalProviders: () => {},
			createAgent: (opts) => {
				if (opts?.initialState) {
					Object.assign(agent.state, opts.initialState);
				}
				return {
					agent: agent as unknown as ReturnType<typeof import("../../src/engine/agent.js").createEngineAgent>["agent"],
					state: () => agent.state as unknown as AgentState,
				};
			},
		});
		await chat.submit("hi");
		ok(agent.state.systemPrompt.toLowerCase().includes("clio"));
	});
});
