import type { Fleet } from "./fleet-parser.js";
import type { AgentRecipe } from "./recipe.js";

export interface AgentsContract {
	list(): ReadonlyArray<AgentRecipe>;
	get(id: string): AgentRecipe | null;
	/** Discover all agents: builtins + user + project. */
	reload(): void;
	/** Parse a fleet string via the fleet-parser. */
	parseFleet(input: string): Fleet;
}
