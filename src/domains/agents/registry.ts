import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { type AgentRecipe, type RecipeSource, recipeIdFromPath } from "./recipe.js";

function parseMode(value: unknown): AgentRecipe["mode"] {
	if (value === "advise" || value === "default" || value === "super") return value;
	return undefined;
}

function parseRuntime(value: unknown): AgentRecipe["runtime"] {
	if (value === "native" || value === "sdk" || value === "cli") return value;
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
		recipes.push(recipe);
	}

	recipes.sort((a, b) => a.id.localeCompare(b.id));
	return recipes;
}

export function mergeRecipes(...sources: ReadonlyArray<ReadonlyArray<AgentRecipe>>): ReadonlyArray<AgentRecipe> {
	const byId = new Map<string, AgentRecipe>();
	for (const group of sources) {
		for (const recipe of group) {
			if (byId.has(recipe.id)) {
				process.stderr.write(`[clio:agents] override id=${recipe.id} by=${recipe.source}\n`);
			}
			byId.set(recipe.id, recipe);
		}
	}
	return Array.from(byId.values());
}
