import { enabledPluginResourceRoots } from "../plugins/index.js";
import { resolvePackagePathReference, resolvePackageReferences } from "../resources/package-references.js";
/**
 * Repo-owned playbooks (Symphony P5: work policy lives in the repo, versioned
 * and strictly validated). A playbook is what the fleet runs.
 *
 * A playbook is a Markdown file at `.clio-coder/playbooks/<name>.md` with typed
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
import { clioConfigDir } from "../../core/xdg.js";
import { parseFrontmatter } from "./frontmatter.js";
import {
	loadPlaybookCommands,
	type PlaybookCommandRegistry,
	resolvePlaybookCommandArgs,
	validatePlaybookCommandArgs,
} from "./playbook-commands.js";
import { normalizeWriteBoundary, WRITE_BOUNDARY_MAX_ENTRIES } from "./write-boundary.js";

export type PlaybookStepScope = "readonly" | "workspace";
export type PlaybookOnFailure = "stop" | "continue";

/**
 * The first playbook version whose steps declare a write boundary, and the
 * version at which boundaries are enforced at all.
 *
 * Enforcement is opt-in by version rather than retroactive. A v3 playbook's
 * `workspace` step means today exactly what it meant when it was written: the
 * whole checkout. Turning that into "and now the run fails if anything else
 * changes" under a repo that never asked for it would break working pipelines
 * on an upgrade. A v4 playbook asks for boundaries by saying so, and then every
 * one of its steps declares one, including `readonly`, which is the empty
 * allowlist stated out loud.
 */
export const PLAYBOOK_WRITE_BOUNDARY_VERSION = 4;
export const PLAYBOOK_DYNAMIC_STEP_VERSION = 5;

/**
 * Upper bound on any declared loop. A loop is bounded in the playbook, and the
 * bound is bounded here: five attempts already costs five verifications and
 * four repair dispatches, and a workflow that needs more than that is not
 * converging.
 */
export const PLAYBOOK_LOOP_MAX_ATTEMPTS = 5;

/**
 * A step a model runs. Its authority, role, and route come from its recipe.
 *
 * `writes` is the boundary, and it deliberately lives here rather than on the
 * recipe. A recipe is identity: which model, which tools, which result
 * playbook, which role. A boundary is a property of one use of that agent in
 * one workflow, and the same `coder` legitimately owns `src/` in one playbook and
 * `docs/` in another. Putting it on the recipe would need a merge rule between
 * the two declarations (widen? intersect? override?), and every answer to that
 * question is a way for a boundary to end up wider than the playbook an
 * operator read. Present only in `PLAYBOOK_WRITE_BOUNDARY_VERSION` playbooks.
 */
export interface PlaybookAgentStep {
	kind: "agent";
	id: string;
	agent: string;
	scope: PlaybookStepScope;
	dependencies: ReadonlyArray<string>;
	writes?: ReadonlyArray<string>;
	target?: string;
	profile?: string;
}

export interface PlaybookGateStep {
	kind: "gate";
	id: string;
	agent: string;
	path: string;
	run: string;
	scope: "workspace";
	dependencies: ReadonlyArray<string>;
	target?: string;
	profile?: string;
}

export interface PlaybookPlanStep {
	kind: "plan";
	id: string;
	agent: string;
	roster: ReadonlyArray<string>;
	maxTasks: number;
	proposals: boolean;
	scope: PlaybookStepScope;
	dependencies: ReadonlyArray<string>;
	writes?: ReadonlyArray<string>;
	target?: string;
	profile?: string;
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
export interface PlaybookCodeStep {
	kind: "code";
	id: string;
	command: string;
	args?: ReadonlyArray<string>;
	scope: PlaybookStepScope;
	dependencies: ReadonlyArray<string>;
	commitFrom?: ReadonlyArray<string>;
	writes?: ReadonlyArray<string>;
}

/** The verification half of a loop: the question that decides continuation. */
export type PlaybookLoopCheck =
	| {
			kind: "code";
			command: string;
			args?: ReadonlyArray<string>;
			scope: PlaybookStepScope;
			writes?: ReadonlyArray<string>;
	  }
	| {
			kind: "agent";
			agent: string;
			scope: PlaybookStepScope;
			writes?: ReadonlyArray<string>;
			target?: string;
			profile?: string;
	  }
	| { kind: "gate"; gate: string };

/** The repair half. Always an agent: a deterministic repair is just a check. */
export interface PlaybookLoopRepair {
	kind: "agent";
	agent: string;
	scope: PlaybookStepScope;
	writes?: ReadonlyArray<string>;
	target?: string;
	profile?: string;
}

/**
 * A bounded check/repair loop.
 *
 * `maxAttempts` is the number of verifications, so the loop dispatches at most
 * `maxAttempts - 1` repairs. The bound is declared, never inferred: an
 * undeclared bound is an unbounded spend, and the playbook is where an operator
 * gets to see the ceiling before anything runs.
 *
 * The loop compiles to statically unrolled, conditionally executed plan nodes,
 * so the execution plan stays a deterministic hashed DAG and every attempt
 * keeps its own receipt.
 */
export interface PlaybookLoopStep {
	kind: "loop";
	id: string;
	maxAttempts: number;
	dependencies: ReadonlyArray<string>;
	check: PlaybookLoopCheck;
	repair: PlaybookLoopRepair;
}

export type PlaybookStep =
	| PlaybookAgentStep
	| PlaybookCodeStep
	| PlaybookLoopStep
	| PlaybookGateStep
	| PlaybookPlanStep;

/**
 * Playbook schema version.
 *
 * v1 keeps its exact original meaning: an agent-only playbook. v2 is the version
 * that may contain code steps. v3 adds bounded loops and commit steps. v4 adds
 * declared write boundaries and enforces them. Each is a deliberate bump rather
 * than an additive optional discriminant, because the difference is not
 * cosmetic: a reader that does not understand code steps must refuse the whole
 * playbook rather than run a partial DAG whose deterministic gates are absent,
 * a reader that does not understand loops would run one verification where
 * three were declared, and a reader that does not understand `writes` would run
 * a step the playbook says is confined to `docs/` with the whole tree in reach.
 * A version literal gives that reader a clear refusal instead of an obscure
 * unknown-property error deep in a step.
 */
export type PlaybookVersion = 1 | 2 | 3 | 4 | 5;

export interface Playbook {
	version: PlaybookVersion;
	name: string;
	description: string;
	steps: ReadonlyArray<PlaybookStep>;
	maxWorkers: number;
	budgetUsd: number | null;
	onFailure: PlaybookOnFailure;
	writers?: 1;
	/** Prompt template body with unresolved {{var}} placeholders. */
	body: string;
	path: string;
}

export type PlaybookSource = "builtin" | "plugin" | "user" | "project";

export interface PlaybookListing {
	name: string;
	path: string;
	source: PlaybookSource;
	playbook: Playbook | null;
	error: string | null;
	/**
	 * The command ids a well-formed playbook binds when the repo declares no
	 * registry at all, and null in every other case.
	 *
	 * This is the difference between a playbook that is wrong and one this repo
	 * has not finished configuring. Two of the three shipped builtins bind code
	 * steps, so a fresh checkout listed them as `invalid` beside an error that
	 * named a file and no way to produce it. They stay unrunnable either way
	 * (`playbook` is null and `error` is set, so nothing can plan one by
	 * accident), but an operator can tell which of the two problems they have.
	 */
	needsCommands: ReadonlyArray<string> | null;
}

const PlaybookScopeSchema = Type.Union([Type.Literal("readonly"), Type.Literal("workspace")]);

/** The `writes` allowlist exists only from `PLAYBOOK_WRITE_BOUNDARY_VERSION`. */
function writesSchema(version: PlaybookVersion) {
	return version >= PLAYBOOK_WRITE_BOUNDARY_VERSION
		? { writes: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: WRITE_BOUNDARY_MAX_ENTRIES })) }
		: {};
}

function routeSchema(version: PlaybookVersion) {
	return version >= PLAYBOOK_DYNAMIC_STEP_VERSION
		? { target: Type.Optional(Type.String({ minLength: 1 })), profile: Type.Optional(Type.String({ minLength: 1 })) }
		: {};
}

function agentStepSchema(version: PlaybookVersion) {
	return Type.Object(
		{
			kind: Type.Optional(Type.Literal("agent")),
			id: Type.String({ minLength: 1 }),
			agent: Type.String({ minLength: 1 }),
			scope: PlaybookScopeSchema,
			dependencies: Type.Array(Type.String({ minLength: 1 })),
			...writesSchema(version),
			...routeSchema(version),
		},
		{ additionalProperties: false },
	);
}

function gateStepSchema() {
	return Type.Object(
		{
			kind: Type.Literal("gate"),
			id: Type.String({ minLength: 1 }),
			agent: Type.String({ minLength: 1 }),
			path: Type.String({ minLength: 1 }),
			run: Type.String({ minLength: 1 }),
			scope: Type.Optional(Type.Literal("workspace")),
			dependencies: Type.Array(Type.String({ minLength: 1 })),
			...routeSchema(5),
		},
		{ additionalProperties: false },
	);
}

function planStepSchema() {
	return Type.Object(
		{
			kind: Type.Literal("plan"),
			id: Type.String({ minLength: 1 }),
			agent: Type.Optional(Type.String({ minLength: 1 })),
			roster: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 16 }),
			maxTasks: Type.Integer({ minimum: 1, maximum: 16 }),
			proposals: Type.Optional(Type.Boolean()),
			scope: PlaybookScopeSchema,
			dependencies: Type.Array(Type.String({ minLength: 1 })),
			...writesSchema(5),
			...routeSchema(5),
		},
		{ additionalProperties: false },
	);
}

function codeStepSchema(version: PlaybookVersion) {
	return Type.Object(
		{
			kind: Type.Literal("code"),
			id: Type.String({ minLength: 1 }),
			command: Type.String({ minLength: 1 }),
			args: Type.Optional(Type.Array(Type.String({ maxLength: 8192, pattern: "^[^\\u0000]*$" }), { maxItems: 64 })),
			scope: PlaybookScopeSchema,
			dependencies: Type.Array(Type.String({ minLength: 1 })),
			...(version >= 3 ? { commitFrom: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })) } : {}),
			...writesSchema(version),
		},
		{ additionalProperties: false },
	);
}

function loopStepSchema(version: PlaybookVersion) {
	return Type.Object(
		{
			kind: Type.Literal("loop"),
			id: Type.String({ minLength: 1 }),
			// Required and finite: this is the whole point of the construct.
			maxAttempts: Type.Integer({ minimum: 1, maximum: PLAYBOOK_LOOP_MAX_ATTEMPTS }),
			dependencies: Type.Array(Type.String({ minLength: 1 })),
			check: Type.Union([
				Type.Object(
					{
						kind: Type.Literal("code"),
						command: Type.String({ minLength: 1 }),
						args: Type.Optional(Type.Array(Type.String({ maxLength: 8192, pattern: "^[^\\u0000]*$" }), { maxItems: 64 })),
						scope: PlaybookScopeSchema,
						...writesSchema(version),
					},
					{ additionalProperties: false },
				),
				...(version >= PLAYBOOK_DYNAMIC_STEP_VERSION
					? [
							Type.Object(
								{ kind: Type.Literal("gate"), gate: Type.String({ minLength: 1 }) },
								{ additionalProperties: false },
							),
						]
					: []),
				Type.Object(
					{
						kind: Type.Literal("agent"),
						agent: Type.String({ minLength: 1 }),
						scope: PlaybookScopeSchema,
						...writesSchema(version),
						...routeSchema(version),
					},
					{ additionalProperties: false },
				),
			]),
			repair: Type.Object(
				{
					kind: Type.Optional(Type.Literal("agent")),
					agent: Type.String({ minLength: 1 }),
					scope: PlaybookScopeSchema,
					...writesSchema(version),
					...routeSchema(version),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	);
}

function stepSchema(version: PlaybookVersion) {
	if (version === 1) return agentStepSchema(1);
	if (version === 2) return Type.Union([agentStepSchema(2), codeStepSchema(2)]);
	if (version === 5) {
		return Type.Union([
			agentStepSchema(version),
			codeStepSchema(version),
			loopStepSchema(version),
			gateStepSchema(),
			planStepSchema(),
		]);
	}
	return Type.Union([agentStepSchema(version), codeStepSchema(version), loopStepSchema(version)]);
}

function frontmatterSchema(version: PlaybookVersion) {
	return Type.Object(
		{
			version: Type.Literal(version),
			name: Type.String({ minLength: 1 }),
			description: Type.Optional(Type.String()),
			steps: Type.Array(stepSchema(version), { minItems: 1 }),
			maxWorkers: Type.Integer({ minimum: 1 }),
			budgetUsd: Type.Optional(Type.Number()),
			onFailure: Type.Union([Type.Literal("stop"), Type.Literal("continue")]),
			...(version >= PLAYBOOK_DYNAMIC_STEP_VERSION ? { writers: Type.Optional(Type.Literal(1)) } : {}),
		},
		{ additionalProperties: false },
	);
}

const SCHEMAS: Readonly<Record<PlaybookVersion, ReturnType<typeof frontmatterSchema>>> = {
	1: frontmatterSchema(1),
	2: frontmatterSchema(2),
	3: frontmatterSchema(3),
	4: frontmatterSchema(4),
	5: frontmatterSchema(5),
};

function playbookVersion(frontmatter: Record<string, unknown>): PlaybookVersion | null {
	const value = frontmatter.version;
	return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 ? value : null;
}

function firstSchemaError(frontmatter: Record<string, unknown>, version: PlaybookVersion): string | null {
	const schema = SCHEMAS[version];
	if (Value.Check(schema, frontmatter)) return null;
	const first = [...Value.Errors(schema, frontmatter)][0];
	return first ? `${first.instancePath || "(root)"}: ${first.message}` : "front matter failed validation";
}

function projectPlaybooksDir(cwd: string): string {
	return join(cwd, ".clio-coder", "playbooks");
}

type RawStep = {
	kind?: "agent" | "code" | "loop" | "gate" | "plan";
	id: string;
	agent?: string;
	command?: string;
	args?: string[];
	commitFrom?: string[];
	writes?: string[];
	maxAttempts?: number;
	check?: {
		kind: "code" | "agent" | "gate";
		command?: string;
		args?: string[];
		agent?: string;
		gate?: string;
		scope: PlaybookStepScope;
		writes?: string[];
		target?: string;
		profile?: string;
	};
	repair?: {
		kind?: "agent";
		agent: string;
		scope: PlaybookStepScope;
		writes?: string[];
		target?: string;
		profile?: string;
	};
	target?: string;
	profile?: string;
	path?: string;
	run?: string;
	roster?: string[];
	maxTasks?: number;
	proposals?: boolean;
} & Pick<PlaybookAgentStep, "scope"> & { dependencies: string[] };

/** Normalized declaration, or nothing when this version declares no boundary. */
function normalizedWrites(writes: string[] | undefined): { writes?: ReadonlyArray<string> } {
	return writes === undefined ? {} : { writes: normalizeWriteBoundary(writes) };
}

function normalizeStep(step: RawStep): PlaybookStep {
	const route = (value: { target?: string; profile?: string }): { target?: string; profile?: string } => ({
		...(value.target !== undefined ? { target: value.target } : {}),
		...(value.profile !== undefined ? { profile: value.profile } : {}),
	});
	if (step.kind === "gate") {
		return {
			kind: "gate",
			id: step.id,
			agent: step.agent ?? "",
			path: step.path ?? "",
			run: step.run ?? "",
			scope: "workspace",
			dependencies: [...step.dependencies],
			...route(step),
		};
	}
	if (step.kind === "plan") {
		return {
			kind: "plan",
			id: step.id,
			agent: step.agent ?? "architect",
			roster: [...(step.roster ?? [])],
			maxTasks: step.maxTasks ?? 0,
			proposals: step.proposals ?? false,
			scope: step.scope,
			dependencies: [...step.dependencies],
			...normalizedWrites(step.writes),
			...route(step),
		};
	}
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
					? {
							kind: "code",
							command: check.command ?? "",
							...(check.args ? { args: [...check.args] } : {}),
							scope: check.scope,
							...normalizedWrites(check.writes),
						}
					: check.kind === "gate"
						? { kind: "gate", gate: check.gate ?? "" }
						: {
								kind: "agent",
								agent: check.agent ?? "",
								scope: check.scope,
								...normalizedWrites(check.writes),
								...route(check),
							},
			repair: {
				kind: "agent",
				agent: repair.agent,
				scope: repair.scope,
				...normalizedWrites(repair.writes),
				...route(repair),
			},
		};
	}
	if (step.kind === "code") {
		return {
			kind: "code",
			id: step.id,
			command: step.command ?? "",
			...(step.args ? { args: [...step.args] } : {}),
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
		...route(step),
	};
}

/** Plan-node id of one unrolled loop verification. Attempts are 1-based. */
export function playbookLoopCheckStepId(loopId: string, attempt: number): string {
	return `${loopId}.check.${attempt}`;
}

/** Plan-node id of one unrolled loop repair. Repair `n` follows check `n`. */
export function playbookLoopRepairStepId(loopId: string, attempt: number): string {
	return `${loopId}.repair.${attempt}`;
}

/** Every id this playbook will occupy in a compiled plan, declared or generated. */
function occupiedIds(playbook: Pick<Playbook, "steps">): Map<string, string> {
	const owners = new Map<string, string>();
	for (const step of playbook.steps) {
		owners.set(step.id, step.id);
		if (step.kind !== "loop") continue;
		for (let attempt = 1; attempt <= step.maxAttempts; attempt++) {
			owners.set(playbookLoopCheckStepId(step.id, attempt), step.id);
			if (attempt < step.maxAttempts) owners.set(playbookLoopRepairStepId(step.id, attempt), step.id);
		}
	}
	return owners;
}

/**
 * Reject a playbook whose graph cannot execute: duplicate or colliding ids,
 * dangling dependencies, self-reference, a cycle, or a commit whose message
 * source is not something it waits for.
 *
 * A cycle among steps is the "mutually looping" declaration the loop construct
 * exists to replace. Loops are bounded and unrolled; a dependency edge that
 * comes back around is not, so it is refused here rather than discovered as a
 * scheduling deadlock.
 */
export function validatePlaybookGraph(playbook: Pick<Playbook, "steps" | "path">): void {
	const declared = new Set<string>();
	for (const step of playbook.steps) {
		if (declared.has(step.id)) throw new Error(`playbook ${playbook.path}: duplicate step id '${step.id}'`);
		declared.add(step.id);
	}
	const owners = new Map<string, string>();
	for (const step of playbook.steps) {
		if (step.kind !== "loop") continue;
		for (const [generated, owner] of occupiedIds({ steps: [step] })) {
			if (generated === step.id) continue;
			if (declared.has(generated)) {
				throw new Error(`playbook ${playbook.path}: step id '${generated}' collides with an id loop '${owner}' generates`);
			}
			owners.set(generated, owner);
		}
	}
	for (const step of playbook.steps) {
		if (step.kind === "loop" && step.check.kind === "gate") {
			const gateId = step.check.gate;
			const gate = playbook.steps.find((candidate) => candidate.id === gateId);
			if (gate?.kind !== "gate") {
				throw new Error(`playbook ${playbook.path}: loop '${step.id}' names unknown gate '${gateId}'`);
			}
		}
		for (const dependency of step.dependencies) {
			if (dependency === step.id) throw new Error(`playbook ${playbook.path}: step '${step.id}' depends on itself`);
			if (!declared.has(dependency)) {
				throw new Error(`playbook ${playbook.path}: step '${step.id}' has unknown dependency '${dependency}'`);
			}
		}
	}
	// Kahn's algorithm over declared steps. Loop members are internal and
	// linear, so a playbook-level cycle can only run through declared edges.
	const remaining = new Set(declared);
	const settled = new Set<string>();
	while (remaining.size > 0) {
		const ready = playbook.steps.filter(
			(step) => remaining.has(step.id) && step.dependencies.every((dependency) => settled.has(dependency)),
		);
		if (ready.length === 0) {
			throw new Error(`playbook ${playbook.path}: dependency cycle among steps ${[...remaining].sort().join(", ")}`);
		}
		for (const step of ready) {
			remaining.delete(step.id);
			settled.add(step.id);
		}
	}
	const ancestors = playbookStepAncestors(playbook.steps);
	for (const step of playbook.steps) {
		if (step.kind !== "code" || step.commitFrom === undefined) continue;
		for (const source of step.commitFrom) {
			const target = playbook.steps.find((candidate) => candidate.id === source);
			if (target === undefined) {
				throw new Error(`playbook ${playbook.path}: commit step '${step.id}' names unknown source '${source}'`);
			}
			if (target.kind === "code") {
				throw new Error(
					`playbook ${playbook.path}: commit step '${step.id}' source '${source}' is a code step and authors no commit message`,
				);
			}
			if (!(ancestors.get(step.id)?.has(source) ?? false)) {
				throw new Error(
					`playbook ${playbook.path}: commit step '${step.id}' must depend on its message source '${source}'`,
				);
			}
		}
	}
}

/** One declared position that runs, with the boundary it declared. */
export interface PlaybookStepBoundary {
	/** Playbook-level position id: a loop half is named `<loop>.check` / `<loop>.repair`. */
	id: string;
	scope: PlaybookStepScope;
	/** The allowlist, or undefined when this playbook version declares no boundary. */
	writes: ReadonlyArray<string> | undefined;
}

/**
 * The boundary of one position. `readonly` is the empty allowlist rather than
 * an absence: a step that declares it changes nothing is making a checkable
 * claim, and that is the claim enforcement checks. Below
 * `PLAYBOOK_WRITE_BOUNDARY_VERSION` there is no claim at all, which is what
 * `undefined` says.
 */
export function playbookStepWriteBoundary(
	version: PlaybookVersion,
	scope: PlaybookStepScope,
	writes: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined {
	if (version < PLAYBOOK_WRITE_BOUNDARY_VERSION) return undefined;
	return scope === "readonly" ? [] : [...(writes ?? [])];
}

/** Every position a playbook runs, including both halves of every loop. */
export function playbookStepBoundaries(playbook: Pick<Playbook, "steps" | "version">): PlaybookStepBoundary[] {
	const boundaries: PlaybookStepBoundary[] = [];
	const add = (id: string, scope: PlaybookStepScope, writes: ReadonlyArray<string> | undefined): void => {
		boundaries.push({ id, scope, writes: playbookStepWriteBoundary(playbook.version, scope, writes) });
	};
	for (const step of playbook.steps) {
		if (step.kind === "loop") {
			if (step.check.kind === "gate") {
				const gateId = step.check.gate;
				const gate = playbook.steps.find((candidate) => candidate.id === gateId);
				if (gate?.kind === "gate") add(`${step.id}.check`, "workspace", [gate.path]);
			} else add(`${step.id}.check`, step.check.scope, step.check.writes);
			add(`${step.id}.repair`, step.repair.scope, step.repair.writes);
			continue;
		}
		if (step.kind === "gate") {
			add(step.id, "workspace", [step.path]);
			continue;
		}
		add(step.id, step.scope, step.writes);
	}
	return boundaries;
}

/**
 * Per-position boundary rules for a boundary-enforcing playbook.
 *
 * A `workspace` step must say what it may change. Leaving it undeclared in a
 * playbook that enforces boundaries is the ambiguous case the version bump
 * exists to remove: the reader cannot tell whether the author meant "the whole
 * tree" or forgot, and one of those two readings silently disables enforcement
 * for every step scheduled beside it.
 */
function validateWriteBoundaries(playbook: Pick<Playbook, "steps" | "version" | "path">): void {
	if (playbook.version < PLAYBOOK_WRITE_BOUNDARY_VERSION) return;
	for (const position of playbookStepBoundaries(playbook)) {
		if (position.scope === "workspace" && (position.writes?.length ?? 0) === 0) {
			throw new Error(
				`playbook ${playbook.path}: step '${position.id}' has scope 'workspace' and must declare a non-empty 'writes' allowlist at version ${PLAYBOOK_WRITE_BOUNDARY_VERSION}`,
			);
		}
	}
	for (const step of playbook.steps) {
		const declared: Array<{ id: string; scope: PlaybookStepScope; writes: ReadonlyArray<string> | undefined }> =
			step.kind === "loop"
				? [
						...(step.check.kind === "gate"
							? []
							: [{ id: `${step.id}.check`, scope: step.check.scope, writes: step.check.writes }]),
						{ id: `${step.id}.repair`, scope: step.repair.scope, writes: step.repair.writes },
					]
				: step.kind === "gate"
					? []
					: [{ id: step.id, scope: step.scope, writes: step.writes }];
		for (const position of declared) {
			if (position.scope === "readonly" && position.writes !== undefined) {
				throw new Error(
					`playbook ${playbook.path}: step '${position.id}' is 'readonly', which is the empty allowlist; remove its 'writes' or give it scope 'workspace'`,
				);
			}
		}
	}
}

/** Transitive dependency closure per declared step id. */
export function playbookStepAncestors(steps: ReadonlyArray<PlaybookStep>): ReadonlyMap<string, ReadonlySet<string>> {
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
 * `validatePlaybookCommands`, which the loaders call; keeping the two apart lets
 * a caller validate playbook text without touching the filesystem.
 */
export function parsePlaybook(raw: string, sourcePath: string): Playbook {
	const { frontmatter, body } = parseFrontmatter(raw, sourcePath);
	const version = playbookVersion(frontmatter);
	if (version === null) {
		throw new Error(`playbook ${sourcePath}: version must be 1, 2, 3, 4, or 5`);
	}
	if (version < PLAYBOOK_WRITE_BOUNDARY_VERSION) assertNoWritesBefore(frontmatter, sourcePath, version);
	if (version < PLAYBOOK_DYNAMIC_STEP_VERSION) assertNoV5FieldsBefore(frontmatter, sourcePath, version);
	if (version >= PLAYBOOK_DYNAMIC_STEP_VERSION) assertNoGateWrites(frontmatter, sourcePath);
	const schemaError = firstSchemaError(frontmatter, version);
	if (schemaError !== null) {
		throw new Error(`playbook ${sourcePath}: ${schemaError}`);
	}
	const fm = frontmatter as {
		version: PlaybookVersion;
		name: string;
		description?: string;
		steps: RawStep[];
		maxWorkers: number;
		budgetUsd?: number;
		onFailure: PlaybookOnFailure;
		writers?: 1;
	};
	if (fm.budgetUsd !== undefined && !(fm.budgetUsd > 0)) {
		throw new Error(`playbook ${sourcePath}: budgetUsd must be a positive number`);
	}
	const trimmedBody = body.trim();
	if (trimmedBody.length === 0) {
		throw new Error(`playbook ${sourcePath}: prompt body is empty`);
	}
	const playbook: Playbook = {
		version,
		name: fm.name,
		description: fm.description ?? "",
		steps: fm.steps.map(normalizeStep),
		maxWorkers: fm.maxWorkers,
		budgetUsd: fm.budgetUsd ?? null,
		onFailure: fm.onFailure,
		...(fm.writers === 1 ? { writers: 1 as const } : {}),
		body: trimmedBody,
		path: sourcePath,
	};
	validatePlaybookGraph(playbook);
	validateWriteBoundaries(playbook);
	validateV5Declarations(playbook);
	return playbook;
}

function validateV5Declarations(playbook: Playbook): void {
	if (playbook.version < PLAYBOOK_DYNAMIC_STEP_VERSION) return;
	const route = (id: string, value: { target?: string; profile?: string }): void => {
		if (value.target !== undefined && value.profile !== undefined) {
			throw new Error(`playbook ${playbook.path}: step '${id}' may declare target or profile, never both`);
		}
	};
	for (const step of playbook.steps) {
		if (step.kind === "agent" || step.kind === "plan" || step.kind === "gate") route(step.id, step);
		if (step.kind === "plan" && new Set(step.roster).size !== step.roster.length) {
			throw new Error(`playbook ${playbook.path}: plan step '${step.id}' roster contains duplicate agents`);
		}
		if (step.kind === "gate") {
			let normalized: ReadonlyArray<string>;
			try {
				normalized = normalizeWriteBoundary([step.path]);
			} catch (error) {
				throw new Error(
					`playbook ${playbook.path}: gate '${step.id}' path is invalid: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (normalized[0] !== step.path.replaceAll("\\", "/")) {
				throw new Error(`playbook ${playbook.path}: gate '${step.id}' path must be normalized and repository-relative`);
			}
		}
		if (step.kind !== "loop") continue;
		if (step.check.kind === "agent") route(`${step.id}.check`, step.check);
		route(`${step.id}.repair`, step.repair);
	}
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
				`playbook ${sourcePath}: 'writes' requires playbook version ${PLAYBOOK_WRITE_BOUNDARY_VERSION}; this playbook declares version ${version}, where the declaration would not be enforced`,
			);
		}
	}
}

function assertNoGateWrites(frontmatter: Record<string, unknown>, sourcePath: string): void {
	for (const value of Array.isArray(frontmatter.steps) ? frontmatter.steps : []) {
		if (typeof value !== "object" || value === null) continue;
		const step = value as Record<string, unknown>;
		if (step.kind !== "gate" || typeof step.id !== "string" || step.id.length === 0 || !("writes" in step)) continue;
		throw new Error(
			`playbook ${sourcePath}: gate step '${step.id}' must not declare 'writes'; its write boundary is derived from 'path'`,
		);
	}
}

function assertNoV5FieldsBefore(frontmatter: Record<string, unknown>, sourcePath: string, version: number): void {
	const forbidden = ["target", "profile"] as const;
	if ("writers" in frontmatter) {
		throw new Error(
			`playbook ${sourcePath}: 'writers' requires playbook version ${PLAYBOOK_DYNAMIC_STEP_VERSION}; this playbook declares version ${version}`,
		);
	}
	for (const value of Array.isArray(frontmatter.steps) ? frontmatter.steps : []) {
		if (typeof value !== "object" || value === null) continue;
		const step = value as Record<string, unknown>;
		if (step.kind === "plan" || step.kind === "gate") {
			throw new Error(
				`playbook ${sourcePath}: kind '${String(step.kind)}' requires playbook version ${PLAYBOOK_DYNAMIC_STEP_VERSION}; this playbook declares version ${version}`,
			);
		}
		for (const candidate of [step, step.check, step.repair]) {
			if (typeof candidate !== "object" || candidate === null) continue;
			for (const field of forbidden) {
				if (field in candidate) {
					throw new Error(
						`playbook ${sourcePath}: '${field}' requires playbook version ${PLAYBOOK_DYNAMIC_STEP_VERSION}; this playbook declares version ${version}`,
					);
				}
			}
		}
	}
}

/**
 * Every registered command this playbook invokes, in declaration order: the
 * declared code steps plus the deterministic half of every loop. A loop's
 * check is a code step in every way that matters to the registry, so it is
 * bound to a real command by the same validation.
 */
export function playbookCodeSteps(
	playbook: Playbook,
): Array<{ id: string; command: string; args?: ReadonlyArray<string> }> {
	const steps: Array<{ id: string; command: string; args?: ReadonlyArray<string> }> = [];
	for (const step of playbook.steps) {
		if (step.kind === "code")
			steps.push({ id: step.id, command: step.command, ...(step.args ? { args: step.args } : {}) });
		else if (step.kind === "gate") steps.push({ id: step.id, command: step.run });
		else if (step.kind === "loop" && step.check.kind === "code") {
			steps.push({
				id: playbookLoopCheckStepId(step.id, 1),
				command: step.check.command,
				...(step.check.args ? { args: step.check.args } : {}),
			});
		}
	}
	return steps;
}

/** Where a repo declares what its playbook command ids run, relative to its root. */
export const PLAYBOOK_COMMANDS_REPO_PATH = ".clio-coder/playbooks/commands.yaml";

/** How to produce that file, for the surfaces that report it missing by name. */
export const PLAYBOOK_COMMANDS_REMEDY =
	"declare each id there under `commands:` with an `argv` list; see bundled `docs/guide/fleet-dispatch.md` for the schema";

/**
 * A well-formed playbook binding code steps in a repo that declares no command
 * registry. Separate from every other validation failure because it is the one
 * an operator fixes by writing a file rather than by correcting the playbook,
 * and because two of the three shipped builtins land here on a fresh checkout.
 */
export class PlaybookCommandRegistryMissingError extends Error {
	constructor(
		readonly playbookPath: string,
		readonly commands: ReadonlyArray<string>,
	) {
		super(
			`playbook ${playbookPath}: code steps require a command registry at ${PLAYBOOK_COMMANDS_REPO_PATH} declaring ${commands.join(", ")}`,
		);
		this.name = "PlaybookCommandRegistryMissingError";
	}
}

/**
 * Bind every code step to a registered command. A playbook that names a
 * command the repo has not declared is invalid, and so is one that declares
 * code steps in a repo with no registry at all. Silence here would be the
 * failure mode this whole mechanism exists to prevent: a green test phase that
 * never ran a test.
 */
export function validatePlaybookCommands(
	playbook: Playbook,
	registry: PlaybookCommandRegistry | null,
	vars?: Readonly<Record<string, string>>,
): void {
	const codeSteps = playbookCodeSteps(playbook);
	if (codeSteps.length === 0) return;
	if (registry === null) {
		throw new PlaybookCommandRegistryMissingError(
			playbook.path,
			[...new Set(codeSteps.map((step) => step.command))].sort(),
		);
	}
	for (const step of codeSteps) {
		const command = registry.commands.get(step.command);
		if (!command) {
			const known = [...registry.commands.keys()].sort().join(", ");
			throw new Error(
				`playbook ${playbook.path}: step '${step.id}' names unknown command '${step.command}' (registered: ${known || "none"})`,
			);
		}
		const args = vars === undefined ? (step.args ?? []) : resolvePlaybookCommandArgs(step.args ?? [], vars);
		validatePlaybookCommandArgs(command, args, { allowTemplates: vars === undefined });
	}
}

/**
 * Where the shipped SDLC chains live. Builtin playbooks are packaged beside the
 * builtin recipes they reference, and a project file of the same name shadows
 * one: a repo that wants a different `sdlc` writes `.clio-coder/playbooks/sdlc.md`
 * and gets it, with no precedence surprises beyond that single rule.
 */
function builtinPlaybooksDir(): string {
	return join(resolvePackageRoot(), "src", "domains", "agents", "playbooks");
}

export function resolvePlaybookReferences(
	playbook: Playbook,
	source: { source: PlaybookSource; rootPath?: string },
): Playbook {
	if (!source.rootPath) return playbook;
	const context = { rootPath: source.rootPath, plugin: source.source === "plugin" };
	// Authored text is resolved after schema parsing; paths cannot inject YAML keys.
	return {
		...playbook,
		body: resolvePackageReferences(playbook.body, context),
		steps: playbook.steps.map((step) => {
			if (step.kind === "code" && step.args)
				return { ...step, args: step.args.map((arg) => resolvePackagePathReference(arg, context)) };
			if (step.kind === "loop" && step.check.kind === "code" && step.check.args)
				return {
					...step,
					check: { ...step.check, args: step.check.args.map((arg) => resolvePackagePathReference(arg, context)) },
				};
			return step;
		}),
	};
}

function playbookSources(cwd: string): ReadonlyArray<{ dir: string; source: PlaybookSource; rootPath?: string }> {
	return [
		{ dir: builtinPlaybooksDir(), source: "builtin" },
		...enabledPluginResourceRoots("playbooks", cwd)
			.sort((left, right) => left.source.localeCompare(right.source))
			.map((root) => ({ dir: root.path, rootPath: root.rootPath, source: "plugin" as const })),
		{ dir: join(clioConfigDir(), "playbooks"), source: "user" },
		{ dir: projectPlaybooksDir(cwd), source: "project" },
	];
}

function locatePlaybook(cwd: string, name: string): { path: string; source: PlaybookSource; rootPath?: string } | null {
	for (const source of [...playbookSources(cwd)].reverse()) {
		const candidate = join(source.dir, `${name}.md`);
		if (existsSync(candidate))
			return { path: candidate, source: source.source, ...(source.rootPath ? { rootPath: source.rootPath } : {}) };
	}
	return null;
}

export function loadPlaybook(cwd: string, name: string): Playbook {
	const located = locatePlaybook(cwd, name);
	if (located === null) {
		throw new Error(
			`playbook not found: ${join(projectPlaybooksDir(cwd), `${name}.md`)} (and no builtin named '${name}')`,
		);
	}
	const playbook = resolvePlaybookReferences(parsePlaybook(readFileSync(located.path, "utf8"), located.path), located);
	validatePlaybookCommands(playbook, loadPlaybookCommands(cwd));
	return playbook;
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
 * Enumerate the builtin playbooks plus every plugin, user and project one, later
 * sources shadowing earlier ones of the same name. Invalid files are listed with their
 * error, never hidden: an operator must see exactly what is invalid, and a
 * builtin that needs a command this repo has not registered is exactly that.
 */
export function listPlaybooks(cwd: string): PlaybookListing[] {
	let registry: PlaybookCommandRegistry | null = null;
	let registryError: string | null = null;
	try {
		registry = loadPlaybookCommands(cwd);
	} catch (err) {
		registryError = err instanceof Error ? err.message : String(err);
	}
	const listings = new Map<string, PlaybookListing>();
	const sources = playbookSources(cwd);
	for (const { dir, source, rootPath } of sources) {
		for (const file of listDirectory(dir)) {
			const path = join(dir, file);
			const name = basename(file, ".md");
			try {
				const playbook = resolvePlaybookReferences(parsePlaybook(readFileSync(path, "utf8"), path), {
					source,
					...(rootPath ? { rootPath } : {}),
				});
				if (registryError !== null && playbookCodeSteps(playbook).length > 0) throw new Error(registryError);
				validatePlaybookCommands(playbook, registry);
				listings.set(name, { name, path, source, playbook, error: null, needsCommands: null });
			} catch (err) {
				listings.set(name, {
					name,
					path,
					source,
					playbook: null,
					error: err instanceof Error ? err.message : String(err),
					// A registry this repo never wrote is unfinished setup. A registry
					// that exists and does not parse, or one missing an id the playbook
					// names, is a real error and stays one.
					needsCommands: err instanceof PlaybookCommandRegistryMissingError ? err.commands : null,
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
export function renderPlaybookPrompt(body: string, vars: Readonly<Record<string, string>>): string {
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
		throw new Error(`playbook prompt: unresolved template variables: ${[...missing].join(", ")} (pass --var name=value)`);
	}
	return rendered;
}
