import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import { createDispatchBundle } from "../../src/domains/dispatch/extension.js";
import type { WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/index.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import type { EndpointStatus, ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { EndpointDescriptor } from "../../src/domains/providers/types/endpoint-descriptor.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { ADVISE_SCOPE, DEFAULT_SCOPE, isSubset } from "../../src/domains/safety/scope.js";

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

function stubContext(): DomainContext {
	const settings = structuredClone(DEFAULT_SETTINGS);
	const endpoint: EndpointDescriptor = {
		id: "default",
		runtime: "openai",
		defaultModel: "gpt-4o",
	};
	settings.endpoints = [endpoint];
	settings.workers.default.endpoint = endpoint.id;
	settings.workers.default.model = endpoint.defaultModel ?? "gpt-4o";

	const runtime: RuntimeDescriptor = {
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

	const recipes = [
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
		reload: () => {},
		parseFleet: () => ({ steps: [] }),
	};

	const modes: ModesContract = {
		current: () => "default",
		setMode: () => "default",
		cycleNormal: () => "default",
		visibleTools: () => new Set(),
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
					task: "t",
					endpoint: { id: "e", runtime: "x" } as never,
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
});
