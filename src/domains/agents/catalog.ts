import type { AgentRecipe } from "./recipe.js";

const INTERNAL_AGENT_IDS = new Set(["worker"]);
const DEFAULT_DISPATCH_AGENT_ID = "implementer";

export function renderAgentCatalog(recipes: ReadonlyArray<AgentRecipe>): string {
	const publicRecipes = recipes
		.filter((recipe) => !INTERNAL_AGENT_IDS.has(recipe.id))
		.slice()
		.sort((a, b) => a.id.localeCompare(b.id));

	const lines: string[] = [
		"Clio manages a fleet of custom agents. Use the `dispatch` tool to invoke one by `agent_id` when delegation helps.",
		`Default dispatch agent: ${DEFAULT_DISPATCH_AGENT_ID}.`,
		"`worker` is internal runtime terminology; do not present it as the product concept.",
		"After a dispatch succeeds, use that receipt/output as evidence and synthesize the answer instead of repeating the same dispatch.",
	];

	if (publicRecipes.length === 0) return lines.join("\n");

	lines.push("", "Available agents:");
	for (const recipe of publicRecipes) {
		const mode = recipe.mode ?? "default";
		const source = recipe.source;
		const description = recipe.description.trim();
		const suffix = description.length > 0 ? ` - ${description}` : "";
		lines.push(`- ${recipe.id} (${mode}, ${source})${suffix}`);
	}

	return lines.join("\n");
}
