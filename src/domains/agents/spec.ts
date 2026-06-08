import { type BuiltinToolName, isBuiltinToolName, type ToolName, ToolNames } from "../../core/tool-names.js";
import type { ModeName } from "../modes/matrix.js";
import { type ActionClass, classify } from "../safety/action-classifier.js";
import type { AgentRecipe } from "./recipe.js";

export type AgentCategory =
	| "explore"
	| "plan"
	| "research"
	| "implement"
	| "quality"
	| "science"
	| "evolution"
	| "operations"
	| "internal";

export type AgentCapabilityClass =
	| "read-only"
	| "artifact-write"
	| "workspace-edit"
	| "verification"
	| "orchestration"
	| "internal";

export type AgentLatencyClass = "fast" | "balanced" | "deep";

export type AgentAudience = "base" | "shadow" | "custom" | "internal";

export const AGENT_CATEGORIES: ReadonlyArray<AgentCategory> = [
	"explore",
	"plan",
	"research",
	"implement",
	"quality",
	"science",
	"evolution",
	"operations",
	"internal",
];

export const AGENT_CAPABILITY_CLASSES: ReadonlyArray<AgentCapabilityClass> = [
	"read-only",
	"artifact-write",
	"workspace-edit",
	"verification",
	"orchestration",
	"internal",
];

export const AGENT_LATENCY_CLASSES: ReadonlyArray<AgentLatencyClass> = ["fast", "balanced", "deep"];

export const AGENT_AUDIENCES: ReadonlyArray<AgentAudience> = ["base", "shadow", "custom", "internal"];

const BUILTIN_SHADOW_AGENT_IDS = new Set(["scout", "researcher", "provenance"]);
const BUILTIN_INTERNAL_AGENT_IDS = new Set<string>();

export interface AgentSpec {
	id: string;
	name: string;
	description: string;
	source: AgentRecipe["source"];
	filepath: string;
	mode: ModeName;
	tools: ReadonlyArray<ToolName>;
	category: AgentCategory;
	capabilityClass: AgentCapabilityClass;
	latencyClass: AgentLatencyClass;
	audience: AgentAudience;
	tags: ReadonlyArray<string>;
	skills: ReadonlyArray<string>;
	output: string | null;
	body: string;
}

function includes<T extends string>(values: ReadonlyArray<T>, value: unknown): value is T {
	return typeof value === "string" && (values as ReadonlyArray<string>).includes(value);
}

export function isAgentCategory(value: unknown): value is AgentCategory {
	return includes(AGENT_CATEGORIES, value);
}

export function isAgentCapabilityClass(value: unknown): value is AgentCapabilityClass {
	return includes(AGENT_CAPABILITY_CLASSES, value);
}

export function isAgentLatencyClass(value: unknown): value is AgentLatencyClass {
	return includes(AGENT_LATENCY_CLASSES, value);
}

export function isAgentAudience(value: unknown): value is AgentAudience {
	return includes(AGENT_AUDIENCES, value);
}

function actionClassesForTools(tools: ReadonlyArray<ToolName>): ReadonlySet<ActionClass> {
	const actions = new Set<ActionClass>();
	for (const tool of tools) actions.add(classify({ tool }).actionClass);
	return actions;
}

function hasTool(tools: ReadonlyArray<ToolName>, tool: BuiltinToolName): boolean {
	return tools.includes(tool);
}

function inferCategory(recipe: AgentRecipe, tools: ReadonlyArray<ToolName>): AgentCategory {
	if (recipe.id === "worker") return "internal";
	if (recipe.id.includes("scientific") || recipe.id.includes("benchmark")) return "science";
	if (recipe.id.includes("review") || recipe.id.includes("test") || recipe.id.includes("valid")) return "quality";
	if (recipe.id.includes("implement") || recipe.id.includes("simplif")) return "implement";
	if (recipe.id.includes("research")) return "research";
	if (recipe.id.includes("plan") || recipe.id.includes("architect") || hasTool(tools, ToolNames.WritePlan))
		return "plan";
	if (recipe.id.includes("debug") || recipe.id.includes("attrib") || recipe.id.includes("evol")) return "evolution";
	if (recipe.id.includes("memory") || recipe.id.includes("middleware")) return "operations";
	return "explore";
}

function inferCapabilityClass(recipe: AgentRecipe, tools: ReadonlyArray<ToolName>): AgentCapabilityClass {
	if (recipe.id === "worker") return "internal";
	const actions = actionClassesForTools(tools);
	const writesOnlyPlanOrReview = tools.every((tool) => {
		const action = classify({ tool }).actionClass;
		return action !== "write" || tool === ToolNames.WritePlan || tool === ToolNames.WriteReview;
	});
	if (actions.has("dispatch")) return "orchestration";
	if (actions.has("execute") && !actions.has("write")) return "verification";
	if (actions.has("write") && writesOnlyPlanOrReview) return "artifact-write";
	if (actions.has("write") || actions.has("execute")) return "workspace-edit";
	return "read-only";
}

function inferLatencyClass(category: AgentCategory, capability: AgentCapabilityClass): AgentLatencyClass {
	if (category === "explore" || capability === "verification") return "fast";
	if (category === "plan" || category === "science" || category === "evolution") return "deep";
	return "balanced";
}

function inferAudience(recipe: AgentRecipe): AgentAudience {
	if (recipe.source !== "builtin") return "custom";
	if (recipe.audience) return recipe.audience;
	if (BUILTIN_INTERNAL_AGENT_IDS.has(recipe.id)) return "internal";
	if (BUILTIN_SHADOW_AGENT_IDS.has(recipe.id)) return "shadow";
	return "base";
}

function normalizeTools(recipe: AgentRecipe): ReadonlyArray<ToolName> {
	const seen = new Set<string>();
	const tools: ToolName[] = [];
	for (const tool of recipe.tools ?? []) {
		if (seen.has(tool)) continue;
		seen.add(tool);
		tools.push(isBuiltinToolName(tool as ToolName) ? (tool as BuiltinToolName) : (tool as ToolName));
	}
	return tools;
}

export function normalizeAgentSpec(recipe: AgentRecipe): AgentSpec {
	const tools = normalizeTools(recipe);
	const mode = recipe.mode ?? "default";
	const category = recipe.category ?? inferCategory(recipe, tools);
	const capabilityClass = recipe.capabilityClass ?? inferCapabilityClass(recipe, tools);
	const latencyClass = recipe.latencyClass ?? inferLatencyClass(category, capabilityClass);
	return {
		id: recipe.id,
		name: recipe.name,
		description: recipe.description,
		source: recipe.source,
		filepath: recipe.filepath,
		mode,
		tools,
		category,
		capabilityClass,
		latencyClass,
		audience: inferAudience(recipe),
		tags: recipe.tags ?? [],
		skills: recipe.skills ?? [],
		output: recipe.output ?? null,
		body: recipe.body,
	};
}

export function isUserVisibleAgent(spec: AgentSpec): boolean {
	return spec.audience === "base" || spec.audience === "custom";
}

export function isShadowAgent(spec: AgentSpec): boolean {
	return spec.audience === "shadow" || spec.audience === "internal";
}

export function agentSpecPolicyErrors(spec: AgentSpec): string[] {
	const errors: string[] = [];
	const actions = actionClassesForTools(spec.tools);
	const toolList = spec.tools.join(", ");
	if (spec.capabilityClass === "read-only") {
		for (const action of actions) {
			if (action !== "read") errors.push(`read-only agent '${spec.id}' requests ${action} tools (${toolList})`);
		}
	}
	if (spec.capabilityClass === "artifact-write") {
		for (const tool of spec.tools) {
			const action = classify({ tool }).actionClass;
			if (action === "execute" || action === "dispatch" || action === "system_modify" || action === "git_destructive") {
				errors.push(`artifact-write agent '${spec.id}' requests ${action} tool '${tool}'`);
			}
			if (action === "write" && tool !== ToolNames.WritePlan && tool !== ToolNames.WriteReview) {
				errors.push(`artifact-write agent '${spec.id}' can only write PLAN.md or REVIEW.md; got '${tool}'`);
			}
		}
	}
	if (spec.capabilityClass === "verification") {
		for (const tool of spec.tools) {
			const action = classify({ tool }).actionClass;
			if (action === "write" || action === "dispatch" || action === "system_modify" || action === "git_destructive") {
				errors.push(`verification agent '${spec.id}' must not request ${action} tool '${tool}'`);
			}
			if (tool === ToolNames.Bash)
				errors.push(`verification agent '${spec.id}' must use typed validation tools, not bash`);
		}
	}
	if (spec.capabilityClass !== "orchestration" && spec.tools.includes(ToolNames.Dispatch)) {
		errors.push(`agent '${spec.id}' exposes dispatch without orchestration capability`);
	}
	if (spec.skills.length > 0 && !spec.tools.includes(ToolNames.ReadSkill)) {
		errors.push(`agent '${spec.id}' declares skills but does not expose read_skill`);
	}
	return errors;
}

export function assertAgentSpecPolicy(spec: AgentSpec): void {
	const errors = agentSpecPolicyErrors(spec);
	if (errors.length > 0) throw new Error(`agent policy violation:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}
