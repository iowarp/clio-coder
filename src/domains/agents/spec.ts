import { createHash } from "node:crypto";
import { type BuiltinToolName, isBuiltinToolName, type ToolName, ToolNames } from "../../core/tool-names.js";
import { type ActionClass, classify } from "../safety/action-classifier.js";
import type { AgentBudget, AgentRecipe, AgentToolRequirement } from "./recipe.js";
import type { ResultContract } from "./result-contract.js";

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

/** Authority classes a bounded coordinator plan may grant to agent automation. */
export const AGENT_AUTOMATION_AUTHORITIES = ["read-only", "verification", "artifact-write", "workspace-edit"] as const;
export type AgentAutomationAuthority = (typeof AGENT_AUTOMATION_AUTHORITIES)[number];

export type AgentLatencyClass = "fast" | "balanced" | "deep";

/**
 * How much durable project context a worker run receives as a dynamic prompt
 * message: "bounded" is the capped name/conventions/invariants projection,
 * "none" is nothing. Defaults derive from the capability class so read-only
 * scouts never pay the CLIO.md read; recipe frontmatter may override.
 */
export type AgentProjectContextTier = "none" | "bounded";

export type AgentAudience = "base" | "shadow" | "custom" | "internal";

/**
 * What a run delivers, which is what decides the shape of its reserve window.
 * The reserve ends discovery, not the run's own product, so the delivery tools
 * a run keeps inside it depend on what it is producing. An "orientation" run
 * delivers a description of a codebase, so `code_nav` is a delivery tool for it
 * the way `write` and `edit` are for a run that delivers files.
 *
 * Closed on purpose: it widens the reserve admission set, so an unrecognized
 * value must be a loud parse error rather than a silent degrade back to the
 * default set. `product: orientaton` in a recipe would otherwise cost the run
 * its navigation tool with no diagnostic anywhere.
 */
export type AgentProduct = "orientation";

const AGENT_PRODUCTS: ReadonlyArray<AgentProduct> = ["orientation"];

const AGENT_CATEGORIES: ReadonlyArray<AgentCategory> = [
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

const AGENT_CAPABILITY_CLASSES: ReadonlyArray<AgentCapabilityClass> = [
	"read-only",
	"artifact-write",
	"workspace-edit",
	"verification",
	"orchestration",
	"internal",
];

const AGENT_LATENCY_CLASSES: ReadonlyArray<AgentLatencyClass> = ["fast", "balanced", "deep"];

const AGENT_AUDIENCES: ReadonlyArray<AgentAudience> = ["base", "shadow", "custom", "internal"];

const AGENT_PROJECT_CONTEXT_TIERS: ReadonlyArray<AgentProjectContextTier> = ["none", "bounded"];

export interface AgentToolRequirements {
	required: ReadonlyArray<ToolName | { anyOf: ReadonlyArray<ToolName> }>;
	optional: ReadonlyArray<ToolName>;
}

export interface AgentSpec {
	version: 1;
	id: string;
	name: string;
	description: string;
	source: AgentRecipe["source"] | "custom";
	filepath: string;
	tools: ReadonlyArray<ToolName>;
	toolRequirements: AgentToolRequirements;
	category: AgentCategory;
	capabilityClass: AgentCapabilityClass;
	latencyClass: AgentLatencyClass;
	projectContextTier: AgentProjectContextTier;
	audience: AgentAudience;
	tags: ReadonlyArray<string>;
	skills: ReadonlyArray<string>;
	resultContract: ResultContract;
	product?: AgentProduct;
	budget: AgentBudget;
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

export function isAgentProjectContextTier(value: unknown): value is AgentProjectContextTier {
	return includes(AGENT_PROJECT_CONTEXT_TIERS, value);
}

export function isAgentProduct(value: unknown): value is AgentProduct {
	return includes(AGENT_PRODUCTS, value);
}

/**
 * Default tier per capability class. Reproduces the historical dispatch
 * allowlist byte-for-byte: workers that act on the workspace get the bounded
 * projection; read-only, orchestration, and internal classes get none.
 */
export function defaultProjectContextTier(capability: AgentCapabilityClass): AgentProjectContextTier {
	return capability === "workspace-edit" || capability === "verification" || capability === "artifact-write"
		? "bounded"
		: "none";
}

function actionClassesForTools(tools: ReadonlyArray<ToolName>): ReadonlySet<ActionClass> {
	const actions = new Set<ActionClass>();
	for (const tool of tools) actions.add(classify({ tool }).actionClass);
	return actions;
}

function normalizeTools(recipe: AgentRecipe): ReadonlyArray<ToolName> {
	const seen = new Set<string>();
	const tools: ToolName[] = [];
	for (const tool of recipe.tools) {
		if (typeof tool !== "string" || tool.trim().length === 0) {
			throw new Error(`agent recipe '${recipe.id}' declares an invalid tool name`);
		}
		if (seen.has(tool)) continue;
		seen.add(tool);
		tools.push(isBuiltinToolName(tool as ToolName) ? (tool as BuiltinToolName) : (tool as ToolName));
	}
	return tools;
}

function asToolName(tool: string): ToolName {
	return isBuiltinToolName(tool as ToolName) ? (tool as BuiltinToolName) : (tool as ToolName);
}

function normalizeToolRequirements(recipe: AgentRecipe, tools: ReadonlyArray<ToolName>): AgentToolRequirements {
	if (!recipe.toolRequirements) {
		throw new Error(`agent recipe '${recipe.id}' must declare tools.required and tools.optional`);
	}
	const declared = new Set(tools);
	const required = recipe.toolRequirements.required.map((requirement: AgentToolRequirement, index) => {
		if (typeof requirement === "string") return asToolName(requirement);
		if (!Array.isArray(requirement.anyOf) || requirement.anyOf.length === 0) {
			throw new Error(`agent recipe '${recipe.id}' tools.required[${index}].anyOf must be non-empty`);
		}
		return { anyOf: requirement.anyOf.map(asToolName) };
	});
	const optional = recipe.toolRequirements.optional.map(asToolName);
	const mentioned = required.flatMap((requirement) =>
		typeof requirement === "string" ? [requirement] : requirement.anyOf,
	);
	for (const tool of [...mentioned, ...optional]) {
		if (!declared.has(tool)) throw new Error(`agent recipe '${recipe.id}' requirement '${tool}' is not declared`);
	}
	if (new Set([...mentioned, ...optional]).size !== mentioned.length + optional.length) {
		throw new Error(`agent recipe '${recipe.id}' contains duplicate tool requirements`);
	}
	if (new Set([...mentioned, ...optional]).size !== tools.length) {
		throw new Error(`agent recipe '${recipe.id}' has declared tools without required/optional semantics`);
	}
	return { required, optional };
}

export interface AgentToolCompatibility {
	compatible: boolean;
	missingRequired: ReadonlyArray<string>;
	lostOptional: ReadonlyArray<ToolName>;
}

export function resolveAgentToolCompatibility(
	spec: Pick<AgentSpec, "toolRequirements">,
	effectiveTools: ReadonlyArray<ToolName>,
	options: { mediatesDispatch: boolean },
): AgentToolCompatibility {
	const available = new Set(effectiveTools);
	const missingRequired: string[] = [];
	for (const requirement of spec.toolRequirements.required) {
		if (typeof requirement === "string") {
			if (!available.has(requirement)) missingRequired.push(requirement);
			continue;
		}
		if (!requirement.anyOf.some((tool) => available.has(tool))) {
			missingRequired.push(`anyOf(${requirement.anyOf.join("|")})`);
		}
	}
	if (available.has(ToolNames.Dispatch) && !options.mediatesDispatch) {
		missingRequired.push("dispatch(runtime mediation unavailable)");
	}
	return {
		compatible: missingRequired.length === 0,
		missingRequired,
		lostOptional: spec.toolRequirements.optional.filter((tool) => !available.has(tool)),
	};
}

export function normalizeAgentSpec(recipe: AgentRecipe): AgentSpec {
	const tools = normalizeTools(recipe);
	const toolRequirements = normalizeToolRequirements(recipe, tools);
	return {
		version: recipe.version,
		id: recipe.id,
		name: recipe.name,
		description: recipe.description,
		source: recipe.source,
		filepath: recipe.filepath,
		tools,
		toolRequirements,
		category: recipe.category,
		capabilityClass: recipe.capabilityClass,
		latencyClass: recipe.latencyClass,
		projectContextTier: recipe.projectContextTier,
		audience: recipe.audience,
		tags: recipe.tags,
		skills: recipe.skills,
		resultContract: recipe.resultContract,
		...(recipe.product !== undefined ? { product: recipe.product } : {}),
		budget: recipe.budget,
		body: recipe.body,
	};
}

/**
 * Stable identity of everything about a recipe that changes what a route means.
 *
 * Route statistics are only comparable when they were produced by the same
 * agent. A Coder run under a reviewer persona, a Coder whose declared tools
 * changed, and a Coder whose body was rewritten are three different things to
 * aggregate, so each gets a different fingerprint. Display-only metadata
 * (name, description, category, filepath, source, tags) is excluded: display
 * metadata edits must not invalidate measured history.
 */
export function agentSpecFingerprint(spec: AgentSpec): string {
	const requirement = (entry: AgentToolRequirement): string =>
		typeof entry === "string" ? entry : `anyOf(${[...entry.anyOf].sort().join("|")})`;
	const payload = JSON.stringify({
		id: spec.id,
		tools: [...spec.tools].sort(),
		required: spec.toolRequirements.required.map(requirement).sort(),
		optional: [...spec.toolRequirements.optional].sort(),
		capabilityClass: spec.capabilityClass,
		latencyClass: spec.latencyClass,
		projectContextTier: spec.projectContextTier,
		audience: spec.audience,
		skills: [...spec.skills].sort(),
		resultContract: spec.resultContract,
		budget: spec.budget,
		body: createHash("sha256").update(spec.body, "utf8").digest("hex"),
	});
	return createHash("sha256").update(payload, "utf8").digest("hex");
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
	const requiredGroups = spec.toolRequirements.required.map((requirement) =>
		typeof requirement === "string" ? [requirement] : requirement.anyOf,
	);
	const requiresTool = (tool: ToolName): boolean =>
		requiredGroups.some((group) => group.length > 0 && group.every((candidate) => candidate === tool));
	const requiresMutation = requiredGroups.some(
		(group) => group.length > 0 && group.every((tool) => tool === ToolNames.Write || tool === ToolNames.Edit),
	);
	if (spec.capabilityClass === "workspace-edit" && (!requiresTool(ToolNames.Read) || !requiresMutation)) {
		errors.push(`workspace-edit agent '${spec.id}' must require read and write|edit`);
	}
	if (spec.capabilityClass === "verification" && !requiresTool(ToolNames.Verify)) {
		errors.push(`verification agent '${spec.id}' must require verify`);
	}
	if (spec.capabilityClass === "artifact-write" && !requiresTool(ToolNames.Artifact)) {
		errors.push(`artifact-write agent '${spec.id}' must require artifact`);
	}
	if (spec.skills.length > 0 && !requiresTool(ToolNames.Context)) {
		errors.push(`agent '${spec.id}' must require context for bound skills`);
	}
	if (
		spec.capabilityClass === "orchestration" &&
		spec.tools.includes(ToolNames.Dispatch) &&
		!requiresTool(ToolNames.Dispatch)
	) {
		errors.push(`orchestration agent '${spec.id}' must require dispatch when it is declared`);
	}
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
			if (action === "write" && tool !== ToolNames.Artifact) {
				errors.push(`artifact-write agent '${spec.id}' can only write terminal artifacts; got '${tool}'`);
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
	if (spec.tools.includes(ToolNames.AskUser)) {
		errors.push(`agent '${spec.id}' exposes ask_user, which is only available to the orchestrator`);
	}
	if (spec.skills.length > 0 && !spec.tools.includes(ToolNames.Context)) {
		errors.push(`agent '${spec.id}' declares skills but does not expose context`);
	}
	return errors;
}

export function assertAgentSpecPolicy(spec: AgentSpec): void {
	const errors = agentSpecPolicyErrors(spec);
	if (errors.length > 0) throw new Error(`agent policy violation:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}
