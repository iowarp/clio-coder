import path from "node:path";
import { relativePathEscapes } from "../../core/path-containment.js";
import type { WorkerPermissionDeclaration } from "../safety/worker-permit.js";
import type { ResultContract } from "./result-contract.js";
import type {
	AgentAudience,
	AgentCapabilityClass,
	AgentCategory,
	AgentHandbookAudience,
	AgentLatencyClass,
	AgentProduct,
	AgentProjectContextTier,
	AgentTrait,
} from "./spec.js";

/** One bounded worker-loop phase policy. */
export interface AgentBudgetPhase {
	/** Admitted tool-call boundary before the final-response phase. */
	toolCalls: number;
}

/** Authored worker-loop phase policy carried by an agent recipe. */
export interface AgentBudget extends AgentBudgetPhase {
	/** Whether reaching the boundary transitions to text-only synthesis. */
	synthesis: boolean;
	/** Optional upper bound for invocation-level requests. Absence pins the default exactly. */
	maximum?: AgentBudgetPhase;
	/** Wall clock this recipe's runs take at most; it only lowers `fleet.limits.runTimeoutMs` (DESIGN 4.5). */
	timeoutMs?: number;
}

const AGENT_BUDGET_KEYS = ["toolCalls", "synthesis", "maximum", "timeoutMs"] as const;

function parseAgentBudgetPhase(value: unknown, prefix: string): AgentBudgetPhase {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${prefix} must be a non-null YAML object`);
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "toolCalls") throw new Error(`${prefix}.${key} is unknown`);
	}
	if (!Object.hasOwn(record, "toolCalls")) throw new Error(`${prefix}.toolCalls is required`);

	const toolCalls = record.toolCalls;
	if (typeof toolCalls !== "number" || !Number.isSafeInteger(toolCalls)) {
		throw new Error(`${prefix}.toolCalls must be a finite safe integer`);
	}
	if (toolCalls <= 0) throw new Error(`${prefix}.toolCalls must be greater than 0`);

	return { toolCalls };
}

/** Strict parser shared by the one recipe schema and direct contract fixtures. */
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
	for (const key of ["toolCalls", "synthesis"] as const) {
		if (!Object.hasOwn(record, key)) throw new Error(`${prefix}.${key} is required`);
	}

	const phase = parseAgentBudgetPhase({ toolCalls: record.toolCalls }, prefix);

	const synthesis = record.synthesis;
	if (typeof synthesis !== "boolean") throw new Error(`${prefix}.synthesis must be a boolean`);

	const maximum = record.maximum === undefined ? undefined : parseAgentBudgetPhase(record.maximum, `${prefix}.maximum`);
	if (maximum !== undefined && maximum.toolCalls < phase.toolCalls) {
		throw new Error(`${prefix}.maximum.toolCalls must be greater than or equal to budget.toolCalls`);
	}

	const timeoutMs = record.timeoutMs;
	if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1))
		throw new Error(`${prefix}.timeoutMs must be a safe integer of at least 1`);
	return {
		...phase,
		synthesis,
		...(maximum === undefined ? {} : { maximum }),
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	};
}

export interface AgentToolAnyOfRequirement {
	anyOf: ReadonlyArray<string>;
}

export type AgentToolRequirement = string | AgentToolAnyOfRequirement;

/** Authored required/optional semantics. `tools` is the flattened declared inventory. */
export interface AgentToolRequirements {
	required: ReadonlyArray<AgentToolRequirement>;
	optional: ReadonlyArray<string>;
}

/** The only current recipe shape. Every field is explicit and consumed. */
export interface AgentRecipe {
	version: 1;
	/** Filename-derived stable recipe identity; never accepted from frontmatter. */
	id: string;
	name: string;
	description: string;
	tools: ReadonlyArray<string>;
	toolRequirements: AgentToolRequirements;
	skills: ReadonlyArray<string>;
	/** Discovery-resolved paths for bound skills; never parsed from frontmatter. */
	boundSkillPaths: ReadonlyArray<string>;
	/** Each bound skill's own description, in `skills` order; never parsed from frontmatter. */
	boundSkillDescriptions?: ReadonlyArray<string>;
	audience: AgentAudience;
	category: AgentCategory;
	capabilityClass: AgentCapabilityClass;
	latencyClass: AgentLatencyClass;
	projectContextTier: AgentProjectContextTier;
	budget: AgentBudget;
	resultContract: ResultContract;
	product?: AgentProduct;
	/** How the host treats this recipe's runs; see {@link AgentTrait}. */
	traits?: ReadonlyArray<AgentTrait>;
	/** Handbook sections its workers receive; absent derives them from the capability class. */
	handbook?: ReadonlyArray<AgentHandbookAudience>;
	/** Standing allowance for the worker permit: `git` and `asks`. Absent keeps git inspect and settings routing. */
	permissions?: WorkerPermissionDeclaration;
	tags: ReadonlyArray<string>;
	source: "builtin" | "plugin" | "user" | "project";
	filepath: string;
	/** Persona prompt body. */
	body: string;
}

export interface RecipeSource {
	rootPath?: string;
	dir: string;
	source: AgentRecipe["source"];
	/** Project root whose package and skill resources are being discovered. */
	cwd?: string;
	/** Stable provenance used to correlate resources from one package. */
	origin?: string;
	/** The declaring package's skill root; package agents may bind only here. */
	skillRoot?: string;
}

export function recipeIdFromPath(absPath: string, rootDir: string): string {
	const resolvedRoot = path.resolve(rootDir);
	const resolvedPath = path.resolve(absPath);
	const relPath = path.relative(resolvedRoot, resolvedPath);

	if (relPath === "" || relativePathEscapes(relPath)) {
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
