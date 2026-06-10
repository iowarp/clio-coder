/**
 * Repo-owned fleet contracts (Symphony P5: work policy lives in the repo,
 * versioned and strictly validated).
 *
 * A fleet contract is a Markdown file at `.clio/fleets/<name>.md` with typed
 * YAML front matter and a prompt-template body. Discovery is project-scope
 * only: no precedence tiers, no global fallbacks. The body uses strict
 * `{{var}}` rendering: every placeholder must resolve from operator-supplied
 * variables or the run fails before any dispatch happens. No filters, no
 * logic, no partial rendering.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parseFrontmatter } from "./frontmatter.js";

export type FleetStepScope = "readonly" | "workspace";
export type FleetOnFailure = "stop" | "continue";

export interface FleetContractStep {
	agent: string;
	scope: FleetStepScope;
}

export interface FleetContract {
	name: string;
	description: string;
	steps: ReadonlyArray<FleetContractStep>;
	maxWorkers: number;
	budgetUsd: number | null;
	onFailure: FleetOnFailure;
	/** Prompt template body with unresolved {{var}} placeholders. */
	body: string;
	path: string;
}

export interface FleetContractListing {
	name: string;
	path: string;
	contract: FleetContract | null;
	error: string | null;
}

const FleetScopeSchema = Type.Union([Type.Literal("readonly"), Type.Literal("workspace")]);

/**
 * Unknown top-level keys are tolerated for forward compatibility (Symphony
 * §5.3); unknown values inside known keys are not.
 */
const FleetFrontmatterSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	description: Type.Optional(Type.String()),
	steps: Type.Array(
		Type.Object({
			agent: Type.String({ minLength: 1 }),
			scope: Type.Optional(FleetScopeSchema),
		}),
		{ minItems: 1 },
	),
	maxWorkers: Type.Optional(Type.Integer({ minimum: 1 })),
	budgetUsd: Type.Optional(Type.Number()),
	onFailure: Type.Optional(Type.Union([Type.Literal("stop"), Type.Literal("continue")])),
});

function firstSchemaError(frontmatter: Record<string, unknown>): string | null {
	if (Value.Check(FleetFrontmatterSchema, frontmatter)) return null;
	const first = [...Value.Errors(FleetFrontmatterSchema, frontmatter)][0];
	return first ? `${first.instancePath || "(root)"}: ${first.message}` : "front matter failed validation";
}

export function fleetsDir(cwd: string): string {
	return join(cwd, ".clio", "fleets");
}

export function parseFleetContract(raw: string, sourcePath: string): FleetContract {
	const { frontmatter, body } = parseFrontmatter(raw, sourcePath);
	const schemaError = firstSchemaError(frontmatter);
	if (schemaError !== null) {
		throw new Error(`fleet contract ${sourcePath}: ${schemaError}`);
	}
	const fm = frontmatter as {
		name: string;
		description?: string;
		steps: Array<{ agent: string; scope?: FleetStepScope }>;
		maxWorkers?: number;
		budgetUsd?: number;
		onFailure?: FleetOnFailure;
	};
	if (fm.budgetUsd !== undefined && !(fm.budgetUsd > 0)) {
		throw new Error(`fleet contract ${sourcePath}: budgetUsd must be a positive number`);
	}
	const trimmedBody = body.trim();
	if (trimmedBody.length === 0) {
		throw new Error(`fleet contract ${sourcePath}: prompt body is empty`);
	}
	return {
		name: fm.name,
		description: fm.description ?? "",
		steps: fm.steps.map((step) => ({ agent: step.agent, scope: step.scope ?? "workspace" })),
		maxWorkers: fm.maxWorkers ?? 1,
		budgetUsd: fm.budgetUsd ?? null,
		onFailure: fm.onFailure ?? "stop",
		body: trimmedBody,
		path: sourcePath,
	};
}

export function loadFleetContract(cwd: string, name: string): FleetContract {
	const path = join(fleetsDir(cwd), `${name}.md`);
	if (!existsSync(path)) {
		throw new Error(`fleet contract not found: ${path}`);
	}
	return parseFleetContract(readFileSync(path, "utf8"), path);
}

/**
 * Enumerate every `.clio/fleets/*.md`. Invalid files are listed with their
 * error, never hidden: an operator must see exactly what is invalid.
 */
export function listFleetContracts(cwd: string): FleetContractListing[] {
	const dir = fleetsDir(cwd);
	if (!existsSync(dir)) return [];
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.sort();
	} catch {
		return [];
	}
	return files.map((file) => {
		const path = join(dir, file);
		const name = basename(file, ".md");
		try {
			const contract = parseFleetContract(readFileSync(path, "utf8"), path);
			return { name, path, contract, error: null };
		} catch (err) {
			return { name, path, contract: null, error: err instanceof Error ? err.message : String(err) };
		}
	});
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;

/**
 * Strict template rendering (Symphony §5.4). Every `{{var}}` must resolve;
 * an unresolved placeholder throws with the full list of missing names.
 */
export function renderFleetPrompt(body: string, vars: Readonly<Record<string, string>>): string {
	const missing = new Set<string>();
	const rendered = body.replace(PLACEHOLDER_RE, (_match, name: string) => {
		const value = vars[name];
		if (value === undefined) {
			missing.add(name);
			return "";
		}
		return value;
	});
	if (missing.size > 0) {
		throw new Error(`fleet prompt: unresolved template variables: ${[...missing].join(", ")} (pass --var name=value)`);
	}
	return rendered;
}
