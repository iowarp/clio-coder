import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { AgentRecipe } from "../../src/domains/agents/recipe.js";
import { normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import { buildStableSystemPrompt, createDispatchBundle } from "../../src/domains/dispatch/extension.js";
import { recoverOrphanReceipts } from "../../src/domains/dispatch/orphan-recovery.js";
import { resolveRunOutcome } from "../../src/domains/dispatch/outcome.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import {
	recordToolFinish,
	summarizeToolActivity,
	zeroSuccessfulToolNote,
} from "../../src/domains/dispatch/tool-stats.js";
import type { RunLineage, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import type { WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/index.js";
import type { ProvidersContract, RuntimeDescriptor, TargetStatus } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import type { AcpDelegationRunHandle } from "../../src/engine/acp/adapter.js";
import { AcpToolMediator } from "../../src/engine/acp/tool-mediator.js";
import { agentDisplayLabel } from "../../src/interactive/dispatch-board.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function emptyEvents(): AsyncIterableIterator<unknown> {
	return (async function* () {})();
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(message);
}

async function drainEvents(events: AsyncIterableIterator<unknown>): Promise<unknown[]> {
	const out: unknown[] = [];
	for await (const event of events) out.push(event);
	return out;
}

function withIsolatedClioHome<T>(fn: (scratch: string) => T | Promise<T>): Promise<T> {
	const originalEnv = { ...process.env };
	const scratch = mkdtempSync(join(tmpdir(), "clio-dispatch-"));
	process.env.CLIO_HOME = scratch;
	process.env.CLIO_DATA_DIR = join(scratch, "data");
	process.env.CLIO_CONFIG_DIR = join(scratch, "config");
	process.env.CLIO_STATE_DIR = join(scratch, "state");
	process.env.CLIO_CACHE_DIR = join(scratch, "cache");
	resetXdgCache();
	return Promise.resolve()
		.then(() => fn(scratch))
		.finally(() => {
			for (const k of Object.keys(process.env)) {
				if (!(k in originalEnv)) Reflect.deleteProperty(process.env, k);
			}
			for (const [k, v] of Object.entries(originalEnv)) {
				if (v !== undefined) process.env[k] = v;
			}
			rmSync(scratch, { recursive: true, force: true });
			resetXdgCache();
		});
}

function stubContext(
	options: {
		target?: TargetDescriptor;
		runtime?: RuntimeDescriptor;
		recipes?: ReadonlyArray<AgentRecipe>;
		status?: Partial<TargetStatus>;
	} = {},
): DomainContext {
	const settings = structuredClone(DEFAULT_SETTINGS);
	const target: TargetDescriptor = options.target ?? {
		id: "default",
		runtime: "openai",
		defaultModel: "gpt-4o",
	};
	settings.targets = [target];
	settings.workers.default.target = target.id;
	settings.workers.default.model = target.defaultModel ?? "gpt-4o";

	const runtime: RuntimeDescriptor = options.runtime ?? {
		id: target.runtime,
		displayName: "OpenAI",
		kind: "http",
		apiFamily: "openai-completions",
		auth: "api-key",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
		synthesizeModel: () => ({ id: target.defaultModel, provider: target.runtime }) as never,
	};
	const status: TargetStatus = {
		target,
		runtime,
		available: true,
		reason: "test",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...runtime.defaultCapabilities },
		discoveredModels: [],
		...options.status,
	};
	const providers: ProvidersContract = {
		list: () => [status],
		getTarget: (id) => (id === target.id ? target : null),
		getRuntime: (id) => (id === runtime.id ? runtime : null),
		probeAll: async () => {},
		probeAllLive: async () => {},
		probeTarget: async () => status,
		disconnectTarget: () => status,
		auth: {
			statusForTarget: () => ({
				providerId: runtime.id,
				available: true,
				credentialType: null,
				source: "none",
				detail: null,
			}),
			resolveForTarget: async () => ({
				providerId: runtime.id,
				available: true,
				credentialType: null,
				source: "none",
				detail: null,
			}),
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
		credentials: {
			hasKey: () => false,
			get: () => null,
			set: () => {},
			remove: () => {},
		},
		getDetectedReasoning: () => null,
		probeReasoningForModel: async () => null,
		knowledgeBase: null,
	};

	const config: ConfigContract = {
		get: () => settings,
		onChange: () => () => {},
	};

	const safety: SafetyContract = {
		classify: () => ({ actionClass: "read", reasons: [] }),
		evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "test", count: 0 }),
		scopes: {
			readonly: READONLY_SCOPE,
			workspace: WORKSPACE_SCOPE,
			confirmed: CONFIRMED_SCOPE,
		},
		isSubset,
		audit: { recordCount: () => 0 },
	};

	const recipes: ReadonlyArray<AgentRecipe> = options.recipes ?? [
		{
			id: "coder",
			name: "coder",
			description: "test recipe",
			source: "builtin" as const,
			filepath: "/test/coder.md",
			body: "# Test Recipe",
		},
	];
	const agents: AgentsContract = {
		list: () => recipes,
		get: (id) => recipes.find((recipe) => recipe.id === id) ?? null,
		listSpecs: () => recipes.map(normalizeAgentSpec),
		getSpec: (id) => {
			const recipe = recipes.find((entry) => entry.id === id);
			return recipe ? normalizeAgentSpec(recipe) : null;
		},
		reload: () => {},
		parseFleet: () => ({ steps: [] }),
	};

	const middleware = createMiddlewareBundle().contract;

	const bus = createSafeEventBus();
	const getContract = ((name: string) => {
		if (name === "config") return config;
		if (name === "safety") return safety;
		if (name === "agents") return agents;
		if (name === "scheduling")
			return {
				ceilingUsd: () => 5,
				checkCeiling: () => "under",
				raiseCeiling: () => {},
				preflight: () => ({ verdict: "under", currentUsd: 0, ceilingUsd: 5 }),
				activeWorkers: () => 0,
				tryAcquireWorker: () => true,
				releaseWorker: () => {},
				listNodes: () => [],
			};
		if (name === "providers") return providers;
		if (name === "middleware") return middleware;
		return undefined;
	}) as DomainContext["getContract"];

	return { bus, getContract };
}

describe("contracts/dispatch", () => {
	it("dispatches single task using a fake worker and returns exit receipt", async () => {
		const context = stubContext();
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		let spawned = false;

		const bundle = createDispatchBundle(context, {
			spawnWorker: () => {
				spawned = true;
				return {
					pid: 9999,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
				};
			},
		});

		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "single dispatch" });
			ok(spawned);
			exit.resolve({ exitCode: 0, signal: null });
			const receipt = await handle.finalPromise;

			strictEqual(receipt.exitCode, 0);
			strictEqual(receipt.agentId, "coder");
			strictEqual(receipt.task, "single dispatch");
			ok(receipt.integrity?.digest);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("resolves worker targets through the injected session settings view, not the shared config", async () => {
		const context = stubContext();
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		let capturedSpec: WorkerSpec | null = null;

		// The session view (what the running terminal shows in /settings) points
		// the fleet default at a different model than the shared config snapshot.
		const sessionView = structuredClone(DEFAULT_SETTINGS);
		sessionView.targets = [{ id: "default", runtime: "openai", defaultModel: "gpt-4o" }];
		sessionView.workers.default = { target: "default", model: "session-model", thinkingLevel: "off" };

		const bundle = createDispatchBundle(context, {
			getSettings: () => sessionView,
			spawnWorker: (spec) => {
				capturedSpec = spec;
				return {
					pid: 9999,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
				};
			},
		});

		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "session view dispatch" });
			strictEqual((capturedSpec as WorkerSpec | null)?.wireModelId, "session-model");
			exit.resolve({ exitCode: 0, signal: null });
			await handle.finalPromise;
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("canonicalizes worker spec and receipt model ids against a live catalog", async () => {
		const requested = "AgenticQwen-30B-A3B-i1-Q4_K_M";
		const canonical = "AgenticQwen-30B-A3B-i1-Q4_K_M-262K";
		const target: TargetDescriptor = { id: "mini", runtime: "llamacpp", defaultModel: requested };
		const runtime: RuntimeDescriptor = {
			id: "llamacpp",
			displayName: "llama.cpp",
			kind: "http",
			apiFamily: "openai-completions",
			auth: "none",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
			synthesizeModel: (_target, wireModelId) => ({ id: wireModelId, provider: "llamacpp" }) as never,
		};
		const context = stubContext({
			target,
			runtime,
			status: { discoveredModels: [canonical], discoveredModelsSource: "probe" },
		});
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		let capturedSpec: WorkerSpec | null = null;

		const bundle = createDispatchBundle(context, {
			spawnWorker: (spec) => {
				capturedSpec = spec;
				return {
					pid: 9999,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
				};
			},
		});

		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "canonical model dispatch" });
			exit.resolve({ exitCode: 0, signal: null });
			const receipt = await handle.finalPromise;
			strictEqual((capturedSpec as WorkerSpec | null)?.wireModelId, canonical);
			strictEqual((capturedSpec as WorkerSpec | null)?.runtimeResolution?.wireModelId, canonical);
			strictEqual(receipt.wireModelId, canonical);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("dispatch serializes the resolved http runtime onto the worker spec", async () => {
		const id = "http-worker";
		const target: TargetDescriptor = { id: `${id}-target`, runtime: id, defaultModel: "worker-model" };
		const runtime: RuntimeDescriptor = {
			id,
			displayName: id,
			kind: "http",
			apiFamily: "openai-completions",
			auth: "api-key",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
			synthesizeModel: () => ({ id: "worker-model", provider: id }) as never,
		};
		const context = stubContext({ target, runtime });
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		let capturedSpec: WorkerSpec | null = null;

		const bundle = createDispatchBundle(context, {
			spawnWorker: (spec) => {
				capturedSpec = spec;
				return {
					pid: 9001,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
				};
			},
		});

		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: `run ${id}` });
			exit.resolve({ exitCode: 0, signal: null });
			await handle.finalPromise;
			const spec = capturedSpec as unknown as WorkerSpec;
			strictEqual(spec.agentId, "coder");
			strictEqual(spec.task, `run ${id}`);
			strictEqual(spec.runtimeId, id);
			strictEqual(spec.runtime.kind, "http");
			// Workers inherit the session autonomy level at admission (sd-01 §2.5).
			strictEqual(spec.autonomy, "auto-edit");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("dispatches a batch of tasks to multiple fake workers concurrently", async () => {
		const context = stubContext();
		const exits = [
			deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>(),
			deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>(),
		];
		const exitQueue = [...exits];
		const spawnedTasks: string[] = [];

		const bundle = createDispatchBundle(context, {
			spawnWorker: (spec) => {
				spawnedTasks.push(spec.task);
				const exit = exitQueue.shift();
				if (!exit) throw new Error("no exits left");
				return {
					pid: 8000 + spawnedTasks.length,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
				};
			},
		});

		await bundle.extension.start();
		try {
			const batch = await bundle.contract.dispatchBatch([
				{ agentId: "coder", task: "batch task 1" },
				{ agentId: "coder", task: "batch task 2" },
			]);

			strictEqual(batch.runIds.length, 2);
			deepStrictEqual(spawnedTasks, ["batch task 1", "batch task 2"]);

			const drained: unknown[] = [];
			const p = (async () => {
				for await (const ev of batch.events) {
					drained.push(ev);
				}
			})();

			const ex0 = exits[0];
			const ex1 = exits[1];
			if (ex0) ex0.resolve({ exitCode: 0, signal: null });
			if (ex1) ex1.resolve({ exitCode: 0, signal: null });
			await p;

			const receipts = await batch.finalPromise;
			strictEqual(receipts.length, 2);
			strictEqual(receipts[0]?.exitCode, 0);
			strictEqual(receipts[1]?.exitCode, 0);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("rejects recipe tools that contradict declared capability class", async () => {
		const context = stubContext({
			recipes: [
				{
					id: "bad-validator",
					name: "Bad Validator",
					description: "Invalid validation recipe.",
					tools: ["read", "run_task"],
					capabilityClass: "read-only",
					source: "builtin",
					filepath: "/test/bad-validator.md",
					body: "# Bad Validator",
				},
			],
		});
		const bundle = createDispatchBundle(context);
		await bundle.extension.start();
		try {
			await rejects(
				() => bundle.contract.dispatch({ agentId: "bad-validator", task: "run tests" }),
				/read-only agent 'bad-validator' requests execute tools/,
			);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("blocks user-origin dispatches to shadow agents while allowing internal orchestration", async () => {
		const context = stubContext({
			recipes: [
				{
					id: "scout",
					name: "Scout",
					description: "Shadow scout.",
					tools: ["read"],
					audience: "shadow",
					source: "builtin",
					filepath: "/test/scout.md",
					body: "# Scout",
				},
			],
		});
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		let spawned = false;
		const bundle = createDispatchBundle(context, {
			spawnWorker: () => {
				spawned = true;
				return {
					pid: 7777,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
				};
			},
		});
		await bundle.extension.start();
		try {
			await rejects(
				() => bundle.contract.dispatch({ agentId: "scout", task: "map files", requestOrigin: "user" }),
				/reserved for Clio internal orchestration/,
			);
			const handle = await bundle.contract.dispatch({ agentId: "scout", task: "map files" });
			strictEqual(spawned, true);
			exit.resolve({ exitCode: 0, signal: null });
			const receipt = await handle.finalPromise;
			strictEqual(receipt.exitCode, 0);
			strictEqual(receipt.agentAudience, "shadow");
			strictEqual(receipt.requestOrigin, "agent");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("marks shadow dispatch rows distinctly for the TUI", () => {
		strictEqual(agentDisplayLabel({ agentId: "scout", agentAudience: "shadow" }), "sh:scout");
		strictEqual(agentDisplayLabel({ agentId: "coder", agentAudience: "base" }), "coder");
	});

	it("injects declared skills as compact prompt guidance", () => {
		const recipe: AgentRecipe = {
			id: "researcher",
			name: "Researcher",
			description: "Docs researcher.",
			tools: ["read", "read_skill"],
			skills: ["context7-docs", "pdf-reader"],
			source: "builtin",
			filepath: "/test/researcher.md",
			body: "# Researcher\nUse sources.",
		};
		const prompt = buildStableSystemPrompt({ agentId: "researcher", task: "check docs" }, recipe);
		match(prompt, /# Agent-Bound Skills/);
		match(prompt, /`context7-docs`, `pdf-reader`/);
		match(prompt, /Skills provide reusable know-how and resources; they never expand your tool authority\./);
		const noSkillsPrompt = buildStableSystemPrompt({ agentId: "researcher", task: "check docs", noSkills: true }, recipe);
		strictEqual(noSkillsPrompt.includes("# Agent-Bound Skills"), false);
	});

	it("releases the gate and creates receipt with exit code on worker failure", async () => {
		const context = stubContext();
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const bundle = createDispatchBundle(context, {
			spawnWorker: () => ({
				pid: 1003,
				promise: exit.promise,
				events: emptyEvents(),
				abort: () => {},
				heartbeatAt: { current: Date.now() },
			}),
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "failing task" });
			exit.resolve({ exitCode: 1, signal: null });
			const receipt = await handle.finalPromise;
			strictEqual(receipt.exitCode, 1);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("dispatches configured ACP delegation agents with delegation receipt metadata", async () => {
		const context = stubContext();
		const terminalEvents: unknown[] = [];
		const unsubscribeTerminal = context.bus.on(BusChannels.DispatchCompleted, (payload) => {
			terminalEvents.push(payload);
		});
		const configContract = context.getContract<ConfigContract>("config");
		if (configContract) {
			configContract.get().delegation.agents = [
				{
					id: "opencode",
					command: "opencode",
					args: ["acp"],
					connectTimeoutMs: 5,
					turnTimeoutMs: 10,
					permissionTimeoutMs: 15,
					toolGovernance: "clio-policy",
				},
			];
		}
		let capturedTask = "";
		let capturedCommand = "";

		const bundle = createDispatchBundle(context, {
			startAcpDelegationRun: (input) => {
				capturedTask = input.task;
				capturedCommand = input.agent.command;
				return {
					pid: 4242,
					heartbeatAt: { current: Date.now() },
					abort: () => {},
					kill: () => {},
					toolCallLog: () => [
						{
							callId: "call-1",
							tool: "read",
							arguments: { path: "package.json" },
							decision: "approved",
							durationMs: 1,
							timestamp: new Date(0).toISOString(),
						},
					],
					events: (async function* () {
						yield {
							type: "message_end",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "delegated done" }],
								timestamp: Date.now(),
								stopReason: "stop",
								usage: { input: 3, output: 4 },
							},
						} as unknown as Awaited<ReturnType<AcpDelegationRunHandle["events"]["next"]>>["value"];
					})() as AcpDelegationRunHandle["events"],
					promise: Promise.resolve({
						messages: [],
						exitCode: 0,
						stopReason: "end_turn",
						usage: {
							inputTokens: 1,
							outputTokens: 2,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							reasoningTokens: 0,
						},
						delegation: {
							acpSessionId: "sess-1",
							initialize: {
								protocolVersion: 1,
								agentCapabilities: { loadSession: true },
								agentInfo: { name: "opencode", version: "1.0.0" },
							},
							toolCallsRequested: 1,
							toolCallsApproved: 1,
							toolCallsDenied: 0,
						},
					}),
				};
			},
		});

		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "opencode",
				delegationAgentId: "opencode",
				task: "delegate this",
			});
			const events: unknown[] = [];
			for await (const event of handle.events) events.push(event);
			const receipt = await handle.finalPromise;

			strictEqual(capturedTask, "delegate this");
			strictEqual(capturedCommand, "opencode");
			strictEqual(receipt.runtimeKind, "acp-delegation");
			strictEqual(receipt.targetId, "delegation:opencode");
			strictEqual(receipt.sessionId, "sess-1");
			strictEqual(receipt.tokenCount, 3);
			strictEqual(
				(terminalEvents[0] as { inputTokenCount?: unknown } | undefined)?.inputTokenCount,
				receipt.inputTokenCount,
			);
			strictEqual(
				(terminalEvents[0] as { outputTokenCount?: unknown } | undefined)?.outputTokenCount,
				receipt.outputTokenCount,
			);
			strictEqual(receipt.delegation?.agentConfigId, "opencode");
			strictEqual(receipt.delegation?.toolCallsRequested, 1);
			strictEqual(receipt.delegation?.toolCallLog[0]?.callId, "call-1");
			ok(
				events.some(
					(event) => typeof event === "object" && event !== null && (event as { type?: string }).type === "message_end",
				),
			);
		} finally {
			unsubscribeTerminal();
			await bundle.extension.stop?.();
		}
	});

	it("surfaces bounded native worker stderr and malformed stdout in terminal failure detail", async () => {
		const { spawnNativeWorker } = await import("../../src/domains/dispatch/worker-spawn.js");
		const scratch = mkdtempSync(join(tmpdir(), "clio-worker-diagnostics-"));
		const stubEntry = join(scratch, "stub-entry.js");
		writeFileSync(
			stubEntry,
			`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.once("line", () => {
	process.stdout.write("not json\\n");
	process.stderr.write("x".repeat(5000) + "\\n[worker] fatal: expected diagnostic\\n");
	process.exit(1);
});
`,
			"utf8",
		);

		const context = stubContext();
		const failedEvents: unknown[] = [];
		const unsubscribeFailed = context.bus.on(BusChannels.DispatchFailed, (payload) => {
			failedEvents.push(payload);
		});
		const bundle = createDispatchBundle(context, {
			spawnWorker: (spec, opts) =>
				spawnNativeWorker(spec, {
					...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
					workerEntryPath: stubEntry,
				}),
		});

		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "crash with diagnostics" });
			await drainEvents(handle.events);
			const receipt = await handle.finalPromise;
			strictEqual(receipt.exitCode, 1);
			match(receipt.outcomeDetail ?? "", /\[worker\] fatal: expected diagnostic/);
			match(receipt.outcomeDetail ?? "", /malformed stdout lines: 1/);
			match(receipt.failureMessage ?? "", /\[worker\] fatal: expected diagnostic/);
			ok((receipt.failureMessage ?? "").length <= 4200, "failure diagnostics must stay bounded");
			const failedPayload = failedEvents[0] as { outcomeDetail?: unknown } | undefined;
			match(String(failedPayload?.outcomeDetail ?? ""), /\[worker\] fatal: expected diagnostic/);
		} finally {
			unsubscribeFailed();
			await bundle.extension.stop?.();
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("briefly cools down a failed target instead of immediately respawning into the same failure", async () => {
		const context = stubContext();
		const firstExit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const secondExit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		let spawnCount = 0;
		let now = 1000;
		const bundle = createDispatchBundle(context, {
			now: () => now,
			resilienceCooldownMs: 500,
			spawnWorker: () => ({
				pid: 3001 + spawnCount,
				promise: (spawnCount++ === 0 ? firstExit : secondExit).promise,
				events: emptyEvents(),
				abort: () => {},
				heartbeatAt: { current: Date.now() },
			}),
		});
		await bundle.extension.start();
		try {
			const first = await bundle.contract.dispatch({ agentId: "coder", task: "fails" });
			firstExit.resolve({ exitCode: 1, signal: null });
			await first.finalPromise;

			const { rejects } = await import("node:assert/strict");
			await rejects(bundle.contract.dispatch({ agentId: "coder", task: "retry too soon" }), /cooling down/);
			now += 501;
			const second = await bundle.contract.dispatch({ agentId: "coder", task: "retry after cooldown" });
			secondExit.resolve({ exitCode: 0, signal: null });
			const receipt = await second.finalPromise;
			strictEqual(receipt.exitCode, 0);
			strictEqual(spawnCount, 2);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("no longer intercepts approval IPC; the spawned worker exposes no approval handlers", async () => {
		const { chmodSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { spawnNativeWorker } = await import("../../src/domains/dispatch/worker-spawn.js");
		const { WORKER_RUNTIME_DESCRIPTOR_VERSION, WORKER_SPEC_VERSION } = await import("../../src/worker/spec-contract.js");

		const scratch = mkdtempSync(join(tmpdir(), "clio-approval-absent-"));
		const stubEntry = join(scratch, "stub-entry.js");
		// Emits a legacy approval-request line then exits without waiting for any
		// response. With the Claude Code SDK approval IPC removed, the orchestrator
		// must not intercept or answer this; the line passes through as a plain event.
		writeFileSync(
			stubEntry,
			`
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.once("line", () => {
	process.stdout.write(JSON.stringify({ type: "clio_tool_approval_request", payload: { requestId: "abc" } }) + "\\n");
	process.exit(0);
});
`,
		);
		chmodSync(stubEntry, 0o755);

		try {
			const worker = spawnNativeWorker(
				{
					specVersion: WORKER_SPEC_VERSION,
					systemPrompt: "",
					agentId: "coder",
					task: "t",
					target: { id: "e", runtime: "x" } as never,
					runtime: {
						version: WORKER_RUNTIME_DESCRIPTOR_VERSION,
						id: "x",
						kind: "http",
						apiFamily: "openai-responses",
						auth: "none",
					},
					runtimeId: "x",
					wireModelId: "m",
					allowedTools: ["bash"],
				},
				{ workerEntryPath: stubEntry },
			);

			ok(!("onApprovalRequest" in worker), "SpawnedWorker must not expose onApprovalRequest");
			ok(!("sendApprovalResponse" in worker), "SpawnedWorker must not expose sendApprovalResponse");

			const events: unknown[] = [];
			for await (const ev of worker.events) events.push(ev);
			const exit = await worker.promise;
			strictEqual(exit.exitCode, 0);
			const passthrough = events.some(
				(ev) => !!ev && typeof ev === "object" && (ev as { type?: unknown }).type === "clio_tool_approval_request",
			);
			ok(passthrough, "approval-request line is surfaced as a plain event, not intercepted");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("forwards skill settings to the spawned worker spec", async () => {
		const context = stubContext();
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		let capturedSpec: WorkerSpec | null = null;

		const bundle = createDispatchBundle(context, {
			spawnWorker: (spec) => {
				capturedSpec = spec;
				return {
					pid: 9999,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
				};
			},
		});

		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				task: "test skill forwarding",
				noSkills: true,
				skillPaths: ["/some/path/SKILL.md"],
				trustProjectCompatRoots: true,
			});
			exit.resolve({ exitCode: 0, signal: null });
			await handle.finalPromise;

			const spec = capturedSpec as unknown as WorkerSpec;
			ok(spec !== null);
			strictEqual(spec.noSkills, true);
			deepStrictEqual(spec.skillPaths, ["/some/path/SKILL.md"]);
			strictEqual(spec.trustProjectCompatRoots, true);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("derives trustProjectCompatRoots from config when not explicitly in the request", async () => {
		const context = stubContext();
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		let capturedSpec: WorkerSpec | null = null;

		const configContract = context.getContract<ConfigContract>("config");
		if (configContract) {
			configContract.get().skills.trustProjectCompatRoots = true;
		}

		const bundle = createDispatchBundle(context, {
			spawnWorker: (spec) => {
				capturedSpec = spec;
				return {
					pid: 9999,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
				};
			},
		});

		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				task: "test default config trust",
				noSkills: true,
			});
			exit.resolve({ exitCode: 0, signal: null });
			await handle.finalPromise;

			const spec = capturedSpec as unknown as WorkerSpec;
			ok(spec !== null);
			strictEqual(spec.trustProjectCompatRoots, true);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("table-drives terminal outcome resolution", () => {
		const base = {
			exitCode: 0,
			abortedByOperator: false,
			stallKilled: false,
			timedOut: false,
			permissionFailure: false,
			policyDenied: null,
			stopReason: null,
		};
		const cases = [
			{ name: "clean exit", evidence: { ...base, exitCode: 0 }, outcome: "succeeded", detail: null },
			{ name: "nonzero exit", evidence: { ...base, exitCode: 2 }, outcome: "failed", detail: "exit code 2" },
			{
				name: "stall kill",
				evidence: { ...base, exitCode: 1, stallKilled: true },
				outcome: "stalled",
				detail: "no worker activity within the stall window",
			},
			{
				name: "operator abort",
				evidence: { ...base, exitCode: 1, abortedByOperator: true },
				outcome: "canceled",
				detail: "operator abort",
			},
			{
				name: "admission rejection",
				evidence: { ...base, policyDenied: "scope denied" },
				outcome: "denied_by_policy",
				detail: "scope denied",
			},
			{
				name: "spawn ENOENT",
				evidence: { ...base, exitCode: null },
				outcome: "spawn_failed",
				detail: "process never reached a live session",
			},
			{
				name: "ACP turn timeout",
				evidence: { ...base, exitCode: 1, timedOut: true },
				outcome: "timed_out",
				detail: "turn timeout exceeded",
			},
		] as const;
		for (const c of cases) {
			deepStrictEqual(resolveRunOutcome(c.evidence), { outcome: c.outcome, detail: c.detail }, c.name);
		}
	});

	it("kills dead workers and schedules a bounded retry", async () => {
		const context = stubContext();
		const configContract = context.getContract<ConfigContract>("config");
		if (configContract) configContract.get().workers.maxRetries = 1;
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		let abortCalled = false;
		const bundle = createDispatchBundle(context, {
			now: () => 1000,
			heartbeatSpec: { windowMs: 1, graceMs: 1 },
			heartbeatIntervalMs: 5,
			resilienceCooldownMs: 0,
			spawnWorker: () => ({
				pid: 7001,
				promise: exit.promise,
				events: emptyEvents(),
				heartbeatAt: { current: 0 },
				abort: () => {
					abortCalled = true;
					exit.resolve({ exitCode: 1, signal: "SIGKILL" });
				},
			}),
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "stall me" });
			await waitFor(() => abortCalled, "heartbeat reconciler did not kill dead worker");
			const receipt = await handle.finalPromise;
			strictEqual(receipt.outcome, "stalled");
			const retry = bundle.contract.snapshot().retrying[0];
			strictEqual(retry?.runId, handle.runId);
			strictEqual(retry?.attempt, 1);
			strictEqual(retry?.reason.startsWith("stalled"), true);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("does not retry exhausted or canceled runs", async () => {
		const context = stubContext();
		const configContract = context.getContract<ConfigContract>("config");
		if (configContract) configContract.get().workers.maxRetries = 1;
		const exits = [
			deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>(),
			deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>(),
		];
		let spawnCount = 0;
		const bundle = createDispatchBundle(context, {
			resilienceCooldownMs: 0,
			spawnWorker: () => {
				const idx = spawnCount++;
				const exit = exits[idx];
				if (!exit) throw new Error("unexpected spawn");
				return {
					pid: 7100 + idx,
					promise: exit.promise,
					events: emptyEvents(),
					heartbeatAt: { current: Date.now() },
					abort: () => exit.resolve({ exitCode: 1, signal: "SIGTERM" }),
				};
			},
		});
		await bundle.extension.start();
		try {
			const exhausted = await bundle.contract.dispatch({
				agentId: "coder",
				task: "already retried",
				lineage: { parentRunId: "parent", rootRunId: "root", attempt: 1, depth: 0 },
			});
			exits[0]?.resolve({ exitCode: 1, signal: null });
			const exhaustedReceipt = await exhausted.finalPromise;
			strictEqual(exhaustedReceipt.outcome, "failed");
			strictEqual(bundle.contract.snapshot().retrying.length, 0);

			const canceled = await bundle.contract.dispatch({ agentId: "coder", task: "cancel me" });
			bundle.contract.abort(canceled.runId);
			const canceledReceipt = await canceled.finalPromise;
			strictEqual(canceledReceipt.outcome, "canceled");
			strictEqual(bundle.contract.snapshot().retrying.length, 0);
			strictEqual(spawnCount, 2);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("dispatchBatch throttles at the concurrency cap instead of throwing", async () => {
		const base = stubContext();
		let activeWorkers = 0;
		const scheduling = {
			ceilingUsd: () => 5,
			checkCeiling: () => "under" as const,
			raiseCeiling: () => {},
			preflight: () => ({ verdict: "under" as const, currentUsd: 0, ceilingUsd: 5 }),
			activeWorkers: () => activeWorkers,
			tryAcquireWorker: () => {
				if (activeWorkers >= 2) return false;
				activeWorkers += 1;
				return true;
			},
			releaseWorker: () => {
				activeWorkers = Math.max(0, activeWorkers - 1);
			},
			listNodes: () => [],
		};
		const context: DomainContext = {
			...base,
			getContract: ((name: string) =>
				name === "scheduling" ? scheduling : base.getContract(name)) as DomainContext["getContract"],
		};
		const exits = Array.from({ length: 5 }, () => deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>());
		let spawnCount = 0;
		const bundle = createDispatchBundle(context, {
			spawnWorker: () => {
				const idx = spawnCount++;
				const exit = exits[idx];
				if (!exit) throw new Error("unexpected spawn");
				return {
					pid: 7200 + idx,
					promise: exit.promise,
					events: emptyEvents(),
					heartbeatAt: { current: Date.now() },
					abort: () => exit.resolve({ exitCode: 1, signal: "SIGTERM" }),
				};
			},
		});
		await bundle.extension.start();
		try {
			const batchPromise = bundle.contract.dispatchBatch(
				Array.from({ length: 5 }, (_, i) => ({ agentId: "coder", task: `batch ${i}` })),
			);
			await waitFor(() => spawnCount === 2, "batch did not fill the first two worker slots");
			exits[0]?.resolve({ exitCode: 0, signal: null });
			await waitFor(() => spawnCount === 3, "batch did not admit third job after a slot freed");
			exits[1]?.resolve({ exitCode: 0, signal: null });
			await waitFor(() => spawnCount === 4, "batch did not admit fourth job after a slot freed");
			exits[2]?.resolve({ exitCode: 0, signal: null });
			await waitFor(() => spawnCount === 5, "batch did not admit fifth job after a slot freed");
			exits[3]?.resolve({ exitCode: 0, signal: null });
			exits[4]?.resolve({ exitCode: 0, signal: null });
			const batch = await batchPromise;
			const receipts = await batch.finalPromise;
			strictEqual(receipts.length, 5);
			strictEqual(spawnCount, 5);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("snapshot reflects running entries and retry queue rows", async () => {
		const context = stubContext();
		const configContract = context.getContract<ConfigContract>("config");
		if (configContract) configContract.get().workers.maxRetries = 1;
		const runningExits = [
			deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>(),
			deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>(),
		];
		let spawnCount = 0;
		const bundle = createDispatchBundle(context, {
			spawnWorker: (spec) => {
				const idx = spawnCount++;
				if (spec.task === "fail for retry") {
					return {
						pid: 7300 + idx,
						promise: Promise.resolve({ exitCode: 1, signal: null }),
						events: emptyEvents(),
						heartbeatAt: { current: Date.now() },
						abort: () => {},
					};
				}
				const exit = runningExits[idx];
				if (!exit) throw new Error("unexpected running spawn");
				return {
					pid: 7300 + idx,
					promise: exit.promise,
					events: emptyEvents(),
					heartbeatAt: { current: Date.now() },
					abort: () => exit.resolve({ exitCode: 1, signal: "SIGTERM" }),
				};
			},
		});
		await bundle.extension.start();
		try {
			const first = await bundle.contract.dispatch({ agentId: "coder", task: "running one" });
			const second = await bundle.contract.dispatch({ agentId: "coder", task: "running two" });
			const failed = await bundle.contract.dispatch({ agentId: "coder", task: "fail for retry" });
			await failed.finalPromise;
			const snapshot = bundle.contract.snapshot();
			strictEqual(snapshot.running.length, 2);
			strictEqual(snapshot.retrying.length, 1);
			strictEqual(
				snapshot.running.every((row) => row.heartbeat === "alive"),
				true,
			);
			strictEqual(snapshot.retrying[0]?.attempt, 1);
			runningExits[0]?.resolve({ exitCode: 0, signal: null });
			runningExits[1]?.resolve({ exitCode: 0, signal: null });
			await Promise.all([first.finalPromise, second.finalPromise]);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("adopts valid orphan receipts and quarantines corrupt receipts", async () => {
		await withIsolatedClioHome(async (scratch) => {
			const projectCwd = join(scratch, "project");
			const lineage: RunLineage = { parentRunId: null, rootRunId: "root", attempt: 0, depth: 0 };
			const identity = { host: "h", user: "u", hpc: null };
			const ledger = openLedger({ maxRuns: 10 });
			const env = ledger.create({
				agentId: "coder",
				task: "orphan task",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
				sessionId: null,
				cwd: projectCwd,
			});
			const endedAt = "2026-06-10T00:00:01.000Z";
			ledger.update(env.id, {
				status: "completed",
				outcome: "succeeded",
				outcomeDetail: null,
				lineage,
				identity,
				endedAt,
				exitCode: 0,
				tokenCount: 0,
				reasoningTokenCount: 0,
				costUsd: 0,
			});
			const receiptDraft: RunReceiptDraft = {
				runId: env.id,
				agentId: "coder",
				task: "orphan task",
				targetId: "default",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
				outcome: "succeeded",
				outcomeDetail: null,
				lineage,
				identity,
				startedAt: env.startedAt,
				endedAt,
				exitCode: 0,
				tokenCount: 0,
				reasoningTokenCount: 0,
				costUsd: 0,
				compiledPromptHash: null,
				staticCompositionHash: null,
				clioVersion: "0.0.0",
				piMonoVersion: "0.0.0",
				platform: process.platform,
				nodeVersion: process.version,
				toolCalls: 0,
				toolStats: [],
				reproducibility: {
					cwd: projectCwd,
					git: { branch: null, commit: null, dirty: null, dirtyEntries: null, statusHash: null },
					safetyPolicy: {
						version: 1,
						rulePackHash: null,
						rulePackVersion: null,
						projectPolicyPath: null,
						projectPolicyHash: null,
						projectPolicyValid: null,
					},
				},
				sessionId: null,
			};
			ledger.recordReceipt(env.id, receiptDraft);
			const corruptPath = join(scratch, "state", "receipts", "corrupt.json");
			writeFileSync(corruptPath, "{not-json\n", "utf8");

			const reopened = openLedger({ maxRuns: 10 });
			strictEqual(reopened.get(env.id), null);
			const summary = recoverOrphanReceipts(reopened);
			strictEqual(summary.recovered, 1);
			strictEqual(summary.corrupt, 1);
			strictEqual(reopened.get(env.id)?.outcome, "succeeded");
			ok(existsSync(`${corruptPath}.corrupt`));
		});
	});

	it("native workers resolve permission requests without stalling and audit the denial", async () => {
		const context = stubContext();
		const configContract = context.getContract<ConfigContract>("config");
		if (configContract) configContract.get().workers.onPermission = "deny";
		const permissionEvents: unknown[] = [];
		const unsubscribe = context.bus.on(BusChannels.PermissionResolved, (payload) => {
			permissionEvents.push(payload);
		});
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		let capturedSpec: WorkerSpec | null = null;
		const bundle = createDispatchBundle(context, {
			spawnWorker: (spec) => {
				capturedSpec = spec;
				return {
					pid: 7401,
					promise: exit.promise,
					heartbeatAt: { current: Date.now() },
					abort: () => exit.resolve({ exitCode: 1, signal: "SIGTERM" }),
					events: (async function* () {
						yield {
							type: "clio_permission_resolved",
							payload: { tool: "bash", actionClass: "system_modify", mode: "deny", reason: "permission denied" },
						};
						yield {
							type: "clio_tool_finish",
							payload: {
								tool: "bash",
								posture: "operating",
								durationMs: 1,
								outcome: "blocked",
								decision: "permission_requested",
								actionClass: "system_modify",
								reason: "permission denied",
							},
						};
					})(),
				};
			},
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "need permission" });
			await drainEvents(handle.events);
			exit.resolve({ exitCode: 0, signal: null });
			const receipt = await handle.finalPromise;
			strictEqual((capturedSpec as WorkerSpec | null)?.onPermission, "deny");
			strictEqual(receipt.outcome, "succeeded");
			strictEqual(receipt.safety?.decisions.permissionRequested, 1);
			strictEqual(receipt.safety?.blockedAttempts[0]?.actionClass, "system_modify");
			strictEqual((permissionEvents[0] as { requestedBy?: string } | undefined)?.requestedBy, handle.runId);
		} finally {
			unsubscribe();
			await bundle.extension.stop?.();
		}
	});

	it("workers.onPermission=fail maps native permission exits to failed/permission_required", async () => {
		const context = stubContext();
		const configContract = context.getContract<ConfigContract>("config");
		if (configContract) configContract.get().workers.onPermission = "fail";
		let capturedSpec: WorkerSpec | null = null;
		const bundle = createDispatchBundle(context, {
			spawnWorker: (spec) => {
				capturedSpec = spec;
				return {
					pid: 7501,
					promise: Promise.resolve({ exitCode: 3, signal: null }),
					events: emptyEvents(),
					heartbeatAt: { current: Date.now() },
					abort: () => {},
				};
			},
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "fail on permission" });
			const receipt = await handle.finalPromise;
			strictEqual((capturedSpec as WorkerSpec | null)?.onPermission, "fail");
			strictEqual(receipt.outcome, "failed");
			strictEqual(receipt.outcomeDetail, "permission_required");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("ACP permission mediation resolves ask and unknown tools without operator input", async () => {
		const askSafety: SafetyContract = {
			classify: () => ({ actionClass: "system_modify", reasons: ["test"] }),
			evaluate: () => ({
				kind: "ask",
				classification: { actionClass: "system_modify", reasons: ["test"] },
				rejection: { short: "ask", detail: "ask", hints: [] },
			}),
			observeLoop: () => ({ looping: false, key: "test", count: 0 }),
			scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
			isSubset,
			audit: { recordCount: () => 0 },
		};
		const mediator = new AcpToolMediator({ safety: askSafety, cwd: "/tmp", toolGovernance: "clio-policy" });
		const askResponse = await mediator.handle({
			options: [{ optionId: "reject", kind: "reject_once" }],
			toolCall: { toolCallId: "call-ask", kind: "execute", rawInput: { command: "sudo touch /etc/nope" } },
		});
		deepStrictEqual(askResponse, { outcome: { outcome: "selected", optionId: "reject" } });
		strictEqual(mediator.snapshot().toolCallLog[0]?.decision, "denied");
		strictEqual(mediator.snapshot().toolCallLog[0]?.reason?.startsWith("permission_required"), true);

		const unknownResponse = await mediator.handle({
			options: [{ optionId: "reject2", kind: "reject_once" }],
			toolCall: { toolCallId: "call-unknown", kind: "mystery", rawInput: { tool: "launch_missiles" } },
		});
		deepStrictEqual(unknownResponse, { outcome: { outcome: "selected", optionId: "reject2" } });
		strictEqual(mediator.snapshot().toolCallLog[1]?.decision, "denied");
		strictEqual(mediator.snapshot().toolCallLog[1]?.reason, "unknown ACP tool: launch_missiles");
	});
});

describe("contracts/dispatch tool activity honesty", () => {
	function instantWorker() {
		return {
			pid: 8100,
			promise: Promise.resolve({ exitCode: 0, signal: null }),
			events: emptyEvents(),
			abort: () => {},
			heartbeatAt: { current: Date.now() },
		};
	}

	it("stamps a zero-tool succeeded run with an honest note on receipt, ledger row, and terminal payload", async () => {
		const context = stubContext();
		const completed: unknown[] = [];
		const unsubscribe = context.bus.on(BusChannels.DispatchCompleted, (payload) => {
			completed.push(payload);
		});
		const bundle = createDispatchBundle(context, { spawnWorker: instantWorker });
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "impossible write task" });
			await drainEvents(handle.events);
			const receipt = await handle.finalPromise;

			strictEqual(receipt.outcome, "succeeded");
			strictEqual(receipt.exitCode, 0);
			strictEqual(receipt.outcomeDetail, "completed without executing any tools");
			deepStrictEqual(receipt.toolActivity, {
				calls: 0,
				succeeded: 0,
				failed: 0,
				blocked: 0,
				mutatingSucceeded: false,
			});
			strictEqual(bundle.contract.getRun(handle.runId)?.outcomeDetail, "completed without executing any tools");

			const payload = completed[0] as { outcomeDetail?: string | null; toolActivity?: unknown } | undefined;
			strictEqual(payload?.outcomeDetail, "completed without executing any tools");
			deepStrictEqual(payload?.toolActivity, receipt.toolActivity);
		} finally {
			unsubscribe();
			await bundle.extension.stop?.();
		}
	});

	it("dispatch tool summary surfaces the zero-tool note to the calling model", async () => {
		const context = stubContext();
		const bundle = createDispatchBundle(context, { spawnWorker: instantWorker });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const result = await tool.run({ task: "impossible write task" }, undefined as never);
			strictEqual(result.kind, "ok");
			if (result.kind === "ok") {
				ok(result.output.includes("completed (completed without executing any tools)"), result.output);
			}
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("keeps outcomeDetail null when at least one tool call succeeded", async () => {
		const context = stubContext();
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const bundle = createDispatchBundle(context, {
			spawnWorker: () => ({
				pid: 8101,
				promise: exit.promise,
				abort: () => {},
				heartbeatAt: { current: Date.now() },
				events: (async function* () {
					yield {
						type: "clio_tool_finish",
						payload: { tool: "read", durationMs: 2, outcome: "ok", decision: "allowed" },
					};
				})(),
			}),
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "read something" });
			await drainEvents(handle.events);
			exit.resolve({ exitCode: 0, signal: null });
			const receipt = await handle.finalPromise;
			strictEqual(receipt.outcome, "succeeded");
			strictEqual(receipt.outcomeDetail, null);
			deepStrictEqual(receipt.toolActivity, {
				calls: 1,
				succeeded: 1,
				failed: 0,
				blocked: 0,
				mutatingSucceeded: false,
			});
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("notes a succeeded run whose tool calls all failed or were blocked", async () => {
		const context = stubContext();
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const bundle = createDispatchBundle(context, {
			spawnWorker: () => ({
				pid: 8102,
				promise: exit.promise,
				abort: () => {},
				heartbeatAt: { current: Date.now() },
				events: (async function* () {
					yield {
						type: "clio_tool_finish",
						payload: { tool: "write", durationMs: 2, outcome: "error", decision: "allowed" },
					};
					yield {
						type: "clio_tool_finish",
						payload: { tool: "bash", durationMs: 1, outcome: "blocked", decision: "blocked" },
					};
				})(),
			}),
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "try and fail" });
			await drainEvents(handle.events);
			exit.resolve({ exitCode: 0, signal: null });
			const receipt = await handle.finalPromise;
			strictEqual(receipt.outcome, "succeeded");
			strictEqual(receipt.outcomeDetail, "completed without a successful tool call (2 attempted: 1 failed, 1 blocked)");
			deepStrictEqual(receipt.toolActivity, {
				calls: 2,
				succeeded: 0,
				failed: 1,
				blocked: 1,
				mutatingSucceeded: false,
			});
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("summarizeToolActivity classifies mutating success through the action classifier", () => {
		const stats = new Map();
		recordToolFinish(stats, { tool: "read", durationMs: 1, outcome: "ok" });
		recordToolFinish(stats, { tool: "write", durationMs: 1, outcome: "ok" });
		recordToolFinish(stats, { tool: "write", durationMs: 1, outcome: "error" });
		const classify = (tool: string) => (tool === "write" ? ("write" as const) : ("read" as const));
		deepStrictEqual(summarizeToolActivity(stats, classify), {
			calls: 3,
			succeeded: 2,
			failed: 1,
			blocked: 0,
			mutatingSucceeded: true,
		});
		const readsOnly = new Map();
		recordToolFinish(readsOnly, { tool: "read", durationMs: 1, outcome: "ok" });
		strictEqual(summarizeToolActivity(readsOnly, classify).mutatingSucceeded, false);
		strictEqual(zeroSuccessfulToolNote(summarizeToolActivity(readsOnly, classify)), null);
		strictEqual(
			zeroSuccessfulToolNote({ calls: 0, succeeded: 0, failed: 0, blocked: 0, mutatingSucceeded: false }),
			"completed without executing any tools",
		);
	});
});
