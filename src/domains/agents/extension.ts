import path from "node:path";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import { clioDataDir } from "../../core/xdg.js";
import type { ConfigContract } from "../config/contract.js";
import type { AgentsContract } from "./contract.js";
import { parseFleet } from "./fleet-parser.js";
import type { AgentRecipe } from "./recipe.js";
import { loadRecipesFromDir, mergeRecipes } from "./registry.js";
import { type AgentSpec, normalizeAgentSpec } from "./spec.js";

export function createAgentsBundle(_context: DomainContext): DomainBundle<AgentsContract> {
	let recipes: ReadonlyArray<AgentRecipe> = [];
	let specs: ReadonlyArray<AgentSpec> = [];

	function discover(): void {
		const builtinDir = path.join(resolvePackageRoot(), "src", "domains", "agents", "builtins");
		const userDir = path.join(clioDataDir(), "agents");
		const projectDir = path.join(process.cwd(), ".clio", "agents");
		const builtin = loadRecipesFromDir({ dir: builtinDir, source: "builtin" });
		const user = loadRecipesFromDir({ dir: userDir, source: "user" });
		const project = loadRecipesFromDir({ dir: projectDir, source: "project" });
		recipes = mergeRecipes(builtin, user, project);
		specs = recipes.map(normalizeAgentSpec);
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
		listSpecs() {
			const config = _context.getContract<ConfigContract>("config");
			const delegationAgents = config?.get()?.delegation?.agents ?? [];
			const delegationSpecs = delegationAgents.map((agent) => ({
				id: agent.id,
				name: agent.id,
				description: `External ACP delegation agent: ${agent.command} ${(agent.args ?? []).join(" ")}`,
				source: "custom" as const,
				filepath: "settings.yaml",
				mode: "default" as const,
				tools: [],
				category: "explore" as const,
				capabilityClass: "orchestration" as const,
				latencyClass: "deep" as const,
				audience: "custom" as const,
				tags: ["delegation", "acp"],
				skills: [],
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
					id: agent.id,
					name: agent.id,
					description: `External ACP delegation agent: ${agent.command} ${(agent.args ?? []).join(" ")}`,
					source: "custom" as const,
					filepath: "settings.yaml",
					mode: "default" as const,
					tools: [],
					category: "explore" as const,
					capabilityClass: "orchestration" as const,
					latencyClass: "deep" as const,
					audience: "custom" as const,
					tags: ["delegation", "acp"],
					skills: [],
				};
			}
			return null;
		},
		reload() {
			discover();
		},
		parseFleet(input: string) {
			return parseFleet(input);
		},
	};

	return { extension, contract };
}
