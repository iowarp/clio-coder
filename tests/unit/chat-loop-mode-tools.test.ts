import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import { MODE_MATRIX, type ModeName } from "../../src/domains/modes/matrix.js";
import type { ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import { classify as classifyAction } from "../../src/domains/safety/action-classifier.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import type { EngineAgentHandle } from "../../src/engine/agent.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { type ChatLoop, createChatLoop } from "../../src/interactive/chat-loop.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { createRegistry } from "../../src/tools/registry.js";

function fakeSafety(): SafetyContract {
	return {
		classify: (call: Parameters<SafetyContract["classify"]>[0]) => classifyAction(call),
		evaluate: (call: Parameters<SafetyContract["evaluate"]>[0]) =>
			({ kind: "allow", classification: classifyAction(call) }) as never,
		observeLoop: (key: string) => ({ looping: false, key, count: 1 }) as never,
		scopes: { default: new Set(), readonly: new Set(), advise: new Set(), super: new Set() } as never,
		isSubset: () => true,
		audit: { recordCount: () => 0 },
	} as unknown as SafetyContract;
}

function liveModesAt(mode: ModeName): ModesContract {
	return {
		current: () => mode,
		setMode: () => mode,
		cycleNormal: () => mode,
		visibleTools: () => MODE_MATRIX[mode].tools,
		isToolVisible: (t) => MODE_MATRIX[mode].tools.has(t),
		isActionAllowed: (a) => MODE_MATRIX[mode].allowedActions.has(a),
		requestSuper: () => {},
		confirmSuper: () => mode,
		elevatedModeFor: () => null,
	};
}

function liveMutableModes(initial: ModeName): ModesContract & { __set: (m: ModeName) => void } {
	let current: ModeName = initial;
	return {
		...liveModesAt(initial),
		__set: (m) => {
			current = m;
		},
		current: () => current,
		setMode: (next) => {
			current = next;
			return current;
		},
		visibleTools: () => MODE_MATRIX[current].tools,
		isToolVisible: (t) => MODE_MATRIX[current].tools.has(t),
		isActionAllowed: (a) => MODE_MATRIX[current].allowedActions.has(a),
		confirmSuper: () => current,
	};
}

function fakeProviders(tools = true): ProvidersContract {
	const endpoint = { id: "stub-endpoint", runtime: "stub-runtime", defaultModel: "stub-model" };
	const runtime: RuntimeDescriptor = {
		id: "stub-runtime",
		displayName: "Stub",
		kind: "http",
		apiFamily: "openai-responses",
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools },
		synthesizeModel: () => ({ id: "stub-model", provider: "stub-runtime" }) as never,
	};
	return {
		list: () => [],
		getEndpoint: (id) => (id === endpoint.id ? endpoint : null),
		getRuntime: (id) => (id === runtime.id ? runtime : null),
		probeAll: async () => {},
		probeAllLive: async () => {},
		probeEndpoint: async () => null,
		disconnectEndpoint: () => null,
		auth: {
			statusForTarget: () =>
				({
					providerId: "stub",
					available: true,
					source: "none",
					detail: "stub",
				}) as never,
			resolveForTarget: async () =>
				({
					providerId: "stub",
					available: true,
					source: "none",
					apiKey: "local",
				}) as never,
			getStored: () => null,
			listStored: () => [],
			setApiKey: () => {},
			remove: () => {},
			login: async () => {},
			logout: () => {},
			getOAuthProviders: () => [],
			setRuntimeOverrideForTarget: () => {},
			clearRuntimeOverrideForTarget: () => {},
		},
		credentials: { hasKey: () => false, get: () => null, set: () => {}, remove: () => {} },
		getDetectedReasoning: () => null,
		probeReasoningForModel: async () => null,
		knowledgeBase: null,
	};
}

function fakeDispatch(): DispatchContract {
	return {
		dispatch: async () => {
			throw new Error("not used");
		},
		dispatchBatch: async () => {
			throw new Error("not used");
		},
		listRuns: () => [],
		getRun: () => null,
		abort: () => {},
		drain: async () => {},
	};
}

const REPO_INSPECTION_TOOLS = [
	"entry_points",
	"find",
	"find_symbol",
	"git_diff",
	"git_log",
	"git_status",
	"glob",
	"grep",
	"ls",
	"read",
	"where_is",
];

const CODING_TOOLS = [...REPO_INSPECTION_TOOLS, "edit", "write"];
const ADVISE_TOOLS = [...REPO_INSPECTION_TOOLS, "write_plan", "write_review"];

interface CaptureLoop {
	loop: ChatLoop;
	snapshots: string[][];
}

function createCaptureLoop(options: { mode?: ModeName; modes?: ModesContract; providerTools?: boolean }): CaptureLoop {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.orchestrator.endpoint = "stub-endpoint";
	settings.orchestrator.model = "stub-model";

	const modes = options.modes ?? liveModesAt(options.mode ?? "default");
	const toolRegistry = createRegistry({ safety: fakeSafety(), modes });
	registerAllTools(toolRegistry, { dispatch: fakeDispatch() });

	let subscribeCb: ((event: AgentEvent) => void | Promise<void>) | null = null;
	const snapshots: string[][] = [];
	const agentState: {
		systemPrompt: string;
		model: never;
		thinkingLevel: "off";
		tools: Array<{ name: string }>;
		messages: AgentMessage[];
		isStreaming: boolean;
		pendingToolCalls: Set<string>;
		errorMessage: string | undefined;
	} = {
		systemPrompt: "",
		model: {} as never,
		thinkingLevel: "off",
		tools: [],
		messages: [],
		isStreaming: false,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};

	const loop = createChatLoop({
		getSettings: () => settings,
		modes,
		providers: fakeProviders(options.providerTools ?? true),
		knownEndpoints: () => new Set(["stub-endpoint"]),
		toolRegistry,
		createAgent: () => {
			const agent = {
				state: agentState,
				sessionId: undefined as string | undefined,
				subscribe: (cb: (event: AgentEvent) => void | Promise<void>) => {
					subscribeCb = cb;
					return () => {
						subscribeCb = null;
					};
				},
				prompt: async () => {
					snapshots.push(agentState.tools.map((t) => t.name));
					const reply: AgentMessage = {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						stopReason: "stop",
						timestamp: 0,
					} as AgentMessage;
					await subscribeCb?.({ type: "message_end", message: reply });
					await subscribeCb?.({ type: "agent_end", messages: [reply] });
				},
				abort: () => {},
			};
			return {
				agent: agent as unknown as EngineAgentHandle["agent"],
				state: () => agent.state,
			} as unknown as EngineAgentHandle;
		},
	});

	return { loop, snapshots };
}

describe("interactive/chat-loop tool palette resolution", () => {
	it("exposes a repo-inspection palette instead of the full default matrix", async () => {
		const capture = createCaptureLoop({ mode: "default" });

		await capture.loop.submit("inspect the repository and explain the entry points");

		deepStrictEqual([...(capture.snapshots[0] ?? [])].sort(), [...REPO_INSPECTION_TOOLS].sort());
		strictEqual(capture.snapshots[0]?.includes("bash"), false);
		strictEqual(capture.snapshots[0]?.includes("edit"), false);
		strictEqual(capture.snapshots[0]?.includes("dispatch"), false);
	});

	it("adds mutate tools for edit requests", async () => {
		const capture = createCaptureLoop({ mode: "default" });

		await capture.loop.submit("fix the parser implementation");

		deepStrictEqual([...(capture.snapshots[0] ?? [])].sort(), [...CODING_TOOLS].sort());
	});

	it("uses advise writers in advise mode without mutable/default escape tools", async () => {
		const capture = createCaptureLoop({ mode: "advise" });

		await capture.loop.submit("review this change");

		deepStrictEqual([...(capture.snapshots[0] ?? [])].sort(), [...ADVISE_TOOLS].sort());
		strictEqual(capture.snapshots[0]?.includes("bash"), false);
		strictEqual(capture.snapshots[0]?.includes("edit"), false);
		strictEqual(capture.snapshots[0]?.includes("write"), false);
	});

	it("re-resolves tools after a mode toggle between turns", async () => {
		const modes = liveMutableModes("default");
		const capture = createCaptureLoop({ modes });

		await capture.loop.submit("inspect the repository");
		modes.__set("advise");
		await capture.loop.submit("review this change");

		strictEqual(capture.snapshots.length, 2);
		deepStrictEqual([...(capture.snapshots[0] ?? [])].sort(), [...REPO_INSPECTION_TOOLS].sort());
		deepStrictEqual([...(capture.snapshots[1] ?? [])].sort(), [...ADVISE_TOOLS].sort());
	});

	it("exposes zero tools when the resolved provider target has no tool support", async () => {
		const capture = createCaptureLoop({ mode: "default", providerTools: false });

		await capture.loop.submit("fix the parser implementation");

		deepStrictEqual(capture.snapshots[0], []);
	});

	it("keeps direct interactive submit and headless run tool palettes equivalent", async () => {
		const originalStdoutWrite = process.stdout.write;
		process.stdout.write = ((
			_chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		): boolean => {
			const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			cb?.();
			return true;
		}) as typeof process.stdout.write;
		try {
			const task = "fix the parser implementation";
			const direct = createCaptureLoop({ mode: "default" });
			const headless = createCaptureLoop({ mode: "default" });

			await direct.loop.submit(task);
			const exitCode = await runHeadlessMainAgent(headless.loop, { prompt: task });

			strictEqual(exitCode, 0);
			deepStrictEqual(headless.snapshots[0], direct.snapshots[0]);
		} finally {
			process.stdout.write = originalStdoutWrite;
		}
	});
});
