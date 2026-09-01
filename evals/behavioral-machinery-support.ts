import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../src/core/defaults.js";
import type { DomainContext } from "../src/core/domain-loader.js";
import { createSafeEventBus } from "../src/core/event-bus.js";
import { resolvePackageRoot } from "../src/core/package-root.js";
import { resetXdgCache } from "../src/core/xdg.js";
import type { AgentsContract } from "../src/domains/agents/contract.js";
import { loadRecipesFromDir } from "../src/domains/agents/registry.js";
import { normalizeAgentSpec } from "../src/domains/agents/spec.js";
import type { ConfigContract } from "../src/domains/config/contract.js";
import { createDispatchBundle } from "../src/domains/dispatch/extension.js";
import type { RunReceiptReproducibility } from "../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../src/domains/dispatch/worker-spawn.js";
import { createMiddlewareBundle } from "../src/domains/middleware/index.js";
import { compileWorker } from "../src/domains/prompts/compiler.js";
import type { PromptsContract } from "../src/domains/prompts/contract.js";
import { customizationFragments } from "../src/domains/prompts/extension.js";
import { loadFragments } from "../src/domains/prompts/fragment-loader.js";
import type { ProvidersContract, RuntimeDescriptor, TargetStatus } from "../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../src/domains/providers/index.js";
import type { TargetDescriptor } from "../src/domains/providers/types/target-descriptor.js";
import type { SafetyContract } from "../src/domains/safety/contract.js";
import type { SafetyPolicyMetadata } from "../src/domains/safety/policy-engine.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../src/domains/safety/scope.js";
import type { SchedulingContract } from "../src/domains/scheduling/contract.js";
import type { WorkerSpec } from "../src/worker/spec-contract.js";

let isolated: { dir: string; env: NodeJS.ProcessEnv } | null = null;

/** Isolate the standalone driver from the operator's durable Clio state. */
export async function isolateDispatchState(): Promise<void> {
	restoreDispatchState();
	const dir = mkdtempSync(join(tmpdir(), "clio-eval-dispatch-"));
	isolated = { dir, env: { ...process.env } };
	Object.assign(process.env, {
		CLIO_CODER_HOME: dir,
		CLIO_CODER_DATA_DIR: join(dir, "data"),
		CLIO_CODER_CONFIG_DIR: join(dir, "config"),
		CLIO_CODER_STATE_DIR: join(dir, "state"),
		CLIO_CODER_CACHE_DIR: join(dir, "cache"),
	});
	resetXdgCache();
}

export function restoreDispatchState(): void {
	if (isolated === null) return;
	for (const key of Object.keys(process.env)) {
		if (!(key in isolated.env)) Reflect.deleteProperty(process.env, key);
	}
	for (const [key, value] of Object.entries(isolated.env)) {
		if (value !== undefined) process.env[key] = value;
	}
	rmSync(isolated.dir, { recursive: true, force: true });
	isolated = null;
	resetXdgCache();
}

/** Use production dispatch and prompt compilation with deterministic local boundaries. */
export function makeDispatchBundle(
	context: Parameters<typeof createDispatchBundle>[0],
	options: Parameters<typeof createDispatchBundle>[1] = {},
): ReturnType<typeof createDispatchBundle> {
	const promptTable = loadFragments();
	const prompts: PromptsContract = {
		compileSessionPrompt: async () => {
			throw new Error("behavioral machinery does not compile session prompts");
		},
		compileWorkerPrompt: async (input) => {
			const customization = customizationFragments(input.cwd ?? process.cwd(), input.workingContextPaths ?? []);
			const compiled = compileWorker(promptTable, { ...input, additionalFragments: customization.fragments });
			return {
				...compiled,
				rulesApplied: customization.activeRuleIds,
				operatorProfileApplied: customization.operatorProfileApplied,
			};
		},
		reload() {},
	};
	const wrapped = {
		bus: context.bus,
		getContract<T extends object>(name: string): T | undefined {
			if (name === "prompts") return prompts as T;
			return context.getContract<T>(name);
		},
	};
	return createDispatchBundle(wrapped, { collectReproducibility: fastReproducibility, ...options });
}

function fastReproducibility(cwd: string, safety: SafetyPolicyMetadata | null): RunReceiptReproducibility {
	return {
		cwd,
		git: { branch: null, commit: null, dirty: null, dirtyEntries: null, statusHash: null },
		safetyPolicy: {
			version: safety?.version ?? 1,
			rulePackHash: safety?.rulePackHash ?? null,
			rulePackVersion: safety?.rulePackVersion ?? null,
			projectPolicyPath: safety?.projectPolicyPath ?? null,
			projectPolicyHash: safety?.projectPolicyHash ?? null,
			projectPolicyValid: safety?.projectPolicyValid ?? null,
		},
	};
}

/** Minimal deterministic production context for the offline authority corpus. */
export function dispatchStubContext(): DomainContext {
	const settings = structuredClone(DEFAULT_SETTINGS);
	const target: TargetDescriptor = settings.targets[0] ?? {
		id: "default",
		runtime: "openai",
		defaultModel: "gpt-4o",
	};
	if (settings.targets.length === 0) {
		settings.targets = [target];
		settings.fleet.default.target = target.id;
		settings.fleet.default.model = target.defaultModel ?? "gpt-4o";
	}
	const runtime: RuntimeDescriptor = {
		id: target.runtime,
		displayName: "OpenAI",
		kind: "http",
		apiFamily: "openai-completions",
		auth: "api-key",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
		synthesizeModel: () => ({ id: target.defaultModel, provider: target.runtime }) as never,
	};
	const statuses: TargetStatus[] = settings.targets.map((configuredTarget) => ({
		target: configuredTarget,
		runtime,
		available: true,
		reason: "deterministic eval",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...runtime.defaultCapabilities },
		discoveredModels: [],
	}));
	const fallbackStatus = statuses[0];
	if (fallbackStatus === undefined) throw new Error("behavioral machinery requires one target");
	const providers = {
		list: () => statuses,
		getTarget: (id: string) => settings.targets.find((entry) => entry.id === id) ?? null,
		getRuntime: (id: string) => (id === runtime.id ? runtime : null),
		probeAll: async () => {},
		probeAllLive: async () => {},
		probeTarget: async (id: string) => statuses.find((entry) => entry.target.id === id) ?? fallbackStatus,
		disconnectTarget: (id: string) => statuses.find((entry) => entry.target.id === id) ?? fallbackStatus,
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
			damageReason: () => null,
			getOAuthProviders: () => [],
			setRuntimeOverrideForTarget: () => {},
			clearRuntimeOverrideForTarget: () => {},
		},
		getDetectedReasoning: () => null,
		probeReasoningForModel: async () => null,
		knowledgeBase: null,
	} satisfies ProvidersContract;
	const config: ConfigContract = { get: () => settings, onChange: () => () => {} };
	const safety: SafetyContract = {
		classify: () => ({ actionClass: "read", reasons: [] }),
		evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "eval", count: 0 }),
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset,
		audit: { recordCount: () => 0 },
	};
	const recipes = loadRecipesFromDir({
		dir: join(resolvePackageRoot(), "src", "domains", "agents", "builtins"),
		source: "builtin",
		cwd: process.cwd(),
	});
	const agents: AgentsContract = {
		list: () => recipes,
		get: (id) => recipes.find((recipe) => recipe.id === id) ?? null,
		diagnostics: () => [],
		listSpecs: () => recipes.map(normalizeAgentSpec),
		getSpec: (id) => {
			const recipe = recipes.find((entry) => entry.id === id);
			return recipe === undefined ? null : normalizeAgentSpec(recipe);
		},
		reload: () => {},
	};
	const middleware = createMiddlewareBundle().contract;
	const scheduling: SchedulingContract = {
		ceilingUsd: () => 5,
		checkCeiling: () => "under",
		raiseCeiling: () => {},
		preflight: () => ({ verdict: "under", currentUsd: 0, ceilingUsd: 5 }),
		maxWorkers: () => 4,
	};
	const bus = createSafeEventBus();
	const getContract = ((name: string) => {
		if (name === "config") return config;
		if (name === "safety") return safety;
		if (name === "agents") return agents;
		if (name === "providers") return providers;
		if (name === "middleware") return middleware;
		if (name === "scheduling") return scheduling;
		return undefined;
	}) as DomainContext["getContract"];
	return { bus, getContract };
}

/** Script one worker result without importing the repository test harness. */
export function scriptedGateFabric(script: { builderText: string; builderWritesFile?: string }): {
	spawn: (spec: WorkerSpec, options?: { cwd?: string }) => SpawnedWorker;
} {
	let nextPid = 300;
	return {
		spawn(_spec, options) {
			if (script.builderWritesFile !== undefined && options?.cwd !== undefined) {
				writeFileSync(join(options.cwd, script.builderWritesFile), `work in ${options.cwd}\n`);
			}
			const events = (async function* () {
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						content: script.builderText,
						usage: { input: 1, output: 1 },
					},
				};
			})();
			nextPid += 1;
			return {
				pid: nextPid,
				promise: Promise.resolve({ exitCode: 0, signal: null }),
				events,
				abort: () => {},
				heartbeatAt: { current: Date.now() },
			};
		},
	};
}
