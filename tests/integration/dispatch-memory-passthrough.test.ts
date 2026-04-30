import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import { createDispatchBundle } from "../../src/domains/dispatch/extension.js";
import type { SpawnedWorker, WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import { MEMORY_VERSION } from "../../src/domains/memory/types.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/index.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import type { EndpointStatus, ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { EndpointDescriptor } from "../../src/domains/providers/types/endpoint-descriptor.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { DEFAULT_SCOPE, isSubset } from "../../src/domains/safety/scope.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function emptyEvents(): AsyncIterableIterator<unknown> {
	return (async function* () {})();
}

function stubContext(): DomainContext & { bus: ReturnType<typeof createSafeEventBus> } {
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
			super: DEFAULT_SCOPE,
		},
		isSubset,
		audit: { recordCount: () => 0 },
	};

	const agents: AgentsContract = {
		list: () => [],
		get: () => null,
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
		if (name === "providers") return providers;
		if (name === "middleware") return middleware;
		return undefined;
	}) as DomainContext["getContract"];

	return { bus, getContract };
}

const tempDirs: string[] = [];

afterEach(() => {
	resetXdgCache();
	delete process.env.CLIO_DATA_DIR;
	delete process.env.CLIO_HOME;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("dispatch memory passthrough", () => {
	it("forwards a non-empty memorySection into WorkerSpec.systemPrompt verbatim", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clio-dispatch-mem-"));
		tempDirs.push(dataDir);
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();

		// Seed a valid approved + evidence-linked memory store on disk so a
		// future caller (orchestrator/cli) would pick it up. The test itself
		// passes the rendered section directly through DispatchRequest.
		mkdirSync(join(dataDir, "memory"), { recursive: true });
		const store = {
			version: MEMORY_VERSION,
			records: [
				{
					id: "mem-0123456789abcdef",
					scope: "repo",
					key: "test-key",
					lesson: "do the thing",
					evidenceRefs: ["ev-test"],
					appliesWhen: ["always"],
					avoidWhen: [],
					confidence: 0.9,
					createdAt: "2026-04-29T00:00:00.000Z",
					approved: true,
				},
			],
		};
		writeFileSync(join(dataDir, "memory", "records.json"), JSON.stringify(store, null, 2));

		const context = stubContext();
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const captured: { spec?: WorkerSpec } = {};
		const bundle = createDispatchBundle(context, {
			spawnWorker: (spec: WorkerSpec): SpawnedWorker => {
				captured.spec = spec;
				return {
					pid: 4242,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
				};
			},
		});
		await bundle.extension.start();

		try {
			const memorySection =
				"# Memory\n\nApproved long-term memory records that may apply.\n\n- [mem-0123456789abcdef] (scope=repo) do the thing Evidence: ev-test.";
			const handle = await bundle.contract.dispatch({
				agentId: "scout",
				task: "verify memory threading",
				memorySection,
			});
			ok(captured.spec, "spawnWorker was called");
			ok(captured.spec.systemPrompt.startsWith("# Memory"), "systemPrompt begins with the memory header");
			ok(captured.spec.systemPrompt.includes("mem-0123456789abcdef"), "rendered memory record id flows through");
			exit.resolve({ exitCode: 0, signal: null });
			const receipt = await handle.finalPromise;
			strictEqual(receipt.exitCode, 0);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("leaves systemPrompt empty when no memorySection is supplied and no recipe is present", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "clio-dispatch-mem-"));
		tempDirs.push(dataDir);
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();

		const context = stubContext();
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const captured: { spec?: WorkerSpec } = {};
		const bundle = createDispatchBundle(context, {
			spawnWorker: (spec: WorkerSpec): SpawnedWorker => {
				captured.spec = spec;
				return {
					pid: 4243,
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
				agentId: "scout",
				task: "no memory case",
			});
			ok(captured.spec);
			strictEqual(captured.spec.systemPrompt, "");
			exit.resolve({ exitCode: 0, signal: null });
			await handle.finalPromise;
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
