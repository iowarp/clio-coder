/**
 * `/btw` at the chat-loop level: what a side question does to the session.
 *
 * The overlay contract in side-question.test.ts proves the command routes and
 * the round renders. This one proves the negative half of the feature, which is
 * the half that matters: a side question is a real provider call that leaves no
 * trace in the session a fleet run briefs its workers from. The four things it
 * must not touch are asserted directly rather than inferred from the absence of
 * a symptom.
 *
 * The spend is still recorded, in two places that are not the session file: the
 * in-process cost surface, and the durable out-of-turn usage store the archive
 * readers fold. Both are asserted here, because "nothing was written" and
 * "nothing was written to the session" are different promises and only the
 * second one is the contract.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ObservabilityContract } from "../../src/domains/observability/contract.js";
import type { OutOfTurnUsageRow } from "../../src/domains/observability/out-of-turn-usage.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { SessionContract, SessionEntryInput, SessionMeta, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/interactive/chat-loop.js";
import type { SideQuestionInput, SideQuestionResult } from "../../src/interactive/side-question.js";

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

interface SessionSpy {
	contract: SessionContract;
	entries: SessionEntry[];
	appendCalls: number;
	appendEntryCalls: number;
}

/** A session that counts every write, so "nothing was appended" is a measurement. */
function createSessionSpy(): SessionSpy {
	const entries: SessionEntry[] = [];
	const spy = { entries, appendCalls: 0, appendEntryCalls: 0 } as SessionSpy;
	let current: SessionMeta | null = null;
	let counter = 0;
	const nextId = (): string => `turn-${++counter}`;
	spy.contract = {
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
			spy.appendCalls += 1;
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
			} as SessionEntry);
			return { ...turn, id, at };
		},
		appendEntry(entry: SessionEntryInput) {
			spy.appendEntryCalls += 1;
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
	} as SessionContract;
	spy.contract.create();
	return spy;
}

interface RecordedTokens {
	providerId: string;
	attributedModelId: string;
	tokens: number;
	costUsd: number | undefined;
	breakdown: unknown;
	label: unknown;
}

interface ObservabilitySpy {
	contract: ObservabilityContract;
	recorded: RecordedTokens[];
	sessionTurns: number;
}

/** Records only what `/btw` is allowed to reach: the cost surface, never the turn mirror. */
function createObservabilitySpy(): ObservabilitySpy {
	const spy = { recorded: [] as RecordedTokens[], sessionTurns: 0 } as ObservabilitySpy;
	spy.contract = {
		recordTokens: (
			providerId: string,
			attributedModelId: string,
			tokens: number,
			costUsd?: number,
			breakdown?: unknown,
			_provenance?: unknown,
			_modelIdFacts?: unknown,
			label?: unknown,
		) => {
			spy.recorded.push({ providerId, attributedModelId, tokens, costUsd, breakdown, label });
		},
		recordSessionTurn: () => {
			spy.sessionTurns += 1;
		},
		recordTokenThroughput: () => {},
	} as never;
	return spy;
}

type FakeAgentOptions = {
	initialState?: {
		systemPrompt?: string;
		model?: unknown;
		thinkingLevel?: string;
		tools?: unknown[];
		messages?: AgentMessage[];
	};
};

interface FakeAgentHandle {
	state: { messages: AgentMessage[]; model: unknown; systemPrompt: string; tools: unknown[] };
}

/** The chat-loop harness's fake agent, narrowed to what a side-question round reads. */
function createFakeAgentFactory(promptImpl: () => Promise<void>, captured: { agent: FakeAgentHandle | null }): never {
	return ((options: FakeAgentOptions = {}) => {
		const state = {
			systemPrompt: options.initialState?.systemPrompt ?? "",
			model: options.initialState?.model,
			thinkingLevel: options.initialState?.thinkingLevel ?? "off",
			tools: options.initialState?.tools ?? [],
			messages: options.initialState?.messages ?? [],
			errorMessage: undefined as string | undefined,
		};
		const agent = {
			state,
			sessionId: undefined,
			maxRetryDelayMs: undefined,
			prepareNextTurn: undefined,
			subscribe: (_listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void) => () => {},
			prompt: async () => {
				await promptImpl();
			},
			continue: async () => {},
			followUp: () => {},
			abort: () => {},
			clearAllQueues: () => {},
			clearFollowUpQueue: () => {},
			clearSteeringQueue: () => {},
		};
		captured.agent = agent as unknown as FakeAgentHandle;
		return { agent, state: () => state };
	}) as never;
}

/** Replayed history seeded onto the runtime, so "unchanged" has something to be unchanged about. */
const SEEDED_HISTORY: AgentMessage[] = [
	{ role: "user", content: [{ type: "text", text: "rename the lease owner" }], timestamp: 1 },
	{
		role: "assistant",
		content: [{ type: "text", text: "renamed it in terminal-lease.ts" }],
		timestamp: 2,
	},
] as unknown as AgentMessage[];

function sideQuestionStub(calls: SideQuestionInput[], result: SideQuestionResult) {
	return async (input: SideQuestionInput): Promise<SideQuestionResult> => {
		calls.push(input);
		return result;
	};
}

const ANSWERED: SideQuestionResult = {
	text: "terminal-lease.ts",
	usage: {
		input: 120,
		output: 8,
		cacheRead: 4,
		cacheWrite: 0,
		reasoning: 2,
		totalTokens: 132,
		costUsd: 0.0004,
	},
	aborted: false,
};

describe("contracts//btw at the chat loop", () => {
	it("answers without appending to the session, mutating history, or recording a turn", async () => {
		const session = createSessionSpy();
		const observability = createObservabilitySpy();
		const calls: SideQuestionInput[] = [];
		const outOfTurnRows: OutOfTurnUsageRow[] = [];
		const captured: { agent: FakeAgentHandle | null } = { agent: null };
		const loop = createChatLoop({
			getSettings: settings,
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: session.contract,
			observability: observability.contract,
			createAgent: createFakeAgentFactory(async () => {
				throw new Error("no turn may run in a side-question contract");
			}, captured),
			runSideQuestion: sideQuestionStub(calls, ANSWERED),
			recordOutOfTurnUsageRow: (row: OutOfTurnUsageRow) => outOfTurnRows.push(row),
		} as never);
		loop.resetForSession(null, SEEDED_HISTORY);

		const outcome = await loop.askSideQuestion("which file did the lease land in?");
		strictEqual(outcome.status, "answered");
		strictEqual(outcome.status === "answered" ? outcome.text : "", "terminal-lease.ts");
		strictEqual(calls.length, 1, "exactly one round reached the provider seam");

		// 1. Nothing reached the session store.
		strictEqual(session.appendCalls, 0, "no turn was appended");
		strictEqual(session.appendEntryCalls, 0, "no ledger entry was appended");
		deepStrictEqual(session.entries, [], "the session store is byte-for-byte empty");

		// 2. The compiled message history is unchanged, and was sent as it stood.
		ok(captured.agent, "the runtime was built");
		const history = captured.agent.state.messages;
		deepStrictEqual(history, SEEDED_HISTORY, "the live history is unchanged after the round");
		strictEqual(history.length, 2, "the question was not appended to the live history");
		deepStrictEqual(
			calls[0]?.messages as unknown as AgentMessage[],
			SEEDED_HISTORY,
			"the round was given the history the next turn would send",
		);
		strictEqual(calls[0]?.question, "which file did the lease land in?");

		// 3. No turn was recorded through turn-persistence: its ledger cursor never
		//    moved and its observability mirror was never called.
		strictEqual(observability.sessionTurns, 0, "turn-persistence never mirrored a session turn");
		strictEqual(loop.lastRunSnapshot?.() ?? null, null, "no run snapshot was taken");
		strictEqual(loop.isStreaming(), false, "the round never claimed the turn state machine");

		// 4. The spend was reported once, labeled as a side question.
		strictEqual(observability.recorded.length, 1, "recordTokens fired exactly once");
		const recorded = observability.recorded[0];
		ok(recorded);
		strictEqual(recorded.label, "side-question");
		strictEqual(recorded.providerId, "test-target");
		strictEqual(recorded.attributedModelId, "model");
		strictEqual(recorded.tokens, 132);
		strictEqual(recorded.costUsd, 0.0004);
		deepStrictEqual(recorded.breakdown, {
			input: 120,
			output: 8,
			cacheRead: 4,
			cacheWrite: 0,
			reasoningTokens: 2,
			totalTokens: 132,
			apiCalls: 1,
		});

		// 5. The same spend reached the durable out-of-turn store, which is where
		//    an archive reader such as `clio-coder usage report` finds it after
		//    this process is gone. Exactly one line, labeled and attributed.
		strictEqual(outOfTurnRows.length, 1, "the out-of-turn usage store received one row");
		const stored = outOfTurnRows[0];
		ok(stored);
		strictEqual(stored.label, "side-question");
		strictEqual(stored.sessionId, "session-1");
		strictEqual(stored.target, "test-target");
		strictEqual(stored.attributedModelId, "model");
		ok(typeof stored.repoIdentity === "string" && stored.repoIdentity.length > 0, "the row carries a repo identity");
		ok(Number.isFinite(Date.parse(stored.timestamp)), "the row carries a parseable timestamp");
		deepStrictEqual(stored.usage, {
			input: 120,
			output: 8,
			cacheRead: 4,
			cacheWrite: 0,
			reasoning: 2,
			totalTokens: 132,
			costUsd: 0.0004,
			costProvenance: "unknown",
		});

		loop.dispose();
	});

	it("records nothing at all when the provider reports no usage", async () => {
		const session = createSessionSpy();
		const observability = createObservabilitySpy();
		const calls: SideQuestionInput[] = [];
		const captured: { agent: FakeAgentHandle | null } = { agent: null };
		const loop = createChatLoop({
			getSettings: settings,
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: session.contract,
			observability: observability.contract,
			createAgent: createFakeAgentFactory(async () => {}, captured),
			runSideQuestion: sideQuestionStub(calls, { text: "ok", usage: null, aborted: false }),
		} as never);

		const outcome = await loop.askSideQuestion("anything");
		strictEqual(outcome.status, "answered");
		strictEqual(observability.recorded.length, 0, "an unmeasured call is never fabricated into a zero-token cost row");
		strictEqual(session.appendEntryCalls, 0);
		loop.dispose();
	});

	it("refuses while a turn is in flight and never opens a provider round", async () => {
		const session = createSessionSpy();
		const observability = createObservabilitySpy();
		const calls: SideQuestionInput[] = [];
		const captured: { agent: FakeAgentHandle | null } = { agent: null };
		let releaseTurn: () => void = () => {};
		const turnHeld = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const loop = createChatLoop({
			getSettings: settings,
			providers: providers(),
			knownTargets: () => new Set(["test-target"]),
			session: session.contract,
			observability: observability.contract,
			createAgent: createFakeAgentFactory(async () => {
				await turnHeld;
			}, captured),
			runSideQuestion: sideQuestionStub(calls, ANSWERED),
		} as never);

		let admitted: () => void = () => {};
		const owns = new Promise<void>((resolve) => {
			admitted = resolve;
		});
		const submit = loop.submit("do the work", { onAdmitted: () => admitted() });
		await owns;
		strictEqual(loop.isStreaming(), true, "the turn owns the state machine");

		const outcome = await loop.askSideQuestion("quick question while that runs");
		strictEqual(outcome.status, "refused");
		const reason = outcome.status === "refused" ? outcome.reason : "";
		ok(reason.includes("in flight"), `refusal names the in-flight turn, got: ${reason}`);
		strictEqual(calls.length, 0, "the provider round was never opened");
		strictEqual(observability.recorded.length, 0, "a refused round spends nothing");

		releaseTurn();
		await submit;
		loop.dispose();
	});
});
