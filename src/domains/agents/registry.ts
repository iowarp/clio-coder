import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { type AgentRecipe, type RecipeSource, recipeIdFromPath } from "./recipe.js";
import {
	isAgentAudience,
	isAgentCapabilityClass,
	isAgentCategory,
	isAgentLatencyClass,
	isShadowAgent,
	normalizeAgentSpec,
} from "./spec.js";

const RESERVED_CUSTOM_AGENT_IDS = new Set(["worker", "delegate"]);

function parseMode(value: unknown): AgentRecipe["mode"] {
	if (value === "advise" || value === "default" || value === "super") return value;
	return undefined;
}

function parseRuntime(value: unknown): AgentRecipe["runtime"] {
	if (value === "native" || value === "cli") return value;
	return undefined;
}

function parseStringArray(value: unknown): ReadonlyArray<string> | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.map((v) => String(v));
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
		};
		const mode = parseMode(frontmatter.mode);
		if (mode) recipe.mode = mode;
		const runtime = parseRuntime(frontmatter.runtime);
		if (runtime) recipe.runtime = runtime;
		const tools = parseStringArray(frontmatter.tools);
		if (tools) recipe.tools = tools;
		const skills = parseStringArray(frontmatter.skills);
		if (skills) recipe.skills = skills;
		if (typeof frontmatter.model === "string") recipe.model = frontmatter.model;
		if (typeof frontmatter.endpoint === "string") recipe.endpoint = frontmatter.endpoint;
		const thinking = parseThinkingLevel(frontmatter.thinkingLevel);
		if (thinking) recipe.thinkingLevel = thinking;
		if (isAgentCategory(frontmatter.category)) recipe.category = frontmatter.category;
		if (isAgentCapabilityClass(frontmatter.capabilityClass)) recipe.capabilityClass = frontmatter.capabilityClass;
		if (isAgentLatencyClass(frontmatter.latencyClass)) recipe.latencyClass = frontmatter.latencyClass;
		if (isAgentAudience(frontmatter.audience)) recipe.audience = frontmatter.audience;
		const tags = parseStringArray(frontmatter.tags);
		if (tags) recipe.tags = tags;
		if (typeof frontmatter.output === "string") recipe.output = frontmatter.output;
		recipes.push(recipe);
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
