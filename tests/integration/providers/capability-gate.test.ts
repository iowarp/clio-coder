import { rejects, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ClioSettings } from "../../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../../src/core/defaults.js";
import type { DomainContext } from "../../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../../src/core/event-bus.js";
import { resetXdgCache } from "../../../src/core/xdg.js";
import type { AgentsContract } from "../../../src/domains/agents/contract.js";
import type { ConfigContract } from "../../../src/domains/config/contract.js";
import { createDispatchBundle } from "../../../src/domains/dispatch/extension.js";
import type { SpawnedWorker, WorkerSpec } from "../../../src/domains/dispatch/worker-spawn.js";
import type { ModesContract } from "../../../src/domains/modes/contract.js";
import type { EndpointStatus, ProvidersContract, RuntimeDescriptor } from "../../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../../src/domains/providers/index.js";
import type { EndpointDescriptor } from "../../../src/domains/providers/types/endpoint-descriptor.js";
import type { SafetyContract } from "../../../src/domains/safety/contract.js";
import { DEFAULT_SCOPE, isSubset } from "../../../src/domains/safety/scope.js";

const ORIGINAL_ENV = { ...process.env };

interface Harness {
	bundle: ReturnType<typeof createDispatchBundle>;
	spawnCalls: WorkerSpec[];
	cleanup: () => Promise<void>;
}

function setupHarness(
	toolsSupported: boolean,
	workerProfiles: ClioSettings["workers"]["profiles"] = {},
	extraStatuses: EndpointStatus[] = [],
	runtimeKind: RuntimeDescriptor["kind"] = "http",
): Harness {
	const endpoint: EndpointDescriptor = {
		id: "gated",
		runtime: "faux-runtime",
		url: "http://faux.invalid",
		defaultModel: "faux-model",
	};
	const runtime: RuntimeDescriptor = {
		id: "faux-runtime",
		displayName: "Faux",
		kind: runtimeKind,
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: {
			...EMPTY_CAPABILITIES,
			chat: true,
			tools: toolsSupported,
		},
		synthesizeModel: () => ({ id: endpoint.defaultModel, provider: "faux" }) as never,
	};
	const status: EndpointStatus = {
		endpoint,
		runtime,
		available: true,
		reason: "test",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: toolsSupported },
		discoveredModels: [],
	};
	const statuses = [status, ...extraStatuses];
	const providers: ProvidersContract = {
		list: () => statuses,
		getEndpoint: (id) => statuses.find((entry) => entry.endpoint.id === id)?.endpoint ?? null,
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

	const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	settings.endpoints = statuses.map((entry) => entry.endpoint);
	settings.workers.default.endpoint = endpoint.id;
	settings.workers.default.model = endpoint.defaultModel ?? null;
	settings.workers.profiles = workerProfiles;

	const config: ConfigContract = {
		get: () => settings,
		onChange: () => () => {},
	};
	const safety: SafetyContract = {
		classify: () => ({ actionClass: "read", reasons: [] }),
		evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "test", count: 0 }),
		scopes: { default: DEFAULT_SCOPE, readonly: DEFAULT_SCOPE, super: DEFAULT_SCOPE },
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
	const bus = createSafeEventBus();
	const context: DomainContext = {
		bus,
		getContract: ((name: string) => {
			if (name === "config") return config;
			if (name === "safety") return safety;
			if (name === "agents") return agents;
			if (name === "modes") return modes;
			if (name === "providers") return providers;
			return undefined;
		}) as DomainContext["getContract"],
	};

	const spawnCalls: WorkerSpec[] = [];
	const worker: SpawnedWorker = {
		pid: 4242,
		promise: Promise.resolve({ exitCode: 0, signal: null }),
		events: (async function* () {})(),
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
	const bundle = createDispatchBundle(context, {
		spawnWorker: (spec) => {
			spawnCalls.push(spec);
			return worker;
		},
	});

	return {
		bundle,
		spawnCalls,
		cleanup: async () => {
			try {
				await bundle.extension.stop?.();
			} catch {
				// best-effort during teardown
			}
		},
	};
}

describe("dispatch capability gate", () => {
	let dataDir: string;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "clio-capgate-"));
		process.env.CLIO_DATA_DIR = dataDir;
		resetXdgCache();
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		rmSync(dataDir, { recursive: true, force: true });
		resetXdgCache();
	});

	it("denies dispatch when requiredCapabilities is unsupported by the endpoint", async () => {
		const harness = setupHarness(false);
		try {
			await harness.bundle.extension.start();
			await rejects(
				harness.bundle.contract.dispatch({
					agentId: "coder",
					task: "needs-tools",
					requiredCapabilities: ["tools"],
				}),
				(err: Error) =>
					err.message.includes("admission denied") &&
					err.message.includes("capability 'tools'") &&
					err.message.includes("endpoint 'gated'"),
			);
			strictEqual(harness.spawnCalls.length, 0, "no worker should spawn after a gated denial");
		} finally {
			await harness.cleanup();
		}
	});

	it("admits the same dispatch when requiredCapabilities is omitted", async () => {
		const harness = setupHarness(false);
		try {
			await harness.bundle.extension.start();
			const result = await harness.bundle.contract.dispatch({
				agentId: "coder",
				task: "no-required-caps",
			});
			const receipt = await result.finalPromise;
			strictEqual(receipt.exitCode, 0);
			strictEqual(harness.spawnCalls.length, 1);
			strictEqual(harness.spawnCalls[0]?.runtimeId, "faux-runtime");
		} finally {
			await harness.cleanup();
		}
	});

	it("admits dispatch when the endpoint declares the required capability", async () => {
		const harness = setupHarness(true);
		try {
			await harness.bundle.extension.start();
			const result = await harness.bundle.contract.dispatch({
				agentId: "coder",
				task: "needs-tools",
				workerRuntime: "faux-runtime",
				requiredCapabilities: ["tools"],
			});
			const receipt = await result.finalPromise;
			strictEqual(receipt.exitCode, 0);
			strictEqual(harness.spawnCalls.length, 1);
		} finally {
			await harness.cleanup();
		}
	});

	it("selects a configured worker profile when required capabilities exceed the default", async () => {
		const profileEndpoint: EndpointDescriptor = {
			id: "tools-worker",
			runtime: "faux-runtime",
			url: "http://faux.invalid",
			defaultModel: "tools-model",
		};
		const harness = setupHarness(
			false,
			{
				tooling: {
					endpoint: profileEndpoint.id,
					model: "tools-model",
					thinkingLevel: "medium",
				},
			},
			[
				{
					endpoint: profileEndpoint,
					runtime: null,
					available: true,
					reason: "test",
					health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
					capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
					discoveredModels: [],
				},
			],
			"sdk",
		);
		try {
			await harness.bundle.extension.start();
			const result = await harness.bundle.contract.dispatch({
				agentId: "coder",
				task: "needs-tools",
				requiredCapabilities: ["tools"],
			});
			const receipt = await result.finalPromise;
			strictEqual(receipt.exitCode, 0);
			strictEqual(harness.spawnCalls.length, 1);
			strictEqual(harness.spawnCalls[0]?.endpoint.id, "tools-worker");
			strictEqual(harness.spawnCalls[0]?.wireModelId, "tools-model");
			strictEqual(harness.spawnCalls[0]?.thinkingLevel, "medium");
		} finally {
			await harness.cleanup();
		}
	});

	it("selects an explicit worker profile by name", async () => {
		const profileEndpoint: EndpointDescriptor = {
			id: "claude-sdk-opus",
			runtime: "faux-runtime",
			url: "http://faux.invalid",
			defaultModel: "claude-opus-4-7",
		};
		const harness = setupHarness(
			false,
			{
				"claude-opus": {
					endpoint: profileEndpoint.id,
					model: "claude-opus-4-7",
					thinkingLevel: "high",
				},
			},
			[
				{
					endpoint: profileEndpoint,
					runtime: null,
					available: true,
					reason: "test",
					health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
					capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
					discoveredModels: [],
				},
			],
		);
		try {
			await harness.bundle.extension.start();
			const result = await harness.bundle.contract.dispatch({
				agentId: "coder",
				task: "profile-pick",
				workerProfile: "claude-opus",
			});
			const receipt = await result.finalPromise;
			strictEqual(receipt.exitCode, 0);
			strictEqual(harness.spawnCalls.length, 1);
			strictEqual(harness.spawnCalls[0]?.endpoint.id, "claude-sdk-opus");
			strictEqual(harness.spawnCalls[0]?.wireModelId, "claude-opus-4-7");
			strictEqual(harness.spawnCalls[0]?.thinkingLevel, "high");
		} finally {
			await harness.cleanup();
		}
	});
});
