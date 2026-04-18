import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ToolName } from "../../src/core/tool-names.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import type { ModeName } from "../../src/domains/modes/matrix.js";
import type { ObservabilityContract } from "../../src/domains/observability/contract.js";
import type { CompileForTurnInput, PromptsContract } from "../../src/domains/prompts/contract.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { ClioSessionMeta, ClioTurnRecord } from "../../src/engine/session.js";
import type { AgentEvent, AgentMessage, AgentState, Model, Usage } from "../../src/engine/types.js";
import { type ChatLoopEvent, createChatLoop } from "../../src/interactive/chat-loop.js";

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
	state: Partial<AgentState> & {
		systemPrompt: string;
		tools: unknown[];
		messages: AgentMessage[];
		errorMessage?: string;
	};
	subscribers: Array<(event: AgentEvent) => void>;
	subscribe(cb: (event: AgentEvent) => void): () => void;
	prompt(text: string): Promise<void>;
	abort(): void;
	sessionId?: string;
	promptCalls: string[];
	responseUsage?: Usage;
	/** When set, the NEXT prompt() call simulates pi-agent-core's overflow surface. */
	queueFailure?: { errorMessage: string };
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
	const self: FakeAgent = {
		state,
		subscribers,
		promptCalls,
		subscribe(cb) {
			subscribers.push(cb);
			return () => {};
		},
		async prompt(text: string): Promise<void> {
			promptCalls.push(text);
			if (self.queueFailure) {
				// Mirror pi-agent-core 0.67.4: the provider failure does NOT
				// throw. The agent's internal handleRunFailure pushes an
				// assistant message with stopReason "error" plus the captured
				// errorMessage, and sets state.errorMessage, then emits
				// agent_end and resolves the prompt() Promise normally.
				const failure: AgentMessage = {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					stopReason: "error",
					errorMessage: self.queueFailure.errorMessage,
					timestamp: Date.now(),
				} as unknown as AgentMessage;
				state.messages.push(failure);
				state.errorMessage = self.queueFailure.errorMessage;
				Reflect.deleteProperty(self, "queueFailure");
				for (const cb of subscribers) {
					cb({ type: "agent_end", messages: [failure] } as unknown as AgentEvent);
				}
				return;
			}
			const assistantMsg: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ack" }],
				api: "openai-responses",
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				usage:
					self.responseUsage ??
					({
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					} as Usage),
				stopReason: "stop",
				timestamp: Date.now(),
			} as AgentMessage;
			state.messages.push(assistantMsg);
			for (const cb of subscribers) {
				cb({ type: "message_end", message: assistantMsg } as unknown as AgentEvent);
				cb({ type: "agent_end", messages: [assistantMsg] } as unknown as AgentEvent);
			}
		},
		abort() {},
	};
	return self;
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

interface RecordingObservability {
	contract: ObservabilityContract;
	calls: Array<{ providerId: string; modelId: string; tokens: number; costUsd?: number }>;
}

function recordingObservability(): RecordingObservability {
	const calls: RecordingObservability["calls"] = [];
	return {
		contract: {
			telemetry: () => ({ counters: {}, histograms: {} }),
			metrics: () => ({
				dispatchesCompleted: 0,
				dispatchesFailed: 0,
				safetyClassifications: 0,
				totalTokens: 0,
				histograms: {},
			}),
			sessionCost: () => 0,
			costEntries: () => [],
			recordTokens(providerId, modelId, tokens, costUsd) {
				calls.push({
					providerId,
					modelId,
					tokens,
					...(costUsd !== undefined ? { costUsd } : {}),
				});
			},
		},
		calls,
	};
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

describe("interactive/chat-loop observability", () => {
	it("records orchestrator usage from the terminal assistant message on agent_end", async () => {
		const modes = stubModes("default");
		const agent = fakeAgent();
		agent.responseUsage = {
			input: 120,
			output: 45,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 165,
			cost: { input: 0.00036, output: 0.000675, cacheRead: 0, cacheWrite: 0, total: 0.001035 },
		};
		const observability = recordingObservability();
		const chat = createChatLoop({
			getSettings: () => buildSettings(),
			modes,
			knownProviders: () => new Set(["anthropic"]),
			getModel: () => stubModel(),
			registerLocalProviders: () => {},
			observability: observability.contract,
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

		deepStrictEqual(observability.calls, [
			{
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				tokens: 165,
				costUsd: 0.001035,
			},
		]);
	});

	it("records cache-only assistant usage with totalTokens and authoritative cost", async () => {
		const modes = stubModes("default");
		const agent = fakeAgent();
		agent.responseUsage = {
			input: 0,
			output: 0,
			cacheRead: 1000,
			cacheWrite: 0,
			totalTokens: 1000,
			cost: { input: 0, output: 0, cacheRead: 0.0042, cacheWrite: 0, total: 0.0042 },
		};
		const observability = recordingObservability();
		const chat = createChatLoop({
			getSettings: () => buildSettings(),
			modes,
			knownProviders: () => new Set(["anthropic"]),
			getModel: () => stubModel(),
			registerLocalProviders: () => {},
			observability: observability.contract,
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

		await chat.submit("cache me");

		deepStrictEqual(observability.calls, [
			{
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				tokens: 1000,
				costUsd: 0.0042,
			},
		]);
	});
});

// ---------------------------------------------------------------------------
// slice 12.5b: overflow recovery via stopReason="error" surface
// ---------------------------------------------------------------------------

import type { CompactResult } from "../../src/domains/session/compaction/compact.js";

function compactResult(overrides: Partial<CompactResult> = {}): CompactResult {
	return {
		summary: "prior summary",
		messagesSummarized: 2,
		summaryChars: 100,
		tokensBefore: 5_000,
		isSplitTurn: false,
		firstKeptTurnId: null,
		...overrides,
	} as CompactResult;
}

describe("interactive/chat-loop overflow recovery (slice 12.5b bug 2)", () => {
	it("detects pi-agent-core stopReason=error overflow and runs compact-and-retry", async () => {
		const modes = stubModes("default");
		const agent = fakeAgent();
		const session = recordingSession();
		let compactionRuns = 0;
		const chat = createChatLoop({
			getSettings: () => buildSettings(),
			modes,
			knownProviders: () => new Set(["anthropic"]),
			session: session.contract,
			getModel: () => stubModel(),
			registerLocalProviders: () => {},
			readSessionEntries: () => [],
			autoCompact: async () => {
				compactionRuns++;
				return compactResult();
			},
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
		// First prompt resolves with an overflow-shaped failure. Second prompt
		// (the retry) returns normally.
		agent.queueFailure = { errorMessage: "context length exceeded" };
		await chat.submit("hi");
		strictEqual(agent.promptCalls.length, 2, "expected exactly one retry after compaction");
		strictEqual(compactionRuns, 1, "expected exactly one compaction run");
	});

	it("does not run compaction when stopReason=error but the message is not an overflow pattern", async () => {
		const modes = stubModes("default");
		const agent = fakeAgent();
		const session = recordingSession();
		let compactionRuns = 0;
		const chat = createChatLoop({
			getSettings: () => buildSettings(),
			modes,
			knownProviders: () => new Set(["anthropic"]),
			session: session.contract,
			getModel: () => stubModel(),
			registerLocalProviders: () => {},
			readSessionEntries: () => [],
			autoCompact: async () => {
				compactionRuns++;
				return compactResult();
			},
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
		agent.queueFailure = { errorMessage: "unauthorized: bad api key" };
		await chat.submit("hi");
		strictEqual(agent.promptCalls.length, 1, "non-overflow failure should not retry");
		strictEqual(compactionRuns, 0, "non-overflow failure should not fire compaction");
	});
});

// ---------------------------------------------------------------------------
// slice 12.5b: chat.compact() swaps agent state.messages (bug 4)
// ---------------------------------------------------------------------------

describe("interactive/chat-loop compact method (slice 12.5b bug 4)", () => {
	it("chat.compact() swaps agent.state.messages to [bridge] after a successful run", async () => {
		const modes = stubModes("default");
		const agent = fakeAgent();
		const session = recordingSession();
		let compactionRuns = 0;
		const chat = createChatLoop({
			getSettings: () => buildSettings(),
			modes,
			knownProviders: () => new Set(["anthropic"]),
			session: session.contract,
			getModel: () => stubModel(),
			registerLocalProviders: () => {},
			readSessionEntries: () => [],
			autoCompact: async () => {
				compactionRuns++;
				return compactResult({ summary: "seeded summary" });
			},
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
		// Drive a regular turn first so the runtime materializes and
		// state.messages grows beyond the bridge.
		await chat.submit("hi");
		ok(agent.state.messages.length > 0);
		await chat.compact();
		strictEqual(compactionRuns, 1, "chat.compact() must force the compaction flow");
		strictEqual(agent.state.messages.length, 1, "compact must leave exactly one bridge message");
		const bridge = agent.state.messages[0] as AgentMessage;
		strictEqual(bridge.role, "user");
		const bridgeText = Array.isArray(bridge.content)
			? bridge.content
					.filter((c): c is { type: "text"; text: string } => c?.type === "text")
					.map((c) => c.text)
					.join("\n")
			: "";
		ok(bridgeText.includes("seeded summary"));
	});

	it("chat.compact() is a no-op when autoCompact returns null and emits a user-visible notice", async () => {
		const modes = stubModes("default");
		const agent = fakeAgent();
		const session = recordingSession();
		const events: ChatLoopEvent[] = [];
		const chat = createChatLoop({
			getSettings: () => buildSettings(),
			modes,
			knownProviders: () => new Set(["anthropic"]),
			session: session.contract,
			getModel: () => stubModel(),
			registerLocalProviders: () => {},
			readSessionEntries: () => [],
			autoCompact: async () => null,
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
		chat.onEvent((e) => {
			events.push(e);
		});
		await chat.submit("hi");
		const before = agent.state.messages.length;
		await chat.compact();
		strictEqual(agent.state.messages.length, before, "no bridge swap on no-op compact");
		// The message_end + agent_end notice pair surfaces via chat events so
		// chat-panel renders a "/compact: nothing to compact" line. Assert at
		// least one notice text mentions compact.
		const noticeTexts: string[] = [];
		for (const e of events) {
			if (e.type === "message_end") {
				const msg = (e as unknown as { message?: AgentMessage }).message;
				if (msg && Array.isArray(msg.content)) {
					for (const c of msg.content) {
						if (c?.type === "text" && typeof c.text === "string") noticeTexts.push(c.text);
					}
				}
			}
		}
		ok(
			noticeTexts.some((t) => /compact/i.test(t)),
			`expected a /compact notice, got ${JSON.stringify(noticeTexts)}`,
		);
	});
});
