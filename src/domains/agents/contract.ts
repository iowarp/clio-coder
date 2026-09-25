import type { AgentRecipe } from "./recipe.js";
import type { AgentSpec } from "./spec.js";

export interface AgentsContract {
	/** Monotonic catalog revision; changes after discovery or external-agent settings updates. */
	revision(): number;
	/** Raw recipes as loaded from Markdown files. */
	list(): ReadonlyArray<AgentRecipe>;
	get(id: string): AgentRecipe | null;
	/** Normalized, policy-bearing specs for catalog and dispatch consumers. */
	listSpecs(): ReadonlyArray<AgentSpec>;
	getSpec(id: string): AgentSpec | null;
}
