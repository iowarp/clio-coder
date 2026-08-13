/**
 * Repo-owned deterministic command registry for fleet code steps.
 *
 * A code step names a command id; it never authors a shell string. The binding
 * from id to argv lives in the repository at `.clio/fleets/commands.yaml`,
 * beside the fleet contracts that reference it. Two properties follow:
 *
 *   - A model cannot invent an invocation. The worst a contract can do is name
 *     an id, and an unknown id fails contract validation before any dispatch.
 *   - A contract stays portable. A shipped SDLC fleet can say "run the test
 *     command" without knowing whether this repo uses npm, uv, or bun.
 *
 * The registry is deliberately not a front-matter block on each contract: the
 * same `test` binding is needed by every contract that tests, and duplicating
 * argv per contract is how one of the copies silently rots.
 *
 * Fail closed. A missing registry is not an empty registry; a contract with a
 * code step and no registry is invalid, so an unconfigured repo cannot pass a
 * test phase that never ran anything.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import yaml from "yaml";

/** Upper bound on any single deterministic step, generous enough for a full suite. */
const FLEET_COMMAND_MAX_TIMEOUT_MS = 3_600_000;
const FLEET_COMMAND_MIN_TIMEOUT_MS = 1_000;
export const FLEET_COMMAND_DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Variables every registered command receives. Code steps run with a closed
 * environment rather than the operator's, so a subprocess cannot read a
 * provider key that happens to be exported in the orchestrator's shell. A
 * command that genuinely needs one more variable names it in `env`.
 */
export const FLEET_COMMAND_BASE_ENV: ReadonlyArray<string> = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR"];

export interface FleetCommand {
	id: string;
	/** argv list, never a shell string: no quoting bugs and no shell injection. */
	argv: ReadonlyArray<string>;
	/** Workspace-relative working directory; "" means the workspace root. */
	cwd: string;
	timeoutMs: number;
	/** Extra environment variable names passed through on top of the base allowlist. */
	env: ReadonlyArray<string>;
	description: string;
}

export interface FleetCommandRegistry {
	version: 1;
	commands: ReadonlyMap<string, FleetCommand>;
	path: string;
}

const CommandSchema = Type.Object(
	{
		argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		cwd: Type.Optional(Type.String({ minLength: 1 })),
		timeoutMs: Type.Optional(
			Type.Integer({ minimum: FLEET_COMMAND_MIN_TIMEOUT_MS, maximum: FLEET_COMMAND_MAX_TIMEOUT_MS }),
		),
		env: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		description: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const RegistrySchema = Type.Object(
	{
		version: Type.Literal(1),
		commands: Type.Record(Type.String({ minLength: 1 }), CommandSchema, { minProperties: 1 }),
	},
	{ additionalProperties: false },
);

const COMMAND_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/u;

export function fleetCommandsPath(cwd: string): string {
	return join(cwd, ".clio", "fleets", "commands.yaml");
}

function firstSchemaError(value: unknown): string | null {
	if (Value.Check(RegistrySchema, value)) return null;
	const first = [...Value.Errors(RegistrySchema, value)][0];
	return first ? `${first.instancePath || "(root)"}: ${first.message}` : "command registry failed validation";
}

/** Reject a relative directory that climbs out of the workspace or is absolute. */
function checkCwd(id: string, value: string, sourcePath: string): string {
	if (isAbsolute(value)) {
		throw new Error(`fleet commands ${sourcePath}: command '${id}' cwd must be workspace-relative`);
	}
	const normalized = normalize(value);
	if (normalized === ".." || normalized.startsWith(`..${"/"}`) || normalized.split(/[\\/]/u).includes("..")) {
		throw new Error(`fleet commands ${sourcePath}: command '${id}' cwd escapes the workspace`);
	}
	return normalized === "." ? "" : normalized;
}

export function parseFleetCommands(raw: string, sourcePath: string): FleetCommandRegistry {
	let parsed: unknown;
	try {
		parsed = yaml.parse(raw);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`fleet commands ${sourcePath}: invalid YAML (${reason})`);
	}
	const schemaError = firstSchemaError(parsed);
	if (schemaError !== null) throw new Error(`fleet commands ${sourcePath}: ${schemaError}`);
	const registry = parsed as {
		version: 1;
		commands: Record<string, { argv: string[]; cwd?: string; timeoutMs?: number; env?: string[]; description?: string }>;
	};
	const commands = new Map<string, FleetCommand>();
	for (const [id, entry] of Object.entries(registry.commands)) {
		if (!COMMAND_ID_RE.test(id)) {
			throw new Error(`fleet commands ${sourcePath}: command id '${id}' must match ${COMMAND_ID_RE.source}`);
		}
		const executable = entry.argv[0] ?? "";
		if (executable.trim().length === 0) {
			throw new Error(`fleet commands ${sourcePath}: command '${id}' has an empty executable`);
		}
		for (const name of entry.env ?? []) {
			if (!ENV_NAME_RE.test(name)) {
				throw new Error(`fleet commands ${sourcePath}: command '${id}' env name '${name}' is not a variable name`);
			}
		}
		commands.set(id, {
			id,
			argv: [...entry.argv],
			cwd: entry.cwd === undefined ? "" : checkCwd(id, entry.cwd, sourcePath),
			timeoutMs: entry.timeoutMs ?? FLEET_COMMAND_DEFAULT_TIMEOUT_MS,
			env: [...(entry.env ?? [])],
			description: entry.description ?? "",
		});
	}
	return { version: 1, commands, path: sourcePath };
}

/**
 * Read the registry, or null when the repo declares none. Null is a distinct
 * answer from an empty registry: callers turn it into a validation failure
 * only for contracts that actually contain a code step.
 */
export function loadFleetCommands(cwd: string): FleetCommandRegistry | null {
	const path = fleetCommandsPath(cwd);
	if (!existsSync(path)) return null;
	return parseFleetCommands(readFileSync(path, "utf8"), path);
}
