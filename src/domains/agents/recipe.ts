import path from "node:path";

export type RecipeThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentRecipe {
	id: string;
	name: string;
	description: string;
	mode?: "advise" | "default" | "super";
	tools?: ReadonlyArray<string>;
	model?: string;
	endpoint?: string;
	thinkingLevel?: RecipeThinkingLevel;
	runtime?: "native" | "sdk" | "cli";
	skills?: ReadonlyArray<string>;
	source: "builtin" | "user" | "project";
	filepath: string;
	body: string;
}

export interface RecipeSource {
	dir: string;
	source: "builtin" | "user" | "project";
}

export function recipeIdFromPath(absPath: string, rootDir: string): string {
	const resolvedRoot = path.resolve(rootDir);
	const resolvedPath = path.resolve(absPath);
	const relPath = path.relative(resolvedRoot, resolvedPath);

	if (relPath === "" || relPath.startsWith("..") || path.isAbsolute(relPath)) {
		throw new Error(`recipe: path must live under rootDir (${resolvedPath} not under ${resolvedRoot})`);
	}
	if (path.dirname(relPath) !== ".") {
		throw new Error(`recipe: recipes must live directly under rootDir (${resolvedPath})`);
	}
	if (path.extname(relPath) !== ".md") {
		throw new Error(`recipe: recipe files must end in .md (${resolvedPath})`);
	}

	const id = path.basename(relPath, ".md");
	if (id === "") {
		throw new Error(`recipe: recipe filename must not be empty (${resolvedPath})`);
	}
	return id;
}
