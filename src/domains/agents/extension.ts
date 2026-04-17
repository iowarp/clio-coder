import path from "node:path";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import { clioDataDir } from "../../core/xdg.js";
import type { AgentsContract } from "./contract.js";
import { parseFleet } from "./fleet-parser.js";
import type { AgentRecipe } from "./recipe.js";
import { loadRecipesFromDir, mergeRecipes } from "./registry.js";

export function createAgentsBundle(_context: DomainContext): DomainBundle<AgentsContract> {
	let recipes: ReadonlyArray<AgentRecipe> = [];

	function discover(): void {
		const builtinDir = path.join(resolvePackageRoot(), "src", "domains", "agents", "builtins");
		const userDir = path.join(clioDataDir(), "agents");
		const projectDir = path.join(process.cwd(), ".clio", "agents");
		const builtin = loadRecipesFromDir({ dir: builtinDir, source: "builtin" });
		const user = loadRecipesFromDir({ dir: userDir, source: "user" });
		const project = loadRecipesFromDir({ dir: projectDir, source: "project" });
		recipes = mergeRecipes(builtin, user, project);
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
		reload() {
			discover();
		},
		parseFleet(input: string) {
			return parseFleet(input);
		},
	};

	return { extension, contract };
}
