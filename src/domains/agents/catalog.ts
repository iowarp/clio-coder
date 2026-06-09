import type { AgentRecipe } from "./recipe.js";
import { type AgentSpec, isUserVisibleAgent, normalizeAgentSpec } from "./spec.js";

const DEFAULT_DISPATCH_AGENT_ID = "coder";

export interface AgentCatalogSections {
	stable: string;
	volatile: string;
}

export function renderAgentCatalogSections(recipes: ReadonlyArray<AgentRecipe>): AgentCatalogSections {
	const specs = recipes
		.map(normalizeAgentSpec)
		.slice()
		.sort((a, b) => {
			const category = a.category.localeCompare(b.category);
			return category === 0 ? a.id.localeCompare(b.id) : category;
		});
	const publicSpecs = specs.filter(isUserVisibleAgent);
	const shadowSpecs = specs.filter((spec) => spec.audience === "shadow");

	const lines: string[] = [
		"Clio manages a small fleet of coding agents. Recipes are Markdown files; normalized specs carry audience, category, capability, tools, skills, and latency hints.",
		"Use the `dispatch` tool to invoke one by `agent_id` when delegation helps.",
		`Default dispatch agent: ${DEFAULT_DISPATCH_AGENT_ID}.`,
		"User-facing agents are base/custom. Shadow agents are internal helpers for context, research, and provenance; do not recommend them as normal `/run` choices.",
		"Prefer fast read-only agents for orientation, verification agents for gates, and workspace-edit agents only for bounded coding tasks.",
		"After a dispatch succeeds, use that receipt/output as evidence and synthesize the answer instead of repeating the same dispatch.",
	];

	if (publicSpecs.length > 0) {
		lines.push("", "User-facing agents:");
		for (const spec of publicSpecs) {
			const description = spec.description.trim();
			const suffix = description.length > 0 ? ` - ${description}` : "";
			lines.push(formatSpecLine(spec, suffix));
		}
	}
	if (shadowSpecs.length > 0) {
		lines.push("", "Shadow agents for internal orchestration:");
		for (const spec of shadowSpecs) {
			const description = spec.description.trim();
			const suffix = description.length > 0 ? ` - ${description}` : "";
			lines.push(formatSpecLine(spec, suffix));
		}
	}

	return { stable: lines.join("\n"), volatile: "" };
}

function formatSpecLine(spec: AgentSpec, suffix: string): string {
	const tags = spec.tags.length > 0 ? `, tags=${spec.tags.join("/")}` : "";
	const skills = spec.skills.length > 0 ? `, skills=${spec.skills.join("/")}` : "";
	return `- ${spec.id} (${spec.audience}, ${spec.category}, ${spec.capabilityClass}, ${spec.latencyClass}, ${spec.source}${tags}${skills})${suffix}`;
}

export function renderAgentCatalog(recipes: ReadonlyArray<AgentRecipe>): string {
	const sections = renderAgentCatalogSections(recipes);
	return [sections.stable, sections.volatile].filter((part) => part.trim().length > 0).join("\n\n");
}
