/**
 * Minimal DomainContext stub for dispatch-bundle contract tests: one healthy
 * openai-compat target, the production builtin agent recipes, a permissive safety
 * contract, and an under-budget scheduling gate. Callers override individual
 * contracts by wrapping getContract.
 */

import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import type { AgentRecipe } from "../../src/domains/agents/recipe.js";
import { loadRecipesFromDir } from "../../src/domains/agents/registry.js";
import { normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import type { ConfigContract } from "../../src/domains/config/contract.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/index.js";
import type { ProvidersContract, RuntimeDescriptor, TargetStatus } from "../../src/domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { CONFIRMED_SCOPE, isSubset, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import type { SchedulingContract } from "../../src/domains/scheduling/contract.js";

export interface DispatchStubOptions {
	settings?: typeof DEFAULT_SETTINGS;
	scheduling?: Partial<SchedulingContract>;
	runtime?: RuntimeDescriptor;
	/** Deliberately constrains only the coder's tools, capability, requirements, and now-unreachable bound skills. */
	agentTools?: ReadonlyArray<ToolName>;
	/** With agentTools, deliberately removes the coder's exact budget so opaque-runtime policy tests reach telemetry. */
	useRuntimeDefaultAgentBudget?: boolean;
}

export function dispatchStubContext(options: DispatchStubOptions = {}): DomainContext {
	const settings = options.settings ?? structuredClone(DEFAULT_SETTINGS);
	const target: TargetDescriptor = settings.targets[0] ?? { id: "default", runtime: "openai", defaultModel: "gpt-4o" };
	if (settings.targets.length === 0) {
		settings.targets = [target];
		settings.fleet.default.target = target.id;
		settings.fleet.default.model = target.defaultModel ?? "gpt-4o";
	}
	const runtime: RuntimeDescriptor = options.runtime ?? {
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
		observeLoop: () => ({ looping: false, key: "test", count: 0 }),
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset,
		audit: { recordCount: () => 0 },
	};
	const builtinRecipes = loadRecipesFromDir({
		dir: join(resolvePackageRoot(), "src", "domains", "agents", "builtins"),
		source: "builtin",
		cwd: process.cwd(),
	});
	const agentToolsOverride = options.agentTools;
	const recipes: ReadonlyArray<AgentRecipe> =
		agentToolsOverride === undefined
			? builtinRecipes
			: builtinRecipes.map((recipe) => {
					if (recipe.id !== "coder") return recipe;
					// Some dispatch policy tests need a deliberately constrained coder.
					// Every field outside this option's documented seams still comes from
					// the shipped recipe.
					const agentTools = [...agentToolsOverride];
					const capabilityClass = agentTools.some((tool) => tool === ToolNames.Write || tool === ToolNames.Edit)
						? "workspace-edit"
						: "read-only";
					return {
						...recipe,
						tools: agentTools,
						toolRequirements: { required: agentTools, optional: [] },
						capabilityClass,
						// A constrained surface without context cannot load the coder's bound
						// skills. Keep this test-only override internally policy-consistent.
						...(agentTools.includes(ToolNames.Context) ? {} : { skills: [], boundSkillPaths: [] }),
						...(options.useRuntimeDefaultAgentBudget ? { budget: null as unknown as AgentRecipe["budget"] } : {}),
					};
				});
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
		maxWorkers: () => 4,
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
