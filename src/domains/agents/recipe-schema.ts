import { parseWorkerPermissionDeclaration } from "../safety/worker-permit.js";
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

export const OPTIONAL_RECIPE_KEYS = ["product", "permissions"] as const;
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
 * Throws the first problem, which is what the registry quarantines on; the
 * full list is `parseAgentRecipeSchemaIssues` below.
 */
export function parseAgentRecipeSchema(input: ParseRecipeSchemaInput): AgentRecipe {
	const parsed = parseAgentRecipeSchemaIssues(input);
	const first = parsed.issues[0];
	if (first !== undefined || parsed.recipe === null)
		throw new Error(first?.message ?? `agent recipe: ${input.filepath}: invalid`);
	return parsed.recipe;
}
/** One frontmatter problem. `message` is the exact text the throwing parser raises for it. */
export interface RecipeSchemaIssue {
	field: string;
	message: string;
}

export interface ParsedRecipeSchema {
	/** The recipe when every field parsed; null when `issues` is non-empty. */
	recipe: AgentRecipe | null;
	issues: RecipeSchemaIssue[];
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Non-throwing twin of `requiredStringArray`: one issue per bad entry, then the duplicate check. */
function stringArrayIssues(value: unknown, path: string, field: string): RecipeSchemaIssue[] {
	if (!Array.isArray(value)) return [{ field, message: `agent recipe: ${path} must be an array of strings` }];
	const issues: RecipeSchemaIssue[] = [];
	for (const [index, entry] of value.entries()) {
		if (typeof entry !== "string" || entry.trim().length === 0)
			issues.push({ field: `${field}[${index}]`, message: `agent recipe: ${path}[${index}] must be a non-empty string` });
	}
	if (issues.length === 0 && new Set(value).size !== value.length)
		issues.push({ field, message: `agent recipe: ${path} must not contain duplicates` });
	return issues;
}

/**
 * Non-throwing twin of `parseTools`. The checks run in the same order, so the
 * first issue is the message `parseTools` would have thrown; it keeps going
 * where the shape still allows it, so an author sees every bad entry at once.
 */
function toolsIssues(value: unknown, filepath: string): RecipeSchemaIssue[] {
	const field = "tools";
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return [{ field, message: `agent recipe: ${filepath}: tools must be a { required, optional } object` }];
	}
	const record = value as Record<string, unknown>;
	const issues: RecipeSchemaIssue[] = [];
	if (Object.keys(record).some((key) => key !== "required" && key !== "optional")) {
		issues.push({ field, message: `agent recipe: ${filepath}: tools has an unknown key` });
	}
	if (!("required" in record) || !("optional" in record)) {
		issues.push({ field, message: `agent recipe: ${filepath}: tools.required and tools.optional are required` });
		return issues;
	}
	if (!Array.isArray(record.required) || !Array.isArray(record.optional)) {
		issues.push({ field, message: `agent recipe: ${filepath}: tools.required and tools.optional must be arrays` });
		return issues;
	}
	const names: string[] = [];
	let entriesValid = true;
	for (const [index, entry] of record.required.entries()) {
		const entryPath = `${filepath}: tools.required[${index}]`;
		const entryField = `tools.required[${index}]`;
		if (typeof entry === "string") {
			if (entry.trim().length === 0) {
				issues.push({ field: entryField, message: `agent recipe: ${entryPath} must be a non-empty string` });
				entriesValid = false;
			} else names.push(entry);
			continue;
		}
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			issues.push({ field: entryField, message: `agent recipe: ${entryPath} must be a tool name or { anyOf: [...] }` });
			entriesValid = false;
			continue;
		}
		const group = entry as Record<string, unknown>;
		if (Object.keys(group).length !== 1 || !("anyOf" in group)) {
			issues.push({ field: entryField, message: `agent recipe: ${entryPath} must contain only anyOf` });
			entriesValid = false;
			continue;
		}
		const anyOfIssues = stringArrayIssues(group.anyOf, `${entryPath}.anyOf`, `${entryField}.anyOf`);
		if (anyOfIssues.length > 0) {
			issues.push(...anyOfIssues);
			entriesValid = false;
			continue;
		}
		const anyOf = group.anyOf as string[];
		if (anyOf.length === 0) {
			issues.push({ field: `${entryField}.anyOf`, message: `agent recipe: ${entryPath}.anyOf must not be empty` });
			entriesValid = false;
			continue;
		}
		names.push(...anyOf);
	}
	const optionalIssues = stringArrayIssues(record.optional, `${filepath}: tools.optional`, "tools.optional");
	if (optionalIssues.length > 0) {
		issues.push(...optionalIssues);
		entriesValid = false;
	} else names.push(...(record.optional as string[]));
	if (entriesValid && new Set(names).size !== names.length) {
		issues.push({ field, message: `agent recipe: ${filepath}: tools contains duplicate requirements` });
	}
	return issues;
}

/**
 * Every frontmatter problem in one pass, in the order `parseAgentRecipeSchema`
 * raises them, so the first issue is byte-identical to the message that
 * parser throws and the registry's quarantine text does not change. Each
 * field is checked independently once the keys are known, so an author who
 * misspelled three fields reads three issues rather than one per round trip.
 */
export function parseAgentRecipeSchemaIssues(input: ParseRecipeSchemaInput): ParsedRecipeSchema {
	const { frontmatter, filepath } = input;
	const issues: RecipeSchemaIssue[] = [];
	const attempt = <T>(field: string, parse: () => T): T | undefined => {
		try {
			return parse();
		} catch (error) {
			issues.push({ field, message: errorText(error) });
			return undefined;
		}
	};
	for (const key of Object.keys(frontmatter)) {
		if (!(ALL_RECIPE_KEYS as ReadonlyArray<string>).includes(key)) {
			issues.push({ field: key, message: `agent recipe: ${filepath}: unknown key '${key}'` });
		}
	}
	for (const key of RECIPE_KEYS) {
		if (!(key in frontmatter)) issues.push({ field: key, message: `agent recipe: ${filepath}: ${key} is required` });
	}
	if ("version" in frontmatter && frontmatter.version !== 1) {
		issues.push({ field: "version", message: `agent recipe: ${filepath}: version must be the supported integer 1` });
	}
	if (input.body.trim().length === 0) {
		issues.push({ field: "body", message: `agent recipe: ${filepath}: persona body must not be empty` });
	}
	const toolProblems = "tools" in frontmatter ? toolsIssues(frontmatter.tools, filepath) : [];
	issues.push(...toolProblems);
	const parsedTools =
		toolProblems.length === 0 && "tools" in frontmatter ? parseTools(frontmatter.tools, filepath) : undefined;
	const budget =
		"budget" in frontmatter ? attempt("budget", () => parseAgentBudget(frontmatter.budget, filepath)) : undefined;
	const capabilityClass =
		"capabilityClass" in frontmatter
			? attempt("capabilityClass", () =>
					enumValue<AgentCapabilityClass>(
						frontmatter.capabilityClass,
						`${filepath}: capabilityClass`,
						isAgentCapabilityClass,
					),
				)
			: undefined;
	const permissions =
		frontmatter.permissions === undefined
			? undefined
			: attempt("permissions", () =>
					parseWorkerPermissionDeclaration(frontmatter.permissions, `agent recipe: ${filepath}: permissions`),
				);
	if (permissions?.git === "worktree" && capabilityClass !== undefined && capabilityClass !== "workspace-edit") {
		issues.push({
			field: "permissions.git",
			message: `agent recipe: ${filepath}: permissions.git worktree requires capabilityClass workspace-edit, not ${capabilityClass}`,
		});
	}
	const name =
		"name" in frontmatter ? attempt("name", () => requiredString(frontmatter.name, `${filepath}: name`)) : undefined;
	const description =
		"description" in frontmatter
			? attempt("description", () => requiredString(frontmatter.description, `${filepath}: description`))
			: undefined;
	const skillProblems =
		"skills" in frontmatter ? stringArrayIssues(frontmatter.skills, `${filepath}: skills`, "skills") : [];
	issues.push(...skillProblems);
	const audience =
		"audience" in frontmatter
			? attempt("audience", () => parseAudience(frontmatter.audience, input.source, filepath))
			: undefined;
	const category =
		"category" in frontmatter
			? attempt("category", () => enumValue<AgentCategory>(frontmatter.category, `${filepath}: category`, isAgentCategory))
			: undefined;
	const latencyClass =
		"latencyClass" in frontmatter
			? attempt("latencyClass", () =>
					enumValue<AgentLatencyClass>(frontmatter.latencyClass, `${filepath}: latencyClass`, isAgentLatencyClass),
				)
			: undefined;
	const projectContextTier =
		"projectContextTier" in frontmatter
			? attempt("projectContextTier", () =>
					enumValue<AgentProjectContextTier>(
						frontmatter.projectContextTier,
						`${filepath}: projectContextTier`,
						isAgentProjectContextTier,
					),
				)
			: undefined;
	const resultContract =
		"resultContract" in frontmatter
			? attempt("resultContract", () => parseResultContract(frontmatter.resultContract, filepath))
			: undefined;
	const product =
		frontmatter.product === undefined
			? undefined
			: attempt("product", () => enumValue<AgentProduct>(frontmatter.product, `${filepath}: product`, isAgentProduct));
	const tagProblems = "tags" in frontmatter ? stringArrayIssues(frontmatter.tags, `${filepath}: tags`, "tags") : [];
	issues.push(...tagProblems);
	if (
		issues.length > 0 ||
		parsedTools === undefined ||
		budget === undefined ||
		capabilityClass === undefined ||
		name === undefined ||
		description === undefined ||
		audience === undefined ||
		category === undefined ||
		latencyClass === undefined ||
		projectContextTier === undefined ||
		resultContract === undefined
	) {
		return { recipe: null, issues };
	}
	return {
		recipe: {
			version: 1,
			id: input.id,
			name,
			description,
			tools: parsedTools.tools,
			toolRequirements: parsedTools.toolRequirements,
			skills: frontmatter.skills as string[],
			boundSkillPaths: [],
			audience,
			category,
			capabilityClass,
			latencyClass,
			projectContextTier,
			budget,
			resultContract,
			...(product === undefined ? {} : { product }),
			...(permissions === undefined ? {} : { permissions }),
			tags: frontmatter.tags as string[],
			source: input.source,
			filepath,
			body: input.body,
		},
		issues,
	};
}
