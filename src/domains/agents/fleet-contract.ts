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
import { type FleetCommandRegistry, loadFleetCommands } from "./fleet-commands.js";
import { parseFrontmatter } from "./frontmatter.js";

export type FleetStepScope = "readonly" | "workspace";
export type FleetOnFailure = "stop" | "continue";

/** A step a model runs. Its authority, role, and route come from its recipe. */
export interface FleetContractAgentStep {
	kind: "agent";
	id: string;
	agent: string;
	scope: FleetStepScope;
	dependencies: ReadonlyArray<string>;
}

/**
 * A step code runs. `command` is an id into the repo's command registry, never
 * an invocation: an agent rediscovering the test runner burns a context window
 * to learn what a subprocess already knows.
 */
export interface FleetContractCodeStep {
	kind: "code";
	id: string;
	command: string;
	scope: FleetStepScope;
	dependencies: ReadonlyArray<string>;
}

export type FleetContractStep = FleetContractAgentStep | FleetContractCodeStep;

/**
 * Contract schema version.
 *
 * v1 keeps its exact original meaning: an agent-only fleet. v2 is the version
 * that may contain code steps. This is a deliberate bump rather than an
 * additive optional discriminant on v1, because the difference is not
 * cosmetic: a reader that does not understand code steps must refuse the whole
 * contract rather than run a partial DAG whose deterministic gates are absent.
 * A version literal gives that reader a clear refusal ("version must be 1")
 * instead of an obscure unknown-property error deep in a step.
 */
export type FleetContractVersion = 1 | 2;

export interface FleetContract {
	version: FleetContractVersion;
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

const AgentStepSchema = Type.Object(
	{
		kind: Type.Optional(Type.Literal("agent")),
		id: Type.String({ minLength: 1 }),
		agent: Type.String({ minLength: 1 }),
		scope: FleetScopeSchema,
		dependencies: Type.Array(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const CodeStepSchema = Type.Object(
	{
		kind: Type.Literal("code"),
		id: Type.String({ minLength: 1 }),
		command: Type.String({ minLength: 1 }),
		scope: FleetScopeSchema,
		dependencies: Type.Array(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

function frontmatterSchema(version: FleetContractVersion) {
	return Type.Object(
		{
			version: Type.Literal(version),
			name: Type.String({ minLength: 1 }),
			description: Type.Optional(Type.String()),
			steps: Type.Array(version === 1 ? AgentStepSchema : Type.Union([AgentStepSchema, CodeStepSchema]), {
				minItems: 1,
			}),
			maxWorkers: Type.Integer({ minimum: 1 }),
			budgetUsd: Type.Optional(Type.Number()),
			onFailure: Type.Union([Type.Literal("stop"), Type.Literal("continue")]),
		},
		{ additionalProperties: false },
	);
}

const SCHEMAS: Readonly<Record<FleetContractVersion, ReturnType<typeof frontmatterSchema>>> = {
	1: frontmatterSchema(1),
	2: frontmatterSchema(2),
};

function contractVersion(frontmatter: Record<string, unknown>): FleetContractVersion | null {
	return frontmatter.version === 1 ? 1 : frontmatter.version === 2 ? 2 : null;
}

function firstSchemaError(frontmatter: Record<string, unknown>, version: FleetContractVersion): string | null {
	const schema = SCHEMAS[version];
	if (Value.Check(schema, frontmatter)) return null;
	const first = [...Value.Errors(schema, frontmatter)][0];
	return first ? `${first.instancePath || "(root)"}: ${first.message}` : "front matter failed validation";
}

export function fleetsDir(cwd: string): string {
	return join(cwd, ".clio", "fleets");
}

type RawStep = { kind?: "agent" | "code"; id: string; agent?: string; command?: string } & Pick<
	FleetContractAgentStep,
	"scope"
> & { dependencies: string[] };

function normalizeStep(step: RawStep): FleetContractStep {
	if (step.kind === "code") {
		return {
			kind: "code",
			id: step.id,
			command: step.command ?? "",
			scope: step.scope,
			dependencies: [...step.dependencies],
		};
	}
	return {
		kind: "agent",
		id: step.id,
		agent: step.agent ?? "",
		scope: step.scope,
		dependencies: [...step.dependencies],
	};
}

/**
 * Structural parse only. Command ids are bound against the repo registry by
 * `validateFleetCommands`, which the loaders call; keeping the two apart lets
 * a caller validate contract text without touching the filesystem.
 */
export function parseFleetContract(raw: string, sourcePath: string): FleetContract {
	const { frontmatter, body } = parseFrontmatter(raw, sourcePath);
	const version = contractVersion(frontmatter);
	if (version === null) {
		throw new Error(`fleet contract ${sourcePath}: version must be 1 (agent steps) or 2 (agent and code steps)`);
	}
	const schemaError = firstSchemaError(frontmatter, version);
	if (schemaError !== null) {
		throw new Error(`fleet contract ${sourcePath}: ${schemaError}`);
	}
	const fm = frontmatter as {
		version: FleetContractVersion;
		name: string;
		description?: string;
		steps: RawStep[];
		maxWorkers: number;
		budgetUsd?: number;
		onFailure: FleetOnFailure;
	};
	if (fm.budgetUsd !== undefined && !(fm.budgetUsd > 0)) {
		throw new Error(`fleet contract ${sourcePath}: budgetUsd must be a positive number`);
	}
	const trimmedBody = body.trim();
	if (trimmedBody.length === 0) {
		throw new Error(`fleet contract ${sourcePath}: prompt body is empty`);
	}
	return {
		version,
		name: fm.name,
		description: fm.description ?? "",
		steps: fm.steps.map(normalizeStep),
		maxWorkers: fm.maxWorkers,
		budgetUsd: fm.budgetUsd ?? null,
		onFailure: fm.onFailure,
		body: trimmedBody,
		path: sourcePath,
	};
}

/** Every code step in the contract, in declaration order. */
export function fleetCodeSteps(contract: FleetContract): FleetContractCodeStep[] {
	return contract.steps.filter((step): step is FleetContractCodeStep => step.kind === "code");
}

/**
 * Bind every code step to a registered command. A contract that names a
 * command the repo has not declared is invalid, and so is one that declares
 * code steps in a repo with no registry at all. Silence here would be the
 * failure mode this whole mechanism exists to prevent: a green test phase that
 * never ran a test.
 */
export function validateFleetCommands(contract: FleetContract, registry: FleetCommandRegistry | null): void {
	const codeSteps = fleetCodeSteps(contract);
	if (codeSteps.length === 0) return;
	if (registry === null) {
		throw new Error(
			`fleet contract ${contract.path}: code steps require a command registry at .clio/fleets/commands.yaml`,
		);
	}
	for (const step of codeSteps) {
		if (!registry.commands.has(step.command)) {
			const known = [...registry.commands.keys()].sort().join(", ");
			throw new Error(
				`fleet contract ${contract.path}: step '${step.id}' names unknown command '${step.command}' (registered: ${known || "none"})`,
			);
		}
	}
}

export function loadFleetContract(cwd: string, name: string): FleetContract {
	const path = join(fleetsDir(cwd), `${name}.md`);
	if (!existsSync(path)) {
		throw new Error(`fleet contract not found: ${path}`);
	}
	const contract = parseFleetContract(readFileSync(path, "utf8"), path);
	validateFleetCommands(contract, loadFleetCommands(cwd));
	return contract;
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
	let registry: FleetCommandRegistry | null = null;
	let registryError: string | null = null;
	try {
		registry = loadFleetCommands(cwd);
	} catch (err) {
		registryError = err instanceof Error ? err.message : String(err);
	}
	return files.map((file) => {
		const path = join(dir, file);
		const name = basename(file, ".md");
		try {
			const contract = parseFleetContract(readFileSync(path, "utf8"), path);
			if (registryError !== null && fleetCodeSteps(contract).length > 0) throw new Error(registryError);
			validateFleetCommands(contract, registry);
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
