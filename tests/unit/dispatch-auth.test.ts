import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import { createDispatchBundle } from "../../src/domains/dispatch/extension.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import type { EndpointStatus, ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { EndpointDescriptor } from "../../src/domains/providers/types/endpoint-descriptor.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { DEFAULT_SCOPE, isSubset } from "../../src/domains/safety/scope.js";

const ORIGINAL_ENV = { ...process.env };

describe("dispatch auth resolution", () => {
	let dataDir: string;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "clio-dispatch-auth-"));
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

	it("passes shared auth-resolved api keys and thinking level into worker specs", async () => {
		const endpoint: EndpointDescriptor = {
			id: "codex-pro",
			runtime: "openai-codex",
			defaultModel: "gpt-5.4",
		};
		const runtime: RuntimeDescriptor = {
			id: "openai-codex",
			displayName: "OpenAI Codex",
			kind: "http",
			apiFamily: "openai-codex-responses",
			auth: "oauth",
			defaultCapabilities: {
				...EMPTY_CAPABILITIES,
				chat: true,
				tools: true,
				reasoning: true,
				thinkingFormat: "openai-codex",
			},
			synthesizeModel: () => ({ id: "gpt-5.4", provider: "openai-codex" }) as never,
		};
		const status: EndpointStatus = {
			endpoint,
			runtime,
			available: true,
			reason: "store:oauth:openai-codex",
			health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
			capabilities: runtime.defaultCapabilities,
			discoveredModels: ["gpt-5.4", "gpt-5.4-mini"],
		};

		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.endpoints = [endpoint];
		settings.workers.default.endpoint = endpoint.id;
		settings.workers.default.model = "gpt-5.4";
		settings.workers.default.thinkingLevel = "xhigh";

		const providers: ProvidersContract = {
			list: () => [status],
			getEndpoint: (id) => (id === endpoint.id ? endpoint : null),
			getRuntime: (id) => (id === runtime.id ? runtime : null),
			probeAll: async () => {},
			probeAllLive: async () => {},
			probeEndpoint: async () => status,
			auth: {
				statusForTarget: () => ({
					providerId: "openai-codex",
					available: true,
					credentialType: "oauth",
					source: "stored-oauth",
					detail: "openai-codex",
				}),
				resolveForTarget: async () => ({
					providerId: "openai-codex",
					available: true,
					credentialType: "oauth",
					source: "stored-oauth",
					detail: "openai-codex",
					apiKey: "oauth-token",
				}),
				getStored: () => null,
				listStored: () => [],
				setApiKey: () => {},
				remove: () => {},
				login: async () => {},
				logout: () => {},
				getOAuthProviders: () => [],
			},
			credentials: {
				hasKey: () => false,
				get: () => null,
				set: () => {},
				remove: () => {},
			},
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
		};
		const context: DomainContext = {
			bus: createSafeEventBus(),
			getContract: ((name: string) => {
				if (name === "config") return config;
				if (name === "safety") return safety;
				if (name === "agents") return agents;
				if (name === "modes") return modes;
				if (name === "providers") return providers;
				return undefined;
			}) as DomainContext["getContract"],
		};

		let capturedSpec: { apiKey?: string; thinkingLevel?: string } | null = null;
		const bundle = createDispatchBundle(context, {
			spawnWorker: (spec) => {
				capturedSpec = spec;
				return {
					pid: 4242,
					promise: Promise.resolve({ exitCode: 0, signal: null }),
					events: (async function* () {})(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
				};
			},
		});
		await bundle.extension.start();

		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "run" });
			await handle.finalPromise;
			const spec = capturedSpec as { apiKey?: string; thinkingLevel?: string } | null;
			strictEqual(spec?.apiKey, "oauth-token");
			strictEqual(spec?.thinkingLevel, "xhigh");
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
