import { type AgentRecipe, type AgentToolRequirement, parseAgentBudget } from "./recipe.js";
import { parseResultContract } from "./result-contract.js";
import {
	type AgentAudience,
	type AgentCapabilityClass,
	type AgentCategory,
	type AgentLatencyClass,
	type AgentProduct,
	type AgentProjectContextTier,
	isAgentAudience,
	isAgentCapabilityClass,
	isAgentCategory,
	isAgentLatencyClass,
	isAgentProduct,
	isAgentProjectContextTier,
} from "./spec.js";

/**
 * The v1 recipe frontmatter schema, split into the keys every recipe must
 * declare and the keys it may. Exported because `scripts/check-release.mjs`
 * enforces the same schema against the built recipes in the tarball and used to
 * carry its own copy of the list, which drifted the moment `product` was added.
 * A contract test holds the gate against these two arrays.
 */
export const RECIPE_KEYS = [
	"version",
	"name",
	"description",
	"tools",
	"skills",
	"audience",
	"category",
	"capabilityClass",
	"latencyClass",
	"projectContextTier",
	"budget",
	"resultContract",
	"tags",
] as const;

export const OPTIONAL_RECIPE_KEYS = ["product"] as const;
const ALL_RECIPE_KEYS = [...RECIPE_KEYS, ...OPTIONAL_RECIPE_KEYS] as const;

export interface ParseRecipeSchemaInput {
	id: string;
	source: AgentRecipe["source"];
	filepath: string;
	body: string;
	frontmatter: Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0)
		throw new Error(`agent recipe: ${path} must be a non-empty string`);
	return value;
}

function requiredStringArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) throw new Error(`agent recipe: ${path} must be an array of strings`);
	const entries = value.map((entry, index) => requiredString(entry, `${path}[${index}]`));
	if (new Set(entries).size !== entries.length) throw new Error(`agent recipe: ${path} must not contain duplicates`);
	return entries;
}

function enumValue<T extends string>(value: unknown, path: string, predicate: (value: unknown) => value is T): T {
	if (!predicate(value)) throw new Error(`agent recipe: ${path} has an unsupported value`);
	return value;
}

/**
 * Audience is provenance, not a claim a file makes about itself. It decides
 * whether an operator can see an agent and whether a user-origin dispatch may
 * reach it, so a discovered recipe declaring `shadow` or `internal` would hide
 * itself from `clio-coder agents` while staying reachable by internal orchestration,
 * and one declaring `base` would present itself as shipped. Only recipes Clio
 * ships may name any audience; everything discovered under a user or project
 * root is `custom`. The declaration is rejected rather than coerced, because a
 * recipe whose audience was quietly rewritten is a recipe whose author still
 * believes it is hidden.
 */
function parseAudience(value: unknown, source: AgentRecipe["source"], filepath: string): AgentAudience {
	const audience = enumValue<AgentAudience>(value, `${filepath}: audience`, isAgentAudience);
	if (source === "builtin") {
		if (audience === "custom") {
			throw new Error(`agent recipe: ${filepath}: a builtin recipe must not declare audience 'custom'`);
		}
		return audience;
	}
	if (audience !== "custom") {
		throw new Error(
			`agent recipe: ${filepath}: a ${source} recipe must declare audience 'custom', not '${audience}'; ` +
				"audience follows where the recipe was discovered and cannot be claimed in frontmatter",
		);
	}
	return audience;
}

function parseTools(
	value: unknown,
	filepath: string,
): { tools: string[]; toolRequirements: AgentRecipe["toolRequirements"] } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`agent recipe: ${filepath}: tools must be a { required, optional } object`);
	}
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => key !== "required" && key !== "optional")) {
		throw new Error(`agent recipe: ${filepath}: tools has an unknown key`);
	}
	if (!("required" in record) || !("optional" in record)) {
		throw new Error(`agent recipe: ${filepath}: tools.required and tools.optional are required`);
	}
	if (!Array.isArray(record.required) || !Array.isArray(record.optional)) {
		throw new Error(`agent recipe: ${filepath}: tools.required and tools.optional must be arrays`);
	}
	const required: AgentToolRequirement[] = record.required.map((entry, index) => {
		const entryPath = `${filepath}: tools.required[${index}]`;
		if (typeof entry === "string") return requiredString(entry, entryPath);
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`agent recipe: ${entryPath} must be a tool name or { anyOf: [...] }`);
		}
		const group = entry as Record<string, unknown>;
		if (Object.keys(group).length !== 1 || !("anyOf" in group)) {
			throw new Error(`agent recipe: ${entryPath} must contain only anyOf`);
		}
		const anyOf = requiredStringArray(group.anyOf, `${entryPath}.anyOf`);
		if (anyOf.length === 0) throw new Error(`agent recipe: ${entryPath}.anyOf must not be empty`);
		return { anyOf };
	});
	const optional = requiredStringArray(record.optional, `${filepath}: tools.optional`);
	const tools = [
		...required.flatMap((requirement) => (typeof requirement === "string" ? [requirement] : requirement.anyOf)),
		...optional,
	];
	if (new Set(tools).size !== tools.length)
		throw new Error(`agent recipe: ${filepath}: tools contains duplicate requirements`);
	return { tools, toolRequirements: { required, optional } };
}

/**
 * The single supported agent-recipe schema. Every retained field is parsed
 * strictly here; no frontmatter value is coerced, inferred, or silently lost.
 */
export function parseAgentRecipeSchema(input: ParseRecipeSchemaInput): AgentRecipe {
	const { frontmatter, filepath } = input;
	for (const key of Object.keys(frontmatter)) {
		if (!(ALL_RECIPE_KEYS as ReadonlyArray<string>).includes(key)) {
			throw new Error(`agent recipe: ${filepath}: unknown key '${key}'`);
		}
	}
	for (const key of RECIPE_KEYS) {
		if (!(key in frontmatter)) throw new Error(`agent recipe: ${filepath}: ${key} is required`);
	}
	if (frontmatter.version !== 1) throw new Error(`agent recipe: ${filepath}: version must be the supported integer 1`);
	if (input.body.trim().length === 0) throw new Error(`agent recipe: ${filepath}: persona body must not be empty`);

	const parsedTools = parseTools(frontmatter.tools, filepath);
	const budget = parseAgentBudget(frontmatter.budget, filepath);
	if (budget === undefined) throw new Error(`agent recipe: ${filepath}: budget is required`);
	return {
		version: 1,
		id: input.id,
		name: requiredString(frontmatter.name, `${filepath}: name`),
		description: requiredString(frontmatter.description, `${filepath}: description`),
		tools: parsedTools.tools,
		toolRequirements: parsedTools.toolRequirements,
		skills: requiredStringArray(frontmatter.skills, `${filepath}: skills`),
		boundSkillPaths: [],
		audience: parseAudience(frontmatter.audience, input.source, filepath),
		category: enumValue<AgentCategory>(frontmatter.category, `${filepath}: category`, isAgentCategory),
		capabilityClass: enumValue<AgentCapabilityClass>(
			frontmatter.capabilityClass,
			`${filepath}: capabilityClass`,
			isAgentCapabilityClass,
		),
		latencyClass: enumValue<AgentLatencyClass>(
			frontmatter.latencyClass,
			`${filepath}: latencyClass`,
			isAgentLatencyClass,
		),
		projectContextTier: enumValue<AgentProjectContextTier>(
			frontmatter.projectContextTier,
			`${filepath}: projectContextTier`,
			isAgentProjectContextTier,
		),
		budget,
		resultContract: parseResultContract(frontmatter.resultContract, filepath),
		// Optional, but not lenient. A misspelled product silently costs the run
		// the delivery tools its reserve window was supposed to keep, and the
		// only symptom is a blocked tool call deep in a dispatch log.
		...(frontmatter.product === undefined
			? {}
			: { product: enumValue<AgentProduct>(frontmatter.product, `${filepath}: product`, isAgentProduct) }),
		tags: requiredStringArray(frontmatter.tags, `${filepath}: tags`),
		source: input.source,
		filepath,
		body: input.body,
	};
}

export function recipeSchemaFieldNames(): ReadonlyArray<string> {
	return ALL_RECIPE_KEYS;
}
