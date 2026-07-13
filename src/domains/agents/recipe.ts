import path from "node:path";
import type {
	AgentAudience,
	AgentCapabilityClass,
	AgentCategory,
	AgentLatencyClass,
	AgentProjectContextTier,
} from "./spec.js";

export type RecipeThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Authored worker-loop phase policy carried by an agent recipe. */
export interface AgentBudget {
	/** Admitted tool-call boundary before the final-response phase. */
	toolCalls: number;
	/** Tail of the admitted boundary reserved for canonical `read` calls. */
	readReserve: number;
	/** Whether reaching the boundary transitions to text-only synthesis. */
	synthesis: boolean;
}

const AGENT_BUDGET_KEYS = ["toolCalls", "readReserve", "synthesis"] as const;

/** Strict parser shared by built-in, user, and project recipes. */
export function parseAgentBudget(value: unknown, sourcePath: string): AgentBudget | undefined {
	if (value === undefined) return undefined;
	const prefix = `agent budget: ${sourcePath}: budget`;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${prefix} must be a non-null YAML object`);
	}

	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!(AGENT_BUDGET_KEYS as ReadonlyArray<string>).includes(key)) {
			throw new Error(`${prefix}.${key} is unknown`);
		}
	}
	for (const key of AGENT_BUDGET_KEYS) {
		if (!Object.hasOwn(record, key)) throw new Error(`${prefix}.${key} is required`);
	}

	const toolCalls = record.toolCalls;
	if (typeof toolCalls !== "number" || !Number.isSafeInteger(toolCalls)) {
		throw new Error(`${prefix}.toolCalls must be a finite safe integer`);
	}
	if (toolCalls <= 0) throw new Error(`${prefix}.toolCalls must be greater than 0`);

	const readReserve = record.readReserve;
	if (typeof readReserve !== "number" || !Number.isSafeInteger(readReserve)) {
		throw new Error(`${prefix}.readReserve must be a finite safe integer`);
	}
	if (readReserve < 0) throw new Error(`${prefix}.readReserve must be greater than or equal to 0`);
	if (readReserve >= toolCalls) throw new Error(`${prefix}.readReserve must be less than budget.toolCalls`);

	const synthesis = record.synthesis;
	if (typeof synthesis !== "boolean") throw new Error(`${prefix}.synthesis must be a boolean`);

	return { toolCalls, readReserve, synthesis };
}

export interface AgentRecipe {
	id: string;
	name: string;
	description: string;
	tools?: ReadonlyArray<string>;
	model?: string;
	target?: string;
	thinkingLevel?: RecipeThinkingLevel;
	budget?: AgentBudget;
	/** Legacy recipe hint only; dispatch target selection comes from configured worker targets/profiles. */
	runtime?: "native" | "cli";
	skills?: ReadonlyArray<string>;
	category?: AgentCategory;
	capabilityClass?: AgentCapabilityClass;
	latencyClass?: AgentLatencyClass;
	/** Overrides the capability-class default for the bounded project-context message. */
	projectContextTier?: AgentProjectContextTier;
	audience?: AgentAudience;
	tags?: ReadonlyArray<string>;
	output?: string;
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
