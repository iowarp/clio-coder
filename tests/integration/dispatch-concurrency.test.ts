import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { AgentRecipe } from "../../src/domains/agents/recipe.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import { createDispatchBundle } from "../../src/domains/dispatch/extension.js";
import type { SpawnedWorker, WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import { BUILTIN_MIDDLEWARE_RULE_IDS, createMiddlewareBundle } from "../../src/domains/middleware/index.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import type { EndpointStatus, ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { EndpointDescriptor } from "../../src/domains/providers/types/endpoint-descriptor.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { ADVISE_SCOPE, DEFAULT_SCOPE, isSubset } from "../../src/domains/safety/scope.js";
import type { SchedulingContract } from "../../src/domains/scheduling/contract.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason?: unknown): void;
}

interface SchedulingStub extends SchedulingContract {
	stats: { acquires: number; releases: number };
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

function approvalNoops(): Pick<SpawnedWorker, "onApprovalRequest" | "sendApprovalResponse"> {
	return {
		onApprovalRequest: () => {},
		sendApprovalResponse: () => {},
	};
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 1000;
	while (Date.now() <= deadline) {
		if (predicate()) return;
		await delay(5);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function createSchedulingStub(limit: number): SchedulingStub {
	let active = 0;
	const stats = { acquires: 0, releases: 0 };
	return {
		stats,
		ceilingUsd: () => 5,
		checkCeiling: () => "under",
		raiseCeiling: () => {},
		preflight: () => ({ verdict: "under", currentUsd: 0, ceilingUsd: 5 }),
		activeWorkers: () => active,
		tryAcquireWorker: () => {
			if (active >= limit) return false;
			active += 1;
			stats.acquires += 1;
			return true;
		},
		releaseWorker: () => {
			if (active > 0) {
				active -= 1;
				stats.releases += 1;
			}
		},
		listNodes: () => [],
	};
}

function testRecipe(id: string): AgentRecipe {
	return {
		id,
		name: id,
		description: "test recipe",
		source: "builtin",
		filepath: `/test/${id}.md`,
		body: "# Test Recipe",
	};
}

function stubContext(
	scheduling: SchedulingContract,
	overrides: {
		endpoint?: EndpointDescriptor;
		runtime?: RuntimeDescriptor;
		visibleTools?: ReadonlySet<ToolName>;
	} = {},
): DomainContext & { bus: ReturnType<typeof createSafeEventBus> } {
	const settings = structuredClone(DEFAULT_SETTINGS);
	const endpoint: EndpointDescriptor = overrides.endpoint ?? {
		id: "default",
		runtime: "openai",
		defaultModel: "gpt-4o",
	};
	settings.endpoints = [endpoint];
	settings.workers.default.endpoint = endpoint.id;
	settings.workers.default.model = endpoint.defaultModel ?? "gpt-4o";

	const runtime: RuntimeDescriptor = overrides.runtime ?? {
		id: "openai",
		displayName: "OpenAI",
		kind: "http",
		apiFamily: "openai-completions",
		auth: "api-key",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true },
		synthesizeModel: () => ({ id: endpoint.defaultModel, provider: "openai" }) as never,
	};
	const status: EndpointStatus = {
		endpoint,
		runtime,
		available: true,
		reason: "test",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...EMPTY_CAPABILITIES, chat: true },
		discoveredModels: [],
	};
	const providers: ProvidersContract = {
		list: () => [status],
		getEndpoint: (id) => (id === endpoint.id ? endpoint : null),
		getRuntime: (id) => (id === runtime.id ? runtime : null),
		probeAll: async () => {},
		probeAllLive: async () => {},
		probeEndpoint: async () => status,
		disconnectEndpoint: () => status,
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
			default: DEFAULT_SCOPE,
			readonly: DEFAULT_SCOPE,
			advise: ADVISE_SCOPE,
			super: DEFAULT_SCOPE,
		},
		isSubset,
		audit: { recordCount: () => 0 },
	};

	const recipes = [testRecipe("coder")];
	const agents: AgentsContract = {
		list: () => recipes,
		get: (id) => recipes.find((recipe) => recipe.id === id) ?? null,
		reload: () => {},
		parseFleet: () => ({ steps: [] }),
	};

	const modes: ModesContract = {
		current: () => "default",
		setMode: () => "default",
		cycleNormal: () => "default",
		visibleTools: () => overrides.visibleTools ?? new Set(),
		isToolVisible: () => false,
		isActionAllowed: () => true,
		requestSuper: () => {},
		confirmSuper: () => "super",
		elevatedModeFor: () => null,
	};
	const middleware = createMiddlewareBundle().contract;

	const bus = createSafeEventBus();
	const getContract = ((name: string) => {
		if (name === "config") return config;
		if (name === "safety") return safety;
		if (name === "agents") return agents;
		if (name === "modes") return modes;
		if (name === "scheduling") return scheduling;
		if (name === "providers") return providers;
		if (name === "middleware") return middleware;
		return undefined;
	}) as DomainContext["getContract"];

	return { bus, getContract };
}

const tempDirs: string[] = [];

afterEach(() => {
	resetXdgCache();
	process.env.CLIO_DATA_DIR = undefined;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("dispatch concurrency gate", () => {
	it("rejects unknown agent recipes before acquiring a worker slot", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clio-dispatch-"));
		tempDirs.push(dataDir);
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();

		const scheduling = createSchedulingStub(1);
		const context = stubContext(scheduling);
		const bundle = createDispatchBundle(context, {
			spawnWorker: () => {
				throw new Error("worker should not spawn for an unknown agent");
			},
		});
		await bundle.extension.start();

		try {
			await rejects(bundle.contract.dispatch({ agentId: "nonesuch", task: "typo" }), /unknown agent recipe: nonesuch/);
			strictEqual(scheduling.activeWorkers(), 0);
			strictEqual(scheduling.stats.acquires, 0);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("denies a second dispatch while the first worker holds the gate and releases on success", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clio-dispatch-"));
		tempDirs.push(dataDir);
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();

		const scheduling = createSchedulingStub(1);
		const context = stubContext(scheduling);
		const firstExit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const secondExit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const activeWorkersAtSpawn: number[] = [];
		const workers: SpawnedWorker[] = [
			{
				pid: 1001,
				promise: firstExit.promise,
				events: emptyEvents(),
				abort: () => {},
				heartbeatAt: { current: Date.now() },
				...approvalNoops(),
			},
			{
				pid: 1002,
				promise: secondExit.promise,
				events: emptyEvents(),
				abort: () => {},
				heartbeatAt: { current: Date.now() },
				...approvalNoops(),
			},
		];
		const bundle = createDispatchBundle(context, {
			spawnWorker: (_spec: WorkerSpec) => {
				activeWorkersAtSpawn.push(scheduling.activeWorkers());
				const worker = workers.shift();
				if (!worker) throw new Error("missing fake worker");
				return worker;
			},
		});
		await bundle.extension.start();

		try {
			const first = await bundle.contract.dispatch({ agentId: "coder", task: "first task" });
			strictEqual(scheduling.activeWorkers(), 1);
			deepStrictEqual(activeWorkersAtSpawn, [1]);

			await rejects(bundle.contract.dispatch({ agentId: "coder", task: "second task" }), /concurrency limit reached/);
			strictEqual(scheduling.activeWorkers(), 1);

			firstExit.resolve({ exitCode: 0, signal: null });
			await first.finalPromise;
			strictEqual(scheduling.activeWorkers(), 0);
			strictEqual(scheduling.stats.releases, 1);

			const second = await bundle.contract.dispatch({ agentId: "coder", task: "third task" });
			deepStrictEqual(activeWorkersAtSpawn, [1, 1]);

			secondExit.resolve({ exitCode: 0, signal: null });
			await second.finalPromise;
			strictEqual(scheduling.activeWorkers(), 0);
			strictEqual(scheduling.stats.releases, 2);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("releases the gate after a worker exits with failure", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clio-dispatch-"));
		tempDirs.push(dataDir);
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();

		const scheduling = createSchedulingStub(1);
		const context = stubContext(scheduling);
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const bundle = createDispatchBundle(context, {
			spawnWorker: () => ({
				pid: 1003,
				promise: exit.promise,
				events: emptyEvents(),
				abort: () => {},
				heartbeatAt: { current: Date.now() },
				...approvalNoops(),
			}),
		});
		await bundle.extension.start();

		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "failing task" });
			strictEqual(scheduling.activeWorkers(), 1);

			exit.resolve({ exitCode: 1, signal: null });
			const receipt = await handle.finalPromise;

			strictEqual(receipt.exitCode, 1);
			strictEqual(scheduling.activeWorkers(), 0);
			strictEqual(scheduling.stats.releases, 1);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("dispatches batches as grouped normal worker runs", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clio-dispatch-"));
		tempDirs.push(dataDir);
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();

		const scheduling = createSchedulingStub(2);
		const context = stubContext(scheduling);
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
				if (!exit) throw new Error("missing fake batch worker");
				return {
					pid: 2000 + spawnedTasks.length,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
					...approvalNoops(),
				};
			},
		});
		await bundle.extension.start();

		try {
			const batch = await bundle.contract.dispatchBatch([
				{ agentId: "coder", task: "batch one" },
				{ agentId: "coder", task: "batch two" },
			]);
			strictEqual(batch.runIds.length, 2);
			deepStrictEqual(spawnedTasks, ["batch one", "batch two"]);
			strictEqual(scheduling.activeWorkers(), 2);
			const drained: unknown[] = [];
			for await (const event of batch.events) drained.push(event);
			ok(drained.some((event) => (event as { type?: string }).type === "batch_started"));

			for (const exit of exits) exit.resolve({ exitCode: 0, signal: null });
			const receipts = await batch.finalPromise;
			strictEqual(receipts.length, 2);
			strictEqual(
				receipts.every((receipt) => receipt.exitCode === 0),
				true,
			);
			strictEqual(scheduling.activeWorkers(), 0);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("briefly cools down a failed target instead of immediately respawning into the same failure", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clio-dispatch-"));
		tempDirs.push(dataDir);
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();

		const scheduling = createSchedulingStub(1);
		const context = stubContext(scheduling);
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
				...approvalNoops(),
			}),
		});
		await bundle.extension.start();

		try {
			const first = await bundle.contract.dispatch({ agentId: "coder", task: "fails" });
			firstExit.resolve({ exitCode: 1, signal: null });
			await first.finalPromise;

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

	it("routes subprocess runtimes through the native worker entry", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clio-dispatch-"));
		tempDirs.push(dataDir);
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();

		const endpoint: EndpointDescriptor = {
			id: "claude-cli",
			runtime: "claude-code-cli",
			defaultModel: "claude-sonnet-4-6",
		};
		const runtime: RuntimeDescriptor = {
			id: "claude-code-cli",
			displayName: "Claude Code CLI",
			kind: "subprocess",
			tier: "cli-gold",
			apiFamily: "subprocess-claude-code",
			auth: "cli",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
			synthesizeModel: () => ({ id: endpoint.defaultModel, provider: "anthropic" }) as never,
		};

		const scheduling = createSchedulingStub(1);
		const context = stubContext(scheduling, {
			endpoint,
			runtime,
			visibleTools: new Set<ToolName>(["read"]),
		});
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const captured: { spec?: WorkerSpec; opts: { cwd?: string } | undefined } = { opts: undefined };
		const bundle = createDispatchBundle(context, {
			spawnWorker: (spec, opts) => {
				captured.spec = spec;
				captured.opts = opts;
				return {
					pid: 1005,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
					...approvalNoops(),
				};
			},
		});
		await bundle.extension.start();

		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "cli task", cwd: dataDir });
			const run = bundle.contract.getRun(handle.runId);
			ok(captured.spec);
			const spec = captured.spec;

			strictEqual(spec.runtimeId, "claude-code-cli");
			strictEqual(spec.wireModelId, "claude-sonnet-4-6");
			strictEqual(spec.mode, "default");
			deepStrictEqual(spec.allowedTools, ["read"]);
			deepStrictEqual(
				spec.middlewareSnapshot?.rules.map((rule) => rule.id),
				[...BUILTIN_MIDDLEWARE_RULE_IDS],
			);
			strictEqual(spec.thinkingLevel, "off");
			strictEqual(spec.runtimeResolution?.targetId, "claude-cli");
			strictEqual(spec.runtimeResolution?.runtimeId, "claude-code-cli");
			strictEqual(spec.runtimeResolution?.wireModelId, "claude-sonnet-4-6");
			strictEqual(spec.runtimeResolution?.effectiveThinkingLevel, "off");
			strictEqual(captured.opts?.cwd, dataDir);
			strictEqual(run?.runtimeKind, "subprocess");
			strictEqual(run?.pid, 1005);

			exit.resolve({ exitCode: 0, signal: null });
			const receipt = await handle.finalPromise;
			strictEqual(receipt.exitCode, 0);
			strictEqual(receipt.runtimeResolution?.targetId, spec.runtimeResolution?.targetId);
			strictEqual(receipt.runtimeResolution?.runtimeId, spec.runtimeResolution?.runtimeId);
			strictEqual(receipt.runtimeResolution?.wireModelId, spec.runtimeResolution?.wireModelId);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("applies tool profiles before worker spec build and records the profile on receipts", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clio-dispatch-"));
		tempDirs.push(dataDir);
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();

		const scheduling = createSchedulingStub(1);
		const context = stubContext(scheduling, {
			visibleTools: new Set<ToolName>([
				ToolNames.Read,
				ToolNames.Write,
				ToolNames.Bash,
				ToolNames.RunTests,
				ToolNames.RunBuild,
				ToolNames.GitStatus,
			]),
		});
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const captured: { spec?: WorkerSpec } = {};
		const bundle = createDispatchBundle(context, {
			spawnWorker: (spec) => {
				captured.spec = spec;
				return {
					pid: 1006,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
					...approvalNoops(),
				};
			},
		});
		await bundle.extension.start();

		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				task: "profiled worker",
				cwd: dataDir,
				toolProfile: "minimal-local",
			});
			ok(captured.spec);
			deepStrictEqual(captured.spec.allowedTools, [ToolNames.Read, ToolNames.GitStatus]);

			exit.resolve({ exitCode: 0, signal: null });
			const receipt = await handle.finalPromise;
			strictEqual(receipt.safety?.toolProfile, "minimal-local");
			deepStrictEqual(receipt.safety?.requestedActions, ["read"]);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("marks native workers stale, restores them on heartbeat, and reaps dead workers", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clio-dispatch-"));
		tempDirs.push(dataDir);
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();

		const scheduling = createSchedulingStub(1);
		const context = stubContext(scheduling);
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const heartbeatAt = { current: 0 };
		let now = 0;
		let aborts = 0;
		const bundle = createDispatchBundle(context, {
			spawnWorker: () => ({
				pid: 1004,
				promise: exit.promise,
				events: emptyEvents(),
				abort: () => {
					aborts += 1;
				},
				heartbeatAt,
				...approvalNoops(),
			}),
			heartbeatSpec: { windowMs: 5, graceMs: 5 },
			heartbeatIntervalMs: 1,
			now: () => now,
		});
		await bundle.extension.start();

		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "heartbeat task" });
			strictEqual(bundle.contract.getRun(handle.runId)?.status, "running");

			now = 6;
			await waitFor(() => bundle.contract.getRun(handle.runId)?.status === "stale", "stale heartbeat status");

			heartbeatAt.current = 6;
			now = 7;
			await waitFor(() => bundle.contract.getRun(handle.runId)?.status === "running", "heartbeat recovery");

			now = 20;
			await waitFor(() => bundle.contract.getRun(handle.runId)?.status === "dead", "dead heartbeat status");
			strictEqual(aborts, 1);

			exit.resolve({ exitCode: null, signal: null });
			const receipt = await handle.finalPromise;
			strictEqual(receipt.exitCode, 1);
			strictEqual(bundle.contract.getRun(handle.runId)?.status, "dead");
			ok(bundle.contract.getRun(handle.runId)?.heartbeatAt);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("aggregates clio_tool_finish events into receipt toolCalls and toolStats", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clio-dispatch-"));
		tempDirs.push(dataDir);
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();

		const scheduling = createSchedulingStub(1);
		const context = stubContext(scheduling);
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const events = (async function* () {
			yield {
				type: "clio_tool_finish",
				payload: { tool: "read", mode: "default", durationMs: 12, outcome: "ok", decision: "allowed" },
			};
			yield {
				type: "clio_tool_finish",
				payload: { tool: "read", mode: "default", durationMs: 8, outcome: "ok", decision: "allowed" },
			};
			yield {
				type: "clio_tool_finish",
				payload: { tool: "bash", mode: "default", durationMs: 50, outcome: "error", reason: "boom", decision: "allowed" },
			};
			yield {
				type: "clio_tool_finish",
				payload: {
					tool: "bash",
					mode: "default",
					durationMs: 0,
					outcome: "blocked",
					reason: "denied",
					decision: "blocked",
					ruleId: "bash-default-deny",
					reasonCode: "bash-default-deny",
					policySource: "builtin-command-allowlist",
					actionClass: "execute",
				},
			};
		})();
		const bundle = createDispatchBundle(context, {
			spawnWorker: () => ({
				pid: 1006,
				promise: exit.promise,
				events,
				abort: () => {},
				heartbeatAt: { current: Date.now() },
				...approvalNoops(),
			}),
		});
		await bundle.extension.start();

		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "tool stats task" });
			const drained = (async () => {
				for await (const _ of handle.events) {
					// drain so the dispatch enricher actually runs
				}
			})();
			await drained;

			exit.resolve({ exitCode: 0, signal: null });
			const receipt = await handle.finalPromise;

			strictEqual(receipt.toolCalls, 4);
			deepStrictEqual(receipt.toolStats, [
				{ tool: "bash", count: 2, ok: 0, errors: 1, blocked: 1, totalDurationMs: 50 },
				{ tool: "read", count: 2, ok: 2, errors: 0, blocked: 0, totalDurationMs: 20 },
			]);
			deepStrictEqual(receipt.safety?.decisions, { allowed: 3, blocked: 1, elevated: 0 });
			deepStrictEqual(receipt.safety?.blockedAttempts, [
				{
					tool: "bash",
					mode: "default",
					actionClass: "execute",
					ruleId: "bash-default-deny",
					reasonCode: "bash-default-deny",
					policySource: "builtin-command-allowlist",
					reason: "denied",
				},
			]);
			strictEqual(receipt.reproducibility?.cwd, process.cwd());
			strictEqual(receipt.reproducibility?.safetyPolicy.rulePackHash, null);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("folds provider reasoning token details into dispatch receipts", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clio-dispatch-"));
		tempDirs.push(dataDir);
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();

		const scheduling = createSchedulingStub(1);
		const context = stubContext(scheduling);
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const events = (async function* () {
			yield {
				type: "message_end",
				message: {
					role: "assistant",
					usage: {
						input: 100,
						output: 40,
						output_tokens_details: { reasoning_tokens: 12 },
					},
					model: "openrouter/auto",
					responseModel: "anthropic/claude-sonnet-4.6",
					responseId: "resp-1",
				},
			};
		})();
		const bundle = createDispatchBundle(context, {
			spawnWorker: () => ({
				pid: 1007,
				promise: exit.promise,
				events,
				abort: () => {},
				heartbeatAt: { current: Date.now() },
				...approvalNoops(),
			}),
		});
		await bundle.extension.start();

		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "reasoning usage task" });
			for await (const _ of handle.events) {
				// drain so token accounting observes the worker message_end event
			}

			exit.resolve({ exitCode: 0, signal: null });
			const receipt = await handle.finalPromise;
			const envelope = bundle.contract.getRun(handle.runId);

			strictEqual(receipt.tokenCount, 140);
			strictEqual(receipt.inputTokenCount, 100);
			strictEqual(receipt.outputTokenCount, 40);
			strictEqual(receipt.cacheReadTokenCount, 0);
			strictEqual(receipt.cacheWriteTokenCount, 0);
			strictEqual(receipt.reasoningTokenCount, 12);
			ok(receipt.staticCompositionHash);
			deepStrictEqual(receipt.upstreamResponses, [
				{
					model: "openrouter/auto",
					responseModel: "anthropic/claude-sonnet-4.6",
					responseId: "resp-1",
				},
			]);
			strictEqual(envelope?.tokenCount, 140);
			strictEqual(envelope?.reasoningTokenCount, 12);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("preserves provider prompt-cache usage fields in dispatch receipts and ledger rows", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clio-dispatch-"));
		tempDirs.push(dataDir);
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();

		const scheduling = createSchedulingStub(1);
		const context = stubContext(scheduling);
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const events = (async function* () {
			yield {
				type: "message_end",
				message: {
					role: "assistant",
					usage: {
						input: 100,
						output: 40,
						cacheRead: 700,
						cacheWrite: 50,
					},
				},
			};
		})();
		const bundle = createDispatchBundle(context, {
			spawnWorker: () => ({
				pid: 1009,
				promise: exit.promise,
				events,
				abort: () => {},
				heartbeatAt: { current: Date.now() },
				...approvalNoops(),
			}),
		});
		await bundle.extension.start();

		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "cache usage task" });
			for await (const _ of handle.events) {
				// drain so token accounting observes the worker message_end event
			}

			exit.resolve({ exitCode: 0, signal: null });
			const receipt = await handle.finalPromise;
			const envelope = bundle.contract.getRun(handle.runId);

			strictEqual(receipt.tokenCount, 890);
			strictEqual(receipt.inputTokenCount, 100);
			strictEqual(receipt.outputTokenCount, 40);
			strictEqual(receipt.cacheReadTokenCount, 700);
			strictEqual(receipt.cacheWriteTokenCount, 50);
			strictEqual(envelope?.tokenCount, 890);
			strictEqual(envelope?.cacheReadTokenCount, 700);
			strictEqual(envelope?.cacheWriteTokenCount, 50);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("records provider failure messages on dispatch receipts", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clio-dispatch-"));
		tempDirs.push(dataDir);
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();

		const scheduling = createSchedulingStub(1);
		const context = stubContext(scheduling);
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const events = (async function* () {
			yield {
				type: "message_end",
				message: {
					role: "assistant",
					usage: { input: 0, output: 0 },
					model: "openrouter/free",
					stopReason: "error",
					errorMessage: "401 User not found.",
				},
			};
		})();
		const bundle = createDispatchBundle(context, {
			spawnWorker: () => ({
				pid: 1008,
				promise: exit.promise,
				events,
				abort: () => {},
				heartbeatAt: { current: Date.now() },
				...approvalNoops(),
			}),
		});
		await bundle.extension.start();

		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "failing provider task" });
			for await (const _ of handle.events) {
				// drain so failure accounting observes the worker message_end event
			}

			exit.resolve({ exitCode: 1, signal: null });
			const receipt = await handle.finalPromise;

			strictEqual(receipt.exitCode, 1);
			strictEqual(receipt.failureMessage, "401 User not found.");
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
