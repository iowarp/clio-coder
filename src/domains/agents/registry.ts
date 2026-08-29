import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import { clioConfigDir } from "../../core/xdg.js";
import { enabledExtensionResourceRoots } from "../extensions/index.js";
import { loadSkills } from "../resources/skills/loader.js";
import { parseFrontmatter } from "./frontmatter.js";
import { type AgentRecipe, type RecipeSource, recipeIdFromPath } from "./recipe.js";
import { parseAgentRecipeSchema } from "./recipe-schema.js";
import { assertAgentSpecPolicy, isShadowAgent, normalizeAgentSpec } from "./spec.js";

const RESERVED_CUSTOM_AGENT_IDS = new Set(["worker", "delegate", "auto"]);

export interface AgentRecipeDiagnostic {
	source: RecipeSource["source"];
	filepath: string;
	message: string;
}

function resolveBoundSkills(recipe: AgentRecipe, source: RecipeSource): AgentRecipe {
	if (recipe.skills.length === 0) return { ...recipe, boundSkillPaths: [] };
	// Builtins may bind a package-owned skill. Custom recipes deliberately use
	// only the operator's discovered skill roots; a recipe cannot smuggle an
	// arbitrary filesystem path into worker context through a skill name.
	const packageSkills = path.resolve(source.dir, "..", "..", "..", "..", "skills");
	if (source.source === "extension" && source.skillRoot === undefined) {
		throw new Error(`agent recipe: ${recipe.filepath}: extension declares bound skills but no skills resource root`);
	}
	const skills =
		source.source === "extension"
			? loadSkills({
					cwd: source.cwd ?? process.cwd(),
					disableDiscovery: true,
					explicitSkillPaths: source.skillRoot === undefined ? [] : [source.skillRoot],
				})
			: loadSkills({
					cwd: source.cwd ?? process.cwd(),
					...(source.source === "builtin" && existsSync(packageSkills) ? { explicitSkillPaths: [packageSkills] } : {}),
				});
	if (source.source === "extension" && source.skillRoot !== undefined) {
		const canonicalRoot = realpathSync(source.skillRoot);
		for (const skill of skills.items) {
			const relative = path.relative(canonicalRoot, realpathSync(skill.filePath));
			if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
				throw new Error(`agent recipe: ${recipe.filepath}: bound skill escapes its extension: ${skill.filePath}`);
			}
		}
	}
	const byName = new Map(skills.items.map((skill) => [skill.name, skill.filePath]));
	const missing = recipe.skills.filter((skill) => !byName.has(skill));
	if (missing.length > 0) {
		throw new Error(`agent recipe: ${recipe.filepath}: bound skill(s) unavailable: ${missing.join(", ")}`);
	}
	const boundSkillPaths = recipe.skills.map((skill) => {
		const filePath = byName.get(skill);
		if (filePath === undefined) throw new Error(`agent recipe: ${recipe.filepath}: bound skill unavailable: ${skill}`);
		return filePath;
	});
	return { ...recipe, boundSkillPaths };
}

/**
 * Strictly parse one recipe directory. Shipped recipe defects abort discovery;
 * user and project defects are quarantined with a structured diagnostic.
 */
export function loadRecipesFromDir(
	source: RecipeSource,
	diagnostics: AgentRecipeDiagnostic[] = [],
): ReadonlyArray<AgentRecipe> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(source.dir, { withFileTypes: true });
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
		throw err;
	}

	const recipes: AgentRecipe[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const filepath = path.join(source.dir, entry.name);
		try {
			const id = recipeIdFromPath(filepath, source.dir);
			const raw = readFileSync(filepath, "utf8");
			const { frontmatter, body } = parseFrontmatter(raw, filepath);
			const parsedRecipe = parseAgentRecipeSchema({ id, source: source.source, filepath, body, frontmatter });
			const recipe = resolveBoundSkills(parsedRecipe, source);
			// Policy validation runs before a recipe enters any catalog, prompt, or
			// dispatch lookup. The schema is intentionally not a permissive pre-pass.
			assertAgentSpecPolicy(normalizeAgentSpec(recipe));
			recipes.push(recipe);
		} catch (error) {
			if (source.source === "builtin") throw error;
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({ source: source.source, filepath, message });
			process.stderr.write(`[clio:agents] quarantine path=${filepath} source=${source.source} reason=${message}\n`);
		}
	}

	recipes.sort((left, right) => left.id.localeCompare(right.id));
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
			if (recipe.source === "extension" && builtin) {
				process.stderr.write(`[clio:agents] ignore override id=${recipe.id} by=extension reason=reserved-builtin\n`);
				continue;
			}
			if (recipe.source === "user" && builtin && isShadowAgent(normalizeAgentSpec(builtin))) {
				process.stderr.write(`[clio:agents] ignore override id=${recipe.id} by=user reason=reserved-shadow\n`);
				continue;
			}
			if (recipe.source === "project" && builtin) {
				process.stderr.write(`[clio:agents] ignore override id=${recipe.id} by=project reason=reserved-builtin\n`);
				continue;
			}
			if (byId.has(recipe.id)) process.stderr.write(`[clio:agents] override id=${recipe.id} by=${recipe.source}\n`);
			byId.set(recipe.id, recipe);
		}
	}
	return Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Discover the one native-agent catalog used by listing, fleet admission, and
 * dispatch. Extension recipes occupy the same precedence slot as extension
 * fleets: after builtins and before operator/user and project recipes. Their
 * skill bindings remain constrained to the declaring extension's skill root.
 */
export function discoverAgentRecipes(
	cwd = process.cwd(),
	diagnostics: AgentRecipeDiagnostic[] = [],
): ReadonlyArray<AgentRecipe> {
	const builtin = loadRecipesFromDir(
		{
			dir: path.join(resolvePackageRoot(), "src", "domains", "agents", "builtins"),
			source: "builtin",
			cwd,
		},
		diagnostics,
	);
	const skillRoots = new Map(enabledExtensionResourceRoots("skills", cwd).map((root) => [root.source, root.path]));
	const extensionRecipes = enabledExtensionResourceRoots("agents", cwd)
		.sort((left, right) => left.source.localeCompare(right.source))
		.map((root) => {
			const skillRoot = skillRoots.get(root.source);
			return loadRecipesFromDir(
				{
					dir: root.path,
					source: "extension",
					cwd,
					origin: root.source,
					...(skillRoot === undefined ? {} : { skillRoot }),
				},
				diagnostics,
			);
		});
	const user = loadRecipesFromDir({ dir: path.join(clioConfigDir(), "agents"), source: "user", cwd }, diagnostics);
	const project = loadRecipesFromDir(
		{ dir: path.join(cwd, ".clio-coder", "agents"), source: "project", cwd },
		diagnostics,
	);
	return mergeRecipes(builtin, ...extensionRecipes, user, project);
}
