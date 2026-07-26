import path from "node:path";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import { clioConfigDir } from "../../core/xdg.js";
import { assertAgentIdNamespace } from "../config/agent-namespace.js";
import type { ConfigContract } from "../config/contract.js";
import type { AgentsContract } from "./contract.js";
import type { AgentRecipe } from "./recipe.js";
import { type AgentRecipeDiagnostic, loadRecipesFromDir, mergeRecipes } from "./registry.js";
import { type AgentSpec, normalizeAgentSpec } from "./spec.js";

export function createAgentsBundle(_context: DomainContext): DomainBundle<AgentsContract> {
	let recipes: ReadonlyArray<AgentRecipe> = [];
	let specs: ReadonlyArray<AgentSpec> = [];
	let diagnostics: ReadonlyArray<AgentRecipeDiagnostic> = [];

	function discover(): void {
		const builtinDir = path.join(resolvePackageRoot(), "src", "domains", "agents", "builtins");
		const userDir = path.join(clioConfigDir(), "agents");
		const projectDir = path.join(process.cwd(), ".clio", "agents");
		const nextDiagnostics: AgentRecipeDiagnostic[] = [];
		const builtin = loadRecipesFromDir({ dir: builtinDir, source: "builtin" }, nextDiagnostics);
		const user = loadRecipesFromDir({ dir: userDir, source: "user" }, nextDiagnostics);
		const project = loadRecipesFromDir({ dir: projectDir, source: "project" }, nextDiagnostics);
		const merged = mergeRecipes(builtin, user, project);
		const config = _context.getContract<ConfigContract>("config");
		assertAgentIdNamespace(merged, config?.get()?.delegation?.agents ?? []);
		recipes = merged;
		specs = recipes.map(normalizeAgentSpec);
		diagnostics = nextDiagnostics;
	}

	const extension: DomainExtension = {
		async start() {
			discover();
		},
		async stop() {},
	};

	const contract: AgentsContract = {
		list() {
			return recipes;
		},
		get(id: string): AgentRecipe | null {
			return recipes.find((r) => r.id === id) ?? null;
		},
		diagnostics() {
			return diagnostics.map((diagnostic) => ({ ...diagnostic }));
		},
		listSpecs() {
			const config = _context.getContract<ConfigContract>("config");
			const delegationAgents = config?.get()?.delegation?.agents ?? [];
			const delegationSpecs = delegationAgents.map((agent) => ({
				version: 1 as const,
				id: agent.id,
				name: agent.id,
				description: `External ACP delegation agent: ${agent.command} ${(agent.args ?? []).join(" ")}`,
				source: "custom" as const,
				filepath: "settings.yaml",
				tools: [],
				toolRequirements: { required: [], optional: [] },
				category: "explore" as const,
				capabilityClass: "orchestration" as const,
				latencyClass: "deep" as const,
				projectContextTier: "none" as const,
				audience: "custom" as const,
				tags: ["delegation", "acp"],
				skills: [],
				resultContract: { kind: "external-delegation" } as const,
				budget: { toolCalls: 1, readReserve: 0, synthesis: false },
				body: "External ACP delegation.",
			}));
			return [...specs, ...delegationSpecs];
		},
		getSpec(id: string): AgentSpec | null {
			const found = specs.find((r) => r.id === id);
			if (found) return found;
			const config = _context.getContract<ConfigContract>("config");
			const agent = config?.get()?.delegation?.agents?.find((entry) => entry.id === id);
			if (agent) {
				return {
					version: 1 as const,
					id: agent.id,
					name: agent.id,
					description: `External ACP delegation agent: ${agent.command} ${(agent.args ?? []).join(" ")}`,
					source: "custom" as const,
					filepath: "settings.yaml",
					tools: [],
					toolRequirements: { required: [], optional: [] },
					category: "explore" as const,
					capabilityClass: "orchestration" as const,
					latencyClass: "deep" as const,
					projectContextTier: "none" as const,
					audience: "custom" as const,
					tags: ["delegation", "acp"],
					skills: [],
					resultContract: { kind: "external-delegation" } as const,
					budget: { toolCalls: 1, readReserve: 0, synthesis: false },
					body: "External ACP delegation.",
				};
			}
			return null;
		},
		reload() {
			discover();
		},
	};

	return { extension, contract };
}
