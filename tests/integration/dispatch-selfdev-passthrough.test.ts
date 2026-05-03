import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import { createDispatchBundle } from "../../src/domains/dispatch/extension.js";
import type { SpawnedWorker, WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/index.js";
import type { ModesContract } from "../../src/domains/modes/contract.js";
import { ALL_MODES } from "../../src/domains/modes/index.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import { sha256 } from "../../src/domains/prompts/hash.js";
import type { EndpointStatus, ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { EndpointDescriptor } from "../../src/domains/providers/types/endpoint-descriptor.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { DEFAULT_SCOPE, isSubset } from "../../src/domains/safety/scope.js";
import type { SelfDevMode } from "../../src/selfdev/mode.js";

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

const FAKE_PREAMBLE = "You are running under Clio self-development.\nThe repository is Clio's own source.";

function stubContext(opts: { withPreamble?: boolean } = {}): DomainContext {
	const settings = structuredClone(DEFAULT_SETTINGS);
	const endpoint: EndpointDescriptor = { id: "default", runtime: "openai", defaultModel: "gpt-4o" };
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

	const config: ConfigContract = { get: () => settings, onChange: () => () => {} };
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
		// Worker tool inheritance flows from modes.visibleTools(). Return a small
		// realistic set so the test asserts on union behavior rather than
		// accidentally on the empty-set edge case.
		visibleTools: () => new Set([ToolNames.Read, ToolNames.Bash]),
		isToolVisible: () => true,
		isActionAllowed: () => true,
		requestSuper: () => {},
		confirmSuper: () => "super",
		elevatedModeFor: () => null,
	};
	const prompts: PromptsContract = {
		compileForTurn: async () => ({
			text: "",
			renderedPromptHash: "",
			fragmentManifest: [],
			dynamicInputs: {},
		}),
		getSelfDevWorkerPreamble: () => (opts.withPreamble === false ? null : FAKE_PREAMBLE),
		reload: () => {},
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
		if (name === "prompts") return prompts;
		return undefined;
	}) as DomainContext["getContract"];
	return { bus, getContract };
}

function selfDevMode(repoRoot: string): SelfDevMode {
	return {
		enabled: true,
		source: "--dev",
		repoRoot,
		cwd: repoRoot,
		branch: "selfdev/test",
		dirtySummary: "clean",
		engineWritesAllowed: false,
	};
}

const tempDirs: string[] = [];
afterEach(() => {
	resetXdgCache();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dispatch selfdev passthrough", () => {
	it("prepends the worker preamble and grants the three private tools when selfDevMode is active", async () => {
		const repo = mkdtempSync(join(tmpdir(), "clio-dispatch-selfdev-"));
		tempDirs.push(repo);
		const context = stubContext();
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const captured: { spec?: WorkerSpec } = {};
		const bundle = createDispatchBundle(context, {
			selfDevMode: selfDevMode(repo),
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
			const handle = await bundle.contract.dispatch({
				agentId: "scout",
				task: "verify selfdev wiring",
			});
			ok(captured.spec, "spawnWorker was called");
			const spec = captured.spec;
			ok(spec.systemPrompt.startsWith(FAKE_PREAMBLE), "systemPrompt begins with the selfdev preamble");
			const allowed = new Set(spec.allowedTools ?? []);
			for (const required of [ToolNames.ClioIntrospect, ToolNames.ClioRecall, ToolNames.ClioRemember]) {
				ok(allowed.has(required), `worker allowedTools missing ${required}`);
			}
			// Inherited base tools must still be present.
			ok(allowed.has(ToolNames.Read));
			ok(allowed.has(ToolNames.Bash));
			ok(spec.selfDev, "WorkerSpec.selfDev was attached");
			strictEqual(spec.selfDev?.repoRoot, repo);
			strictEqual(spec.selfDev?.source, "--dev");
			exit.resolve({ exitCode: 0, signal: null });
			const receipt = await handle.finalPromise;
			strictEqual(receipt.exitCode, 0);
			strictEqual(receipt.compiledPromptHash, sha256(spec.systemPrompt));
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("composes preamble + memory header + recipe body in that order", async () => {
		const repo = mkdtempSync(join(tmpdir(), "clio-dispatch-selfdev-"));
		tempDirs.push(repo);
		const context = stubContext();
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const captured: { spec?: WorkerSpec } = {};
		const bundle = createDispatchBundle(context, {
			selfDevMode: selfDevMode(repo),
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
				task: "verify ordering",
				memorySection: "# Memory\n\n- m1",
				systemPrompt: "## Recipe instructions\nSpecific recipe body.",
			});
			ok(captured.spec);
			const text = captured.spec.systemPrompt;
			const preambleIdx = text.indexOf(FAKE_PREAMBLE);
			const memoryIdx = text.indexOf("# Memory");
			const recipeIdx = text.indexOf("Specific recipe body.");
			ok(
				preambleIdx >= 0 && memoryIdx > preambleIdx && recipeIdx > memoryIdx,
				`expected preamble < memory < recipe ordering, got indices ${preambleIdx},${memoryIdx},${recipeIdx}`,
			);
			exit.resolve({ exitCode: 0, signal: null });
			await handle.finalPromise;
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("emits no preamble and no private tools when selfDevMode is absent", async () => {
		const context = stubContext({ withPreamble: false });
		const exit = deferred<{ exitCode: number | null; signal: NodeJS.Signals | null }>();
		const captured: { spec?: WorkerSpec } = {};
		const bundle = createDispatchBundle(context, {
			spawnWorker: (spec: WorkerSpec): SpawnedWorker => {
				captured.spec = spec;
				return {
					pid: 4244,
					promise: exit.promise,
					events: emptyEvents(),
					abort: () => {},
					heartbeatAt: { current: Date.now() },
				};
			},
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "scout", task: "no-selfdev" });
			ok(captured.spec);
			ok(!captured.spec.systemPrompt.includes(FAKE_PREAMBLE));
			ok(!captured.spec.selfDev);
			const allowed = new Set(captured.spec.allowedTools ?? []);
			ok(!allowed.has(ToolNames.ClioIntrospect));
			ok(!allowed.has(ToolNames.ClioRecall));
			ok(!allowed.has(ToolNames.ClioRemember));
			exit.resolve({ exitCode: 0, signal: null });
			await handle.finalPromise;
		} finally {
			await bundle.extension.stop?.();
		}
	});
});

// satisfies the unused-import linter when ALL_MODES is referenced indirectly
void ALL_MODES;
