import type { Fleet } from "./fleet-parser.js";
import type { AgentRecipe } from "./recipe.js";
import type { AgentSpec } from "./spec.js";

export interface AgentsContract {
	/** Raw recipes as loaded from Markdown files. */
	list(): ReadonlyArray<AgentRecipe>;
	get(id: string): AgentRecipe | null;
	/** Normalized, policy-bearing specs for catalog and dispatch consumers. */
	listSpecs(): ReadonlyArray<AgentSpec>;
	getSpec(id: string): AgentSpec | null;
	/** Discover all agents: builtins + user + project. */
	reload(): void;
	/** Parse a fleet string via the fleet-parser. */
	parseFleet(input: string): Fleet;
}
