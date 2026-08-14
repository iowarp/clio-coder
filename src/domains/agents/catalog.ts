import type { AgentRecipe } from "./recipe.js";
import { type AgentSpec, isUserVisibleAgent, normalizeAgentSpec } from "./spec.js";

const DEFAULT_DISPATCH_AGENT_ID = "coder";

export interface AgentCatalogSections {
	stable: string;
	volatile: string;
}

function renderAgentCatalogSections(recipes: ReadonlyArray<AgentRecipe>): AgentCatalogSections {
	return renderAgentCatalogSectionsFromSpecs(recipes.map(normalizeAgentSpec));
}

/** Keeps one roster line short enough that the whole fleet block stays near its token budget. */
const FLEET_PROMPT_PURPOSE_MAX_CHARS = 64;

function fleetPromptPurpose(description: string): string {
	const trimmed = description.trim().replace(/\s+/gu, " ");
	if (trimmed.length === 0) return "";
	// One sentence is the useful unit: recipe descriptions put the agent's job
	// first and its qualifications after the first period.
	const stop = trimmed.indexOf(". ");
	const sentence = stop > 0 ? trimmed.slice(0, stop) : trimmed.replace(/\.$/u, "");
	if (sentence.length <= FLEET_PROMPT_PURPOSE_MAX_CHARS) return sentence;
	const cut = sentence.lastIndexOf(" ", FLEET_PROMPT_PURPOSE_MAX_CHARS);
	return `${sentence.slice(0, cut > 0 ? cut : FLEET_PROMPT_PURPOSE_MAX_CHARS).trimEnd()}...`;
}

function fleetPromptLine(spec: AgentSpec): string {
	const budget = spec.budget ? `${spec.budget.toolCalls} calls` : "default budget";
	const purpose = fleetPromptPurpose(spec.description);
	return `- ${spec.id} (${spec.capabilityClass}, ${budget})${purpose.length > 0 ? `: ${purpose}` : ""}`;
}

/**
 * Compact roster for the compiled session prompt. The full catalog above is a
 * tool result the model has to ask for; this is the same roster small enough to
 * live in the prompt, so choosing a specialist never costs a round trip. Shadow
 * agents are listed because they are dispatchable, marked so the model does not
 * offer them to the operator as `/run` choices. Byte-stable for a given spec
 * set: the prompt prefix must not churn between turns.
 */
export function renderFleetPromptSection(input: ReadonlyArray<AgentSpec>): string {
	const specs = input.slice().sort((a, b) => {
		const category = a.category.localeCompare(b.category);
		return category === 0 ? a.id.localeCompare(b.id) : category;
	});
	const publicSpecs = specs.filter(isUserVisibleAgent);
	const shadowSpecs = specs.filter((spec) => spec.audience === "shadow");
	if (publicSpecs.length === 0 && shadowSpecs.length === 0) return "";

	const lines: string[] = [
		"# Fleet",
		`Workers you reach with \`dispatch\`, by \`agent\` id (default ${DEFAULT_DISPATCH_AGENT_ID}). Capability class is what a worker may do: a read-only worker cannot edit.`,
	];
	if (publicSpecs.length > 0) {
		lines.push("", "Operator-facing:", ...publicSpecs.map(fleetPromptLine));
	}
	if (shadowSpecs.length > 0) {
		// Dispatchable, but never a `/run` suggestion: they are plumbing.
		lines.push("", "Internal specialists, dispatch-only:", ...shadowSpecs.map(fleetPromptLine));
	}
	return lines.join("\n");
}

/**
 * Spec-based roster used when the caller already holds normalized specs.
 * `AgentsContract.listSpecs()` includes ACP delegation agents synthesized from
 * settings.delegation.agents[], which never exist as recipe files; rendering
 * from specs keeps those dispatchable targets discoverable in the fleet block.
 */
export function renderAgentCatalogSectionsFromSpecs(input: ReadonlyArray<AgentSpec>): AgentCatalogSections {
	const specs = input.slice().sort((a, b) => {
		const category = a.category.localeCompare(b.category);
		return category === 0 ? a.id.localeCompare(b.id) : category;
	});
	const publicSpecs = specs.filter(isUserVisibleAgent);
	const shadowSpecs = specs.filter((spec) => spec.audience === "shadow");

	const lines: string[] = [
		"Clio manages a small fleet of coding agents. Recipes are Markdown files; normalized specs carry audience, category, capability, tools, skills, latency, and worker-budget hints.",
		"Use the `dispatch` tool to invoke one by `agent_id` when delegation helps.",
		`Default dispatch agent: ${DEFAULT_DISPATCH_AGENT_ID}.`,
		"User-facing agents are base/custom. Shadow agents are internal helpers for context, research, and provenance; do not recommend them as normal `/run` choices.",
		"Prefer fast read-only agents for orientation, verification agents for gates, and workspace-edit agents only for bounded coding tasks.",
		"When a task matches a skill named on an agent line (skills=...), prefer the recipe that binds it; its worker is told to load bound skills for the run.",
		'After a dispatch succeeds, synthesize from the sealed receipt; the worker\'s prose is an advisory claim until its verification state is verified. Spot-check delegated claims before repeating them: re-read any cited file:line location, and re-run or inspect the named validation before repeating a "tests pass" claim. Do not repeat the same dispatch.',
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
	const budget = spec.budget
		? `, budget=${spec.budget.toolCalls}/${spec.budget.readReserve}/${spec.budget.synthesis ? "synthesize" : "stop"}`
		: ", budget=operator-default";
	return `- ${spec.name} [${spec.id}] (${spec.audience}, ${spec.category}, ${spec.capabilityClass}, ${spec.latencyClass}, ${spec.source}${tags}${skills}${budget})${suffix}`;
}

export function renderAgentCatalog(recipes: ReadonlyArray<AgentRecipe>): string {
	const sections = renderAgentCatalogSections(recipes);
	return [sections.stable, sections.volatile].filter((part) => part.trim().length > 0).join("\n\n");
}
