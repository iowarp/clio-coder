import type { AgentRecipe } from "../../src/domains/agents/recipe.js";

/** Complete strict defaults for harness-local recipe fixtures. */
export function agentRecipeFixture(overrides: Partial<AgentRecipe> = {}): AgentRecipe {
	return {
		version: 1,
		id: "coder",
		name: "Coder",
		description: "Harness recipe.",
		tools: [],
		toolRequirements: { required: [], optional: [] },
		skills: [],
		boundSkillPaths: [],
		audience: "base",
		category: "implement",
		capabilityClass: "read-only",
		latencyClass: "balanced",
		projectContextTier: "none",
		// Harness recipes bypass frontmatter discovery; null preserves legacy
		// runtime-default budget coverage without weakening the strict recipe schema.
		budget: null as unknown as AgentRecipe["budget"],
		resultContract: { kind: "external-delegation" },
		tags: [],
		source: "builtin",
		filepath: "/test/coder.md",
		body: "# Harness Recipe",
		...overrides,
	};
}
