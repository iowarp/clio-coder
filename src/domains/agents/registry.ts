import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import {
	type AgentRecipe,
	type AgentToolRequirement,
	parseAgentBudget,
	type RecipeSource,
	recipeIdFromPath,
} from "./recipe.js";
import {
	assertAgentSpecPolicy,
	isAgentAudience,
	isAgentCapabilityClass,
	isAgentCategory,
	isAgentLatencyClass,
	isAgentProjectContextTier,
	isShadowAgent,
	normalizeAgentSpec,
} from "./spec.js";

const RESERVED_CUSTOM_AGENT_IDS = new Set(["worker", "delegate"]);

function parseRuntime(value: unknown): AgentRecipe["runtime"] {
	if (value === "native" || value === "cli") return value;
	return undefined;
}

function parseStringArray(value: unknown): ReadonlyArray<string> | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.map((v) => String(v));
}

function strictToolName(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
	return value;
}

function parseTools(value: unknown, filepath: string): Pick<AgentRecipe, "tools" | "toolRequirements"> | undefined {
	if (value === undefined) return undefined;
	// Every recipe declares which tools it needs and which it merely wants. A
	// bare list cannot express that, so it is rejected rather than guessed at
	// from the capability class.
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${filepath}: tools must be a { required, optional } object`);
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "required" && key !== "optional") throw new Error(`${filepath}: tools.${key} is unknown`);
	}
	if (!Array.isArray(record.required)) throw new Error(`${filepath}: tools.required must be an array`);
	if (!Array.isArray(record.optional)) throw new Error(`${filepath}: tools.optional must be an array`);
	const required: AgentToolRequirement[] = record.required.map((entry, index) => {
		const entryPath = `${filepath}: tools.required[${index}]`;
		if (typeof entry === "string") return strictToolName(entry, entryPath);
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`${entryPath} must be a tool name or { anyOf: [...] }`);
		}
		const group = entry as Record<string, unknown>;
		if (Object.keys(group).length !== 1 || !Array.isArray(group.anyOf) || group.anyOf.length === 0) {
			throw new Error(`${entryPath} must contain only a non-empty anyOf array`);
		}
		return { anyOf: group.anyOf.map((tool, toolIndex) => strictToolName(tool, `${entryPath}.anyOf[${toolIndex}]`)) };
	});
	const optional = record.optional.map((entry, index) => strictToolName(entry, `${filepath}: tools.optional[${index}]`));
	const tools = [
		...required.flatMap((requirement) => (typeof requirement === "string" ? [requirement] : requirement.anyOf)),
		...optional,
	];
	if (new Set(tools).size !== tools.length) throw new Error(`${filepath}: tools contains duplicate requirements`);
	return { tools, toolRequirements: { required, optional } };
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
function parseThinkingLevel(value: unknown): AgentRecipe["thinkingLevel"] {
	if (typeof value !== "string") return undefined;
	return THINKING_LEVELS.has(value) ? (value as AgentRecipe["thinkingLevel"]) : undefined;
}

export function loadRecipesFromDir(source: RecipeSource): ReadonlyArray<AgentRecipe> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(source.dir, { withFileTypes: true });
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ENOENT" || e.code === "ENOTDIR") return [];
		throw err;
	}

	const recipes: AgentRecipe[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".md")) continue;
		const filepath = path.join(source.dir, entry.name);
		const id = recipeIdFromPath(filepath, source.dir);
		try {
			const raw = readFileSync(filepath, "utf8");
			const { frontmatter, body } = parseFrontmatter(raw, filepath);
			const name = typeof frontmatter.name === "string" ? frontmatter.name : id;
			const description = typeof frontmatter.description === "string" ? frontmatter.description : "";

			const recipe: AgentRecipe = {
				id,
				name,
				description,
				source: source.source,
				filepath,
				body,
				// A recipe that declares no tools requires none; parseTools replaces
				// this when the recipe declares a tools block.
				toolRequirements: { required: [], optional: [] },
			};
			const runtime = parseRuntime(frontmatter.runtime);
			if (runtime) recipe.runtime = runtime;
			const parsedTools = parseTools(frontmatter.tools, filepath);
			if (parsedTools?.tools) recipe.tools = parsedTools.tools;
			if (parsedTools?.toolRequirements) recipe.toolRequirements = parsedTools.toolRequirements;
			const skills = parseStringArray(frontmatter.skills);
			if (skills) recipe.skills = skills;
			if (typeof frontmatter.model === "string") recipe.model = frontmatter.model;
			if (typeof frontmatter.target === "string") recipe.target = frontmatter.target;
			const thinking = parseThinkingLevel(frontmatter.thinkingLevel);
			if (thinking) recipe.thinkingLevel = thinking;
			const budget = parseAgentBudget(frontmatter.budget, filepath);
			if (budget) recipe.budget = budget;
			if (isAgentCategory(frontmatter.category)) recipe.category = frontmatter.category;
			if (isAgentCapabilityClass(frontmatter.capabilityClass)) recipe.capabilityClass = frontmatter.capabilityClass;
			if (isAgentLatencyClass(frontmatter.latencyClass)) recipe.latencyClass = frontmatter.latencyClass;
			if (isAgentProjectContextTier(frontmatter.projectContextTier)) {
				recipe.projectContextTier = frontmatter.projectContextTier;
			}
			if (isAgentAudience(frontmatter.audience)) recipe.audience = frontmatter.audience;
			const tags = parseStringArray(frontmatter.tags);
			if (tags) recipe.tags = tags;
			if (typeof frontmatter.output === "string") recipe.output = frontmatter.output;
			// Normalization and policy validation run before the recipe enters any catalog.
			assertAgentSpecPolicy(normalizeAgentSpec(recipe));
			recipes.push(recipe);
		} catch (error) {
			if (source.source === "builtin") throw error;
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[clio:agents] quarantine path=${filepath} source=${source.source} reason=${message}\n`);
		}
	}

	recipes.sort((a, b) => a.id.localeCompare(b.id));
	return recipes;
}

export function mergeRecipes(...sources: ReadonlyArray<ReadonlyArray<AgentRecipe>>): ReadonlyArray<AgentRecipe> {
	const byId = new Map<string, AgentRecipe>();
	const builtinById = new Map<string, AgentRecipe>();
	for (const group of sources) {
		for (const recipe of group) {
			if (recipe.source === "builtin") builtinById.set(recipe.id, recipe);
		}
	}
	for (const group of sources) {
		for (const recipe of group) {
			if (recipe.source !== "builtin" && RESERVED_CUSTOM_AGENT_IDS.has(recipe.id)) {
				process.stderr.write(`[clio:agents] ignore id=${recipe.id} by=${recipe.source} reason=reserved-agent-id\n`);
				continue;
			}
			const builtin = builtinById.get(recipe.id);
			if (recipe.source === "user" && builtin && isShadowAgent(normalizeAgentSpec(builtin))) {
				process.stderr.write(`[clio:agents] ignore override id=${recipe.id} by=user reason=reserved-shadow\n`);
				continue;
			}
			if (recipe.source === "project" && builtin) {
				process.stderr.write(`[clio:agents] ignore override id=${recipe.id} by=project reason=reserved-builtin\n`);
				continue;
			}
			if (byId.has(recipe.id)) {
				process.stderr.write(`[clio:agents] override id=${recipe.id} by=${recipe.source}\n`);
			}
			byId.set(recipe.id, recipe);
		}
	}
	return Array.from(byId.values());
}
