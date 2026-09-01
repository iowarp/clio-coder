import type { AgentRecipe } from "./recipe.js";
import type { AgentRecipeDiagnostic } from "./registry.js";
import type { AgentSpec } from "./spec.js";

export interface AgentsContract {
	/** Monotonic catalog revision; changes after every successful discovery. */
	revision(): number;
	/** Raw recipes as loaded from Markdown files. */
	list(): ReadonlyArray<AgentRecipe>;
	get(id: string): AgentRecipe | null;
	/** Structured quarantine diagnostics; malformed recipes never appear in list/get. */
	diagnostics(): ReadonlyArray<AgentRecipeDiagnostic>;
	/** Normalized, policy-bearing specs for catalog and dispatch consumers. */
	listSpecs(): ReadonlyArray<AgentSpec>;
	getSpec(id: string): AgentSpec | null;
	/** Discover all agents: builtins + user + project. */
	reload(): void;
}
