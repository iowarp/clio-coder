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
import { normalizeWriteBoundary, WRITE_BOUNDARY_MAX_ENTRIES } from "./write-boundary.js";

export type FleetStepScope = "readonly" | "workspace";
export type FleetOnFailure = "stop" | "continue";

/**
 * The first contract version whose steps declare a write boundary, and the
 * version at which boundaries are enforced at all.
 *
 * Enforcement is opt-in by version rather than retroactive. A v3 contract's
 * `workspace` step means today exactly what it meant when it was written: the
 * whole checkout. Turning that into "and now the run fails if anything else
 * changes" under a repo that never asked for it would break working pipelines
 * on an upgrade. A v4 contract asks for boundaries by saying so, and then every
 * one of its steps declares one, including `readonly`, which is the empty
 * allowlist stated out loud.
 */
export const FLEET_WRITE_BOUNDARY_VERSION = 4;

/**
 * Upper bound on any declared loop. A loop is bounded in the contract, and the
 * bound is bounded here: five attempts already costs five verifications and
 * four repair dispatches, and a workflow that needs more than that is not
 * converging.
 */
export const FLEET_LOOP_MAX_ATTEMPTS = 5;

/**
 * A step a model runs. Its authority, role, and route come from its recipe.
 *
 * `writes` is the boundary, and it deliberately lives here rather than on the
 * recipe. A recipe is identity: which model, which tools, which result
 * contract, which role. A boundary is a property of one use of that agent in
 * one workflow, and the same `coder` legitimately owns `src/` in one fleet and
 * `docs/` in another. Putting it on the recipe would need a merge rule between
 * the two declarations (widen? intersect? override?), and every answer to that
 * question is a way for a boundary to end up wider than the contract an
 * operator read. Present only in `FLEET_WRITE_BOUNDARY_VERSION` contracts.
 */
export interface FleetContractAgentStep {
	kind: "agent";
	id: string;
	agent: string;
	scope: FleetStepScope;
	dependencies: ReadonlyArray<string>;
	writes?: ReadonlyArray<string>;
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
	writes?: ReadonlyArray<string>;
}

/** The verification half of a loop: the question that decides continuation. */
export type FleetContractLoopCheck =
	| { kind: "code"; command: string; scope: FleetStepScope; writes?: ReadonlyArray<string> }
	| { kind: "agent"; agent: string; scope: FleetStepScope; writes?: ReadonlyArray<string> };

/** The repair half. Always an agent: a deterministic repair is just a check. */
export interface FleetContractLoopRepair {
	kind: "agent";
	agent: string;
	scope: FleetStepScope;
	writes?: ReadonlyArray<string>;
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
 * that may contain code steps. v3 adds bounded loops and commit steps. v4 adds
 * declared write boundaries and enforces them. Each is a deliberate bump rather
 * than an additive optional discriminant, because the difference is not
 * cosmetic: a reader that does not understand code steps must refuse the whole
 * contract rather than run a partial DAG whose deterministic gates are absent,
 * a reader that does not understand loops would run one verification where
 * three were declared, and a reader that does not understand `writes` would run
 * a step the contract says is confined to `docs/` with the whole tree in reach.
 * A version literal gives that reader a clear refusal instead of an obscure
 * unknown-property error deep in a step.
 */
export type FleetContractVersion = 1 | 2 | 3 | 4;

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
	/**
	 * The command ids a well-formed contract binds when the repo declares no
	 * registry at all, and null in every other case.
	 *
	 * This is the difference between a contract that is wrong and one this repo
	 * has not finished configuring. Two of the three shipped builtins bind code
	 * steps, so a fresh checkout listed them as `invalid` beside an error that
	 * named a file and no way to produce it. They stay unrunnable either way
	 * (`contract` is null and `error` is set, so nothing can plan one by
	 * accident), but an operator can tell which of the two problems they have.
	 */
	needsCommands: ReadonlyArray<string> | null;
}

const FleetScopeSchema = Type.Union([Type.Literal("readonly"), Type.Literal("workspace")]);

/** The `writes` allowlist exists only from `FLEET_WRITE_BOUNDARY_VERSION`. */
function writesSchema(version: FleetContractVersion) {
	return version >= FLEET_WRITE_BOUNDARY_VERSION
		? { writes: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: WRITE_BOUNDARY_MAX_ENTRIES })) }
		: {};
}

function agentStepSchema(version: FleetContractVersion) {
	return Type.Object(
		{
			kind: Type.Optional(Type.Literal("agent")),
			id: Type.String({ minLength: 1 }),
			agent: Type.String({ minLength: 1 }),
			scope: FleetScopeSchema,
			dependencies: Type.Array(Type.String({ minLength: 1 })),
			...writesSchema(version),
		},
		{ additionalProperties: false },
	);
}

function codeStepSchema(version: FleetContractVersion) {
	return Type.Object(
		{
			kind: Type.Literal("code"),
			id: Type.String({ minLength: 1 }),
			command: Type.String({ minLength: 1 }),
			scope: FleetScopeSchema,
			dependencies: Type.Array(Type.String({ minLength: 1 })),
			...(version >= 3 ? { commitFrom: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })) } : {}),
			...writesSchema(version),
		},
		{ additionalProperties: false },
	);
}

function loopStepSchema(version: FleetContractVersion) {
	return Type.Object(
		{
			kind: Type.Literal("loop"),
			id: Type.String({ minLength: 1 }),
			// Required and finite: this is the whole point of the construct.
			maxAttempts: Type.Integer({ minimum: 1, maximum: FLEET_LOOP_MAX_ATTEMPTS }),
			dependencies: Type.Array(Type.String({ minLength: 1 })),
			check: Type.Union([
				Type.Object(
					{
						kind: Type.Literal("code"),
						command: Type.String({ minLength: 1 }),
						scope: FleetScopeSchema,
						...writesSchema(version),
					},
					{ additionalProperties: false },
				),
				Type.Object(
					{
						kind: Type.Literal("agent"),
						agent: Type.String({ minLength: 1 }),
						scope: FleetScopeSchema,
						...writesSchema(version),
					},
					{ additionalProperties: false },
				),
			]),
			repair: Type.Object(
				{
					kind: Type.Optional(Type.Literal("agent")),
					agent: Type.String({ minLength: 1 }),
					scope: FleetScopeSchema,
					...writesSchema(version),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	);
}

function stepSchema(version: FleetContractVersion) {
	if (version === 1) return agentStepSchema(1);
	if (version === 2) return Type.Union([agentStepSchema(2), codeStepSchema(2)]);
	return Type.Union([agentStepSchema(version), codeStepSchema(version), loopStepSchema(version)]);
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
	4: frontmatterSchema(4),
};

function contractVersion(frontmatter: Record<string, unknown>): FleetContractVersion | null {
	const value = frontmatter.version;
	return value === 1 || value === 2 || value === 3 || value === 4 ? value : null;
}

function firstSchemaError(frontmatter: Record<string, unknown>, version: FleetContractVersion): string | null {
	const schema = SCHEMAS[version];
	if (Value.Check(schema, frontmatter)) return null;
	const first = [...Value.Errors(schema, frontmatter)][0];
	return first ? `${first.instancePath || "(root)"}: ${first.message}` : "front matter failed validation";
}

function fleetsDir(cwd: string): string {
	return join(cwd, ".clio", "fleets");
}

type RawStep = {
	kind?: "agent" | "code" | "loop";
	id: string;
	agent?: string;
	command?: string;
	commitFrom?: string[];
	writes?: string[];
	maxAttempts?: number;
	check?: { kind: "code" | "agent"; command?: string; agent?: string; scope: FleetStepScope; writes?: string[] };
	repair?: { kind?: "agent"; agent: string; scope: FleetStepScope; writes?: string[] };
} & Pick<FleetContractAgentStep, "scope"> & { dependencies: string[] };

/** Normalized declaration, or nothing when this version declares no boundary. */
function normalizedWrites(writes: string[] | undefined): { writes?: ReadonlyArray<string> } {
	return writes === undefined ? {} : { writes: normalizeWriteBoundary(writes) };
}

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
					? { kind: "code", command: check.command ?? "", scope: check.scope, ...normalizedWrites(check.writes) }
					: { kind: "agent", agent: check.agent ?? "", scope: check.scope, ...normalizedWrites(check.writes) },
			repair: { kind: "agent", agent: repair.agent, scope: repair.scope, ...normalizedWrites(repair.writes) },
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
			...normalizedWrites(step.writes),
		};
	}
	return {
		kind: "agent",
		id: step.id,
		agent: step.agent ?? "",
		scope: step.scope,
		dependencies: [...step.dependencies],
		...normalizedWrites(step.writes),
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

/** One declared position that runs, with the boundary it declared. */
export interface FleetStepBoundary {
	/** Contract-level position id: a loop half is named `<loop>.check` / `<loop>.repair`. */
	id: string;
	scope: FleetStepScope;
	/** The allowlist, or undefined when this contract version declares no boundary. */
	writes: ReadonlyArray<string> | undefined;
}

/**
 * The boundary of one position. `readonly` is the empty allowlist rather than
 * an absence: a step that declares it changes nothing is making a checkable
 * claim, and that is the claim enforcement checks. Below
 * `FLEET_WRITE_BOUNDARY_VERSION` there is no claim at all, which is what
 * `undefined` says.
 */
export function fleetStepWriteBoundary(
	version: FleetContractVersion,
	scope: FleetStepScope,
	writes: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined {
	if (version < FLEET_WRITE_BOUNDARY_VERSION) return undefined;
	return scope === "readonly" ? [] : [...(writes ?? [])];
}

/** Every position a contract runs, including both halves of every loop. */
export function fleetStepBoundaries(contract: Pick<FleetContract, "steps" | "version">): FleetStepBoundary[] {
	const boundaries: FleetStepBoundary[] = [];
	const add = (id: string, scope: FleetStepScope, writes: ReadonlyArray<string> | undefined): void => {
		boundaries.push({ id, scope, writes: fleetStepWriteBoundary(contract.version, scope, writes) });
	};
	for (const step of contract.steps) {
		if (step.kind === "loop") {
			add(`${step.id}.check`, step.check.scope, step.check.writes);
			add(`${step.id}.repair`, step.repair.scope, step.repair.writes);
			continue;
		}
		add(step.id, step.scope, step.writes);
	}
	return boundaries;
}

/**
 * Per-position boundary rules for a boundary-enforcing contract.
 *
 * A `workspace` step must say what it may change. Leaving it undeclared in a
 * contract that enforces boundaries is the ambiguous case the version bump
 * exists to remove: the reader cannot tell whether the author meant "the whole
 * tree" or forgot, and one of those two readings silently disables enforcement
 * for every step scheduled beside it.
 */
function validateWriteBoundaries(contract: Pick<FleetContract, "steps" | "version" | "path">): void {
	if (contract.version < FLEET_WRITE_BOUNDARY_VERSION) return;
	for (const position of fleetStepBoundaries(contract)) {
		if (position.scope === "workspace" && (position.writes?.length ?? 0) === 0) {
			throw new Error(
				`fleet contract ${contract.path}: step '${position.id}' has scope 'workspace' and must declare a non-empty 'writes' allowlist at version ${FLEET_WRITE_BOUNDARY_VERSION}`,
			);
		}
	}
	for (const step of contract.steps) {
		const declared: Array<{ id: string; scope: FleetStepScope; writes: ReadonlyArray<string> | undefined }> =
			step.kind === "loop"
				? [
						{ id: `${step.id}.check`, scope: step.check.scope, writes: step.check.writes },
						{ id: `${step.id}.repair`, scope: step.repair.scope, writes: step.repair.writes },
					]
				: [{ id: step.id, scope: step.scope, writes: step.writes }];
		for (const position of declared) {
			if (position.scope === "readonly" && position.writes !== undefined) {
				throw new Error(
					`fleet contract ${contract.path}: step '${position.id}' is 'readonly', which is the empty allowlist; remove its 'writes' or give it scope 'workspace'`,
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
			`fleet contract ${sourcePath}: version must be 1 (agent steps), 2 (agent and code steps), 3 (adds bounded loops and commit steps), or 4 (adds enforced write boundaries)`,
		);
	}
	if (version < FLEET_WRITE_BOUNDARY_VERSION) assertNoWritesBefore(frontmatter, sourcePath, version);
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
	validateWriteBoundaries(contract);
	return contract;
}

/**
 * A `writes` key under an older version is refused by name rather than as an
 * unknown property, because the two readings are far apart: the author wrote a
 * boundary and the runtime would have ignored it.
 */
function assertNoWritesBefore(frontmatter: Record<string, unknown>, sourcePath: string, version: number): void {
	const steps = Array.isArray(frontmatter.steps) ? frontmatter.steps : [];
	const declaresWrites = (value: unknown): boolean =>
		typeof value === "object" && value !== null && "writes" in (value as Record<string, unknown>);
	for (const step of steps) {
		const raw = step as Record<string, unknown>;
		if (declaresWrites(raw) || declaresWrites(raw.check) || declaresWrites(raw.repair)) {
			throw new Error(
				`fleet contract ${sourcePath}: 'writes' requires contract version ${FLEET_WRITE_BOUNDARY_VERSION}; this contract declares version ${version}, where the declaration would not be enforced`,
			);
		}
	}
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

/** Where a repo declares what its fleet command ids run, relative to its root. */
export const FLEET_COMMANDS_REPO_PATH = ".clio/fleets/commands.yaml";

/** How to produce that file, for the surfaces that report it missing by name. */
export const FLEET_COMMANDS_REMEDY =
	"declare each id there under `commands:` with an `argv` list; `clio docs fleet_dispatch` has the schema";

/**
 * A well-formed contract binding code steps in a repo that declares no command
 * registry. Separate from every other validation failure because it is the one
 * an operator fixes by writing a file rather than by correcting the contract,
 * and because two of the three shipped builtins land here on a fresh checkout.
 */
export class FleetCommandRegistryMissingError extends Error {
	constructor(
		readonly contractPath: string,
		readonly commands: ReadonlyArray<string>,
	) {
		super(
			`fleet contract ${contractPath}: code steps require a command registry at ${FLEET_COMMANDS_REPO_PATH} declaring ${commands.join(", ")}`,
		);
		this.name = "FleetCommandRegistryMissingError";
	}
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
		throw new FleetCommandRegistryMissingError(contract.path, [...new Set(codeSteps.map((step) => step.command))].sort());
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
				listings.set(name, { name, path, source, contract, error: null, needsCommands: null });
			} catch (err) {
				listings.set(name, {
					name,
					path,
					source,
					contract: null,
					error: err instanceof Error ? err.message : String(err),
					// A registry this repo never wrote is unfinished setup. A registry
					// that exists and does not parse, or one missing an id the contract
					// names, is a real error and stays one.
					needsCommands: err instanceof FleetCommandRegistryMissingError ? err.commands : null,
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
