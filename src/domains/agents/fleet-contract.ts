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
import { resolvePackageRoot } from "../../core/package-root.js";
import { type FleetCommandRegistry, loadFleetCommands } from "./fleet-commands.js";
import { parseFrontmatter } from "./frontmatter.js";

export type FleetStepScope = "readonly" | "workspace";
export type FleetOnFailure = "stop" | "continue";

/**
 * Upper bound on any declared loop. A loop is bounded in the contract, and the
 * bound is bounded here: five attempts already costs five verifications and
 * four repair dispatches, and a workflow that needs more than that is not
 * converging.
 */
export const FLEET_LOOP_MAX_ATTEMPTS = 5;

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
 *
 * `commitFrom` marks the step as a commit: its message is the words of the
 * agent that produced the work, read from the first listed candidate that both
 * ran and answered a `commitMessage`. The list is ordered most recent first,
 * because the work product a commit describes is whatever last touched it, and
 * a loop id stands for that loop's repair attempts.
 */
export interface FleetContractCodeStep {
	kind: "code";
	id: string;
	command: string;
	scope: FleetStepScope;
	dependencies: ReadonlyArray<string>;
	commitFrom?: ReadonlyArray<string>;
}

/** The verification half of a loop: the question that decides continuation. */
export type FleetContractLoopCheck =
	| { kind: "code"; command: string; scope: FleetStepScope }
	| { kind: "agent"; agent: string; scope: FleetStepScope };

/** The repair half. Always an agent: a deterministic repair is just a check. */
export interface FleetContractLoopRepair {
	kind: "agent";
	agent: string;
	scope: FleetStepScope;
}

/**
 * A bounded check/repair loop.
 *
 * `maxAttempts` is the number of verifications, so the loop dispatches at most
 * `maxAttempts - 1` repairs. The bound is declared, never inferred: an
 * undeclared bound is an unbounded spend, and the contract is where an operator
 * gets to see the ceiling before anything runs.
 *
 * The loop compiles to statically unrolled, conditionally executed plan nodes,
 * so the execution plan stays a deterministic hashed DAG and every attempt
 * keeps its own receipt.
 */
export interface FleetContractLoopStep {
	kind: "loop";
	id: string;
	maxAttempts: number;
	dependencies: ReadonlyArray<string>;
	check: FleetContractLoopCheck;
	repair: FleetContractLoopRepair;
}

export type FleetContractStep = FleetContractAgentStep | FleetContractCodeStep | FleetContractLoopStep;

/**
 * Contract schema version.
 *
 * v1 keeps its exact original meaning: an agent-only fleet. v2 is the version
 * that may contain code steps. v3 adds bounded loops and commit steps. Each is
 * a deliberate bump rather than an additive optional discriminant, because the
 * difference is not cosmetic: a reader that does not understand code steps must
 * refuse the whole contract rather than run a partial DAG whose deterministic
 * gates are absent, and a reader that does not understand loops would run one
 * verification where three were declared. A version literal gives that reader a
 * clear refusal instead of an obscure unknown-property error deep in a step.
 */
export type FleetContractVersion = 1 | 2 | 3;

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

export type FleetContractSource = "builtin" | "project";

export interface FleetContractListing {
	name: string;
	path: string;
	source: FleetContractSource;
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

function codeStepSchema(version: FleetContractVersion) {
	return Type.Object(
		{
			kind: Type.Literal("code"),
			id: Type.String({ minLength: 1 }),
			command: Type.String({ minLength: 1 }),
			scope: FleetScopeSchema,
			dependencies: Type.Array(Type.String({ minLength: 1 })),
			...(version >= 3 ? { commitFrom: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })) } : {}),
		},
		{ additionalProperties: false },
	);
}

const LoopStepSchema = Type.Object(
	{
		kind: Type.Literal("loop"),
		id: Type.String({ minLength: 1 }),
		// Required and finite: this is the whole point of the construct.
		maxAttempts: Type.Integer({ minimum: 1, maximum: FLEET_LOOP_MAX_ATTEMPTS }),
		dependencies: Type.Array(Type.String({ minLength: 1 })),
		check: Type.Union([
			Type.Object(
				{ kind: Type.Literal("code"), command: Type.String({ minLength: 1 }), scope: FleetScopeSchema },
				{ additionalProperties: false },
			),
			Type.Object(
				{ kind: Type.Literal("agent"), agent: Type.String({ minLength: 1 }), scope: FleetScopeSchema },
				{ additionalProperties: false },
			),
		]),
		repair: Type.Object(
			{
				kind: Type.Optional(Type.Literal("agent")),
				agent: Type.String({ minLength: 1 }),
				scope: FleetScopeSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

function stepSchema(version: FleetContractVersion) {
	if (version === 1) return AgentStepSchema;
	if (version === 2) return Type.Union([AgentStepSchema, codeStepSchema(2)]);
	return Type.Union([AgentStepSchema, codeStepSchema(3), LoopStepSchema]);
}

function frontmatterSchema(version: FleetContractVersion) {
	return Type.Object(
		{
			version: Type.Literal(version),
			name: Type.String({ minLength: 1 }),
			description: Type.Optional(Type.String()),
			steps: Type.Array(stepSchema(version), { minItems: 1 }),
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
	3: frontmatterSchema(3),
};

function contractVersion(frontmatter: Record<string, unknown>): FleetContractVersion | null {
	const value = frontmatter.version;
	return value === 1 || value === 2 || value === 3 ? value : null;
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

type RawStep = {
	kind?: "agent" | "code" | "loop";
	id: string;
	agent?: string;
	command?: string;
	commitFrom?: string[];
	maxAttempts?: number;
	check?: { kind: "code" | "agent"; command?: string; agent?: string; scope: FleetStepScope };
	repair?: { kind?: "agent"; agent: string; scope: FleetStepScope };
} & Pick<FleetContractAgentStep, "scope"> & { dependencies: string[] };

function normalizeStep(step: RawStep): FleetContractStep {
	if (step.kind === "loop") {
		const check = step.check as NonNullable<RawStep["check"]>;
		const repair = step.repair as NonNullable<RawStep["repair"]>;
		return {
			kind: "loop",
			id: step.id,
			maxAttempts: step.maxAttempts ?? 0,
			dependencies: [...step.dependencies],
			check:
				check.kind === "code"
					? { kind: "code", command: check.command ?? "", scope: check.scope }
					: { kind: "agent", agent: check.agent ?? "", scope: check.scope },
			repair: { kind: "agent", agent: repair.agent, scope: repair.scope },
		};
	}
	if (step.kind === "code") {
		return {
			kind: "code",
			id: step.id,
			command: step.command ?? "",
			scope: step.scope,
			dependencies: [...step.dependencies],
			...(step.commitFrom !== undefined ? { commitFrom: [...step.commitFrom] } : {}),
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

/** Plan-node id of one unrolled loop verification. Attempts are 1-based. */
export function fleetLoopCheckStepId(loopId: string, attempt: number): string {
	return `${loopId}.check.${attempt}`;
}

/** Plan-node id of one unrolled loop repair. Repair `n` follows check `n`. */
export function fleetLoopRepairStepId(loopId: string, attempt: number): string {
	return `${loopId}.repair.${attempt}`;
}

/** Every id this contract will occupy in a compiled plan, declared or generated. */
function occupiedIds(contract: Pick<FleetContract, "steps">): Map<string, string> {
	const owners = new Map<string, string>();
	for (const step of contract.steps) {
		owners.set(step.id, step.id);
		if (step.kind !== "loop") continue;
		for (let attempt = 1; attempt <= step.maxAttempts; attempt++) {
			owners.set(fleetLoopCheckStepId(step.id, attempt), step.id);
			if (attempt < step.maxAttempts) owners.set(fleetLoopRepairStepId(step.id, attempt), step.id);
		}
	}
	return owners;
}

/**
 * Reject a contract whose graph cannot execute: duplicate or colliding ids,
 * dangling dependencies, self-reference, a cycle, or a commit whose message
 * source is not something it waits for.
 *
 * A cycle among steps is the "mutually looping" declaration the loop construct
 * exists to replace. Loops are bounded and unrolled; a dependency edge that
 * comes back around is not, so it is refused here rather than discovered as a
 * scheduling deadlock.
 */
export function validateFleetGraph(contract: Pick<FleetContract, "steps" | "path">): void {
	const declared = new Set<string>();
	for (const step of contract.steps) {
		if (declared.has(step.id)) throw new Error(`fleet contract ${contract.path}: duplicate step id '${step.id}'`);
		declared.add(step.id);
	}
	const owners = new Map<string, string>();
	for (const step of contract.steps) {
		if (step.kind !== "loop") continue;
		for (const [generated, owner] of occupiedIds({ steps: [step] })) {
			if (generated === step.id) continue;
			if (declared.has(generated)) {
				throw new Error(
					`fleet contract ${contract.path}: step id '${generated}' collides with an id loop '${owner}' generates`,
				);
			}
			owners.set(generated, owner);
		}
	}
	for (const step of contract.steps) {
		for (const dependency of step.dependencies) {
			if (dependency === step.id) throw new Error(`fleet contract ${contract.path}: step '${step.id}' depends on itself`);
			if (!declared.has(dependency)) {
				throw new Error(`fleet contract ${contract.path}: step '${step.id}' has unknown dependency '${dependency}'`);
			}
		}
	}
	// Kahn's algorithm over declared steps. Loop members are internal and
	// linear, so a contract-level cycle can only run through declared edges.
	const remaining = new Set(declared);
	const settled = new Set<string>();
	while (remaining.size > 0) {
		const ready = contract.steps.filter(
			(step) => remaining.has(step.id) && step.dependencies.every((dependency) => settled.has(dependency)),
		);
		if (ready.length === 0) {
			throw new Error(`fleet contract ${contract.path}: dependency cycle among steps ${[...remaining].sort().join(", ")}`);
		}
		for (const step of ready) {
			remaining.delete(step.id);
			settled.add(step.id);
		}
	}
	const ancestors = fleetStepAncestors(contract.steps);
	for (const step of contract.steps) {
		if (step.kind !== "code" || step.commitFrom === undefined) continue;
		for (const source of step.commitFrom) {
			const target = contract.steps.find((candidate) => candidate.id === source);
			if (target === undefined) {
				throw new Error(`fleet contract ${contract.path}: commit step '${step.id}' names unknown source '${source}'`);
			}
			if (target.kind === "code") {
				throw new Error(
					`fleet contract ${contract.path}: commit step '${step.id}' source '${source}' is a code step and authors no commit message`,
				);
			}
			if (!(ancestors.get(step.id)?.has(source) ?? false)) {
				throw new Error(
					`fleet contract ${contract.path}: commit step '${step.id}' must depend on its message source '${source}'`,
				);
			}
		}
	}
}

/** Transitive dependency closure per declared step id. */
export function fleetStepAncestors(steps: ReadonlyArray<FleetContractStep>): ReadonlyMap<string, ReadonlySet<string>> {
	const direct = new Map(steps.map((step) => [step.id, step.dependencies]));
	const closure = new Map<string, Set<string>>();
	const resolve = (id: string, seen: Set<string>): Set<string> => {
		const cached = closure.get(id);
		if (cached !== undefined) return cached;
		const result = new Set<string>();
		if (seen.has(id)) return result;
		seen.add(id);
		for (const dependency of direct.get(id) ?? []) {
			result.add(dependency);
			for (const inherited of resolve(dependency, seen)) result.add(inherited);
		}
		closure.set(id, result);
		return result;
	};
	for (const step of steps) resolve(step.id, new Set());
	return closure;
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
		throw new Error(
			`fleet contract ${sourcePath}: version must be 1 (agent steps), 2 (agent and code steps), or 3 (adds bounded loops and commit steps)`,
		);
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
	const contract: FleetContract = {
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
	validateFleetGraph(contract);
	return contract;
}

/** Every loop in the contract, in declaration order. */
export function fleetLoopSteps(contract: FleetContract): FleetContractLoopStep[] {
	return contract.steps.filter((step): step is FleetContractLoopStep => step.kind === "loop");
}

/**
 * Every registered command this contract invokes, in declaration order: the
 * declared code steps plus the deterministic half of every loop. A loop's
 * check is a code step in every way that matters to the registry, so it is
 * bound to a real command by the same validation.
 */
export function fleetCodeSteps(contract: FleetContract): Array<{ id: string; command: string }> {
	const steps: Array<{ id: string; command: string }> = [];
	for (const step of contract.steps) {
		if (step.kind === "code") steps.push({ id: step.id, command: step.command });
		else if (step.kind === "loop" && step.check.kind === "code") {
			steps.push({ id: fleetLoopCheckStepId(step.id, 1), command: step.check.command });
		}
	}
	return steps;
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

/**
 * Where the shipped SDLC chains live. Builtin fleets are packaged beside the
 * builtin recipes they reference, and a project file of the same name shadows
 * one: a repo that wants a different `sdlc` writes `.clio/fleets/sdlc.md` and
 * gets it, with no precedence surprises beyond that single rule.
 */
export function builtinFleetsDir(): string {
	return join(resolvePackageRoot(), "src", "domains", "agents", "fleets");
}

function fleetContractPath(cwd: string, name: string): { path: string; source: FleetContractSource } | null {
	const projectPath = join(fleetsDir(cwd), `${name}.md`);
	if (existsSync(projectPath)) return { path: projectPath, source: "project" };
	const builtinPath = join(builtinFleetsDir(), `${name}.md`);
	if (existsSync(builtinPath)) return { path: builtinPath, source: "builtin" };
	return null;
}

export function loadFleetContract(cwd: string, name: string): FleetContract {
	const located = fleetContractPath(cwd, name);
	if (located === null) {
		throw new Error(`fleet contract not found: ${join(fleetsDir(cwd), `${name}.md`)} (and no builtin named '${name}')`);
	}
	const contract = parseFleetContract(readFileSync(located.path, "utf8"), located.path);
	validateFleetCommands(contract, loadFleetCommands(cwd));
	return contract;
}

function listDirectory(dir: string): string[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.sort();
	} catch {
		return [];
	}
}

/**
 * Enumerate the builtin fleets plus every `.clio/fleets/*.md`, project files
 * shadowing builtins of the same name. Invalid files are listed with their
 * error, never hidden: an operator must see exactly what is invalid, and a
 * builtin that needs a command this repo has not registered is exactly that.
 */
export function listFleetContracts(cwd: string): FleetContractListing[] {
	let registry: FleetCommandRegistry | null = null;
	let registryError: string | null = null;
	try {
		registry = loadFleetCommands(cwd);
	} catch (err) {
		registryError = err instanceof Error ? err.message : String(err);
	}
	const listings = new Map<string, FleetContractListing>();
	const sources: ReadonlyArray<{ dir: string; source: FleetContractSource }> = [
		{ dir: builtinFleetsDir(), source: "builtin" },
		{ dir: fleetsDir(cwd), source: "project" },
	];
	for (const { dir, source } of sources) {
		for (const file of listDirectory(dir)) {
			const path = join(dir, file);
			const name = basename(file, ".md");
			try {
				const contract = parseFleetContract(readFileSync(path, "utf8"), path);
				if (registryError !== null && fleetCodeSteps(contract).length > 0) throw new Error(registryError);
				validateFleetCommands(contract, registry);
				listings.set(name, { name, path, source, contract, error: null });
			} catch (err) {
				listings.set(name, {
					name,
					path,
					source,
					contract: null,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}
	return [...listings.values()].sort((left, right) => left.name.localeCompare(right.name));
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
