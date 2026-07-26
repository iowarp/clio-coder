/**
 * Minimal DomainContext stub for dispatch-bundle contract tests: one healthy
 * openai-compat target, a permissive safety contract, a `coder` recipe plus the
 * builtin `verifier` every quality gate defaults to, and an under-budget
 * scheduling gate. Callers override individual contracts by wrapping getContract.
 */

import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { AgentRecipe } from "../../src/domains/agents/recipe.js";
import { normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/index.js";
import type { ProvidersContract, RuntimeDescriptor, TargetStatus } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import type { SchedulingContract } from "../../src/domains/scheduling/contract.js";
import { agentRecipeFixture } from "./agent-recipe.js";

export interface DispatchStubOptions {
	settings?: typeof DEFAULT_SETTINGS;
	scheduling?: Partial<SchedulingContract>;
}

export function dispatchStubContext(options: DispatchStubOptions = {}): DomainContext {
	const settings = options.settings ?? structuredClone(DEFAULT_SETTINGS);
	const target: TargetDescriptor = settings.targets[0] ?? { id: "default", runtime: "openai", defaultModel: "gpt-4o" };
	if (settings.targets.length === 0) {
		settings.targets = [target];
		settings.workers.default.target = target.id;
		settings.workers.default.model = target.defaultModel ?? "gpt-4o";
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
		reason: "test",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...runtime.defaultCapabilities },
		discoveredModels: [],
	}));
	const fallbackStatus = statuses[0];
	if (!fallbackStatus) throw new Error("dispatch stub requires at least one target status");
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
			getOAuthProviders: () => [],
			setRuntimeOverrideForTarget: () => {},
			clearRuntimeOverrideForTarget: () => {},
		},
		credentials: { hasKey: () => false, get: () => null, set: () => {}, remove: () => {} },
		getDetectedReasoning: () => null,
		probeReasoningForModel: async () => null,
		knowledgeBase: null,
	} satisfies ProvidersContract;
	const config: ConfigContract = { get: () => settings, onChange: () => () => {} };
	const safety: SafetyContract = {
		classify: () => ({ actionClass: "read", reasons: [] }),
		evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
		observeLoop: () => ({ looping: false, key: "test", count: 0 }),
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset,
		audit: { recordCount: () => 0 },
	};
	const recipes: ReadonlyArray<AgentRecipe> = [
		{
			...agentRecipeFixture(),
			toolRequirements: { required: [], optional: [] },
			id: "coder",
			name: "coder",
			description: "test recipe",
			source: "builtin" as const,
			filepath: "/test/coder.md",
			body: "# Test Recipe",
		},
		{
			// Review and compete gates default to the builtin Verifier, so the stub
			// fleet must offer it or every gated dispatch fails admission.
			...agentRecipeFixture(),
			tools: [ToolNames.Verify],
			toolRequirements: { required: [ToolNames.Verify], optional: [] },
			id: "verifier",
			name: "verifier",
			description: "test verifier recipe",
			capabilityClass: "verification" as const,
			resultContract: { kind: "verifier-report" as const },
			source: "builtin" as const,
			filepath: "/test/verifier.md",
			body: "# Test Verifier Recipe",
		},
	];
	const agents: AgentsContract = {
		list: () => recipes,
		get: (id) => recipes.find((recipe) => recipe.id === id) ?? null,
		diagnostics: () => [],
		listSpecs: () => recipes.map(normalizeAgentSpec),
		getSpec: (id) => {
			const recipe = recipes.find((entry) => entry.id === id);
			return recipe ? normalizeAgentSpec(recipe) : null;
		},
		reload: () => {},
	};
	const middleware = createMiddlewareBundle().contract;
	const scheduling: SchedulingContract = {
		ceilingUsd: () => 5,
		checkCeiling: () => "under",
		raiseCeiling: () => {},
		preflight: () => ({ verdict: "under", currentUsd: 0, ceilingUsd: 5 }),
		activeWorkers: () => 0,
		tryAcquireWorker: () => true,
		releaseWorker: () => {},
		listNodes: () => [],
		...options.scheduling,
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
