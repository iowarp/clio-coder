/**
 * Repo-owned deterministic command registry for playbook code steps.
 *
 * A code step names a command id; it never authors a shell string. The binding
 * from id to argv lives in the repository at `.clio-coder/playbooks/commands.yaml`,
 * beside the playbooks that reference it. Two properties follow:
 *
 *   - A model cannot invent an invocation. The worst a playbook can do is name
 *     an id, and an unknown id fails playbook validation before any dispatch.
 *   - A playbook stays portable. A shipped SDLC playbook can say "run the test
 *     command" without knowing whether this repo uses npm, uv, or bun.
 *
 * The registry is deliberately not a front-matter block on each playbook: the
 * same `test` binding is needed by every playbook that tests, and duplicating
 * argv per playbook is how one of the copies silently rots.
 *
 * Fail closed. A missing registry is not an empty registry; a playbook with a
 * code step and no registry is invalid, so an unconfigured repo cannot pass a
 * test phase that never ran anything.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import yaml from "yaml";

/** Upper bound on any single deterministic step, generous enough for a full suite. */
const PLAYBOOK_COMMAND_MAX_TIMEOUT_MS = 3_600_000;
const PLAYBOOK_COMMAND_MIN_TIMEOUT_MS = 1_000;
export const PLAYBOOK_COMMAND_DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Variables every registered command receives. Code steps run with a closed
 * environment rather than the operator's, so a subprocess cannot read a
 * provider key that happens to be exported in the orchestrator's shell. A
 * command that genuinely needs one more variable names it in `env`.
 */
export const PLAYBOOK_COMMAND_BASE_ENV: ReadonlyArray<string> = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR"];

export interface PlaybookCommandArgumentSlot {
	name: string;
	maxLength: number;
}

export interface PlaybookCommand {
	/** Operator-owned required positional data slots; omission forbids appended args. */
	argumentSlots?: ReadonlyArray<PlaybookCommandArgumentSlot>;
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

export interface PlaybookCommandRegistry {
	version: 1;
	commands: ReadonlyMap<string, PlaybookCommand>;
	path: string;
}

const CommandSchema = Type.Object(
	{
		argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		argumentSlots: Type.Optional(
			Type.Array(
				Type.Object(
					{
						name: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }),
						maxLength: Type.Integer({ minimum: 1, maximum: 8192 }),
					},
					{ additionalProperties: false },
				),
				{ minItems: 1, maxItems: 64 },
			),
		),
		cwd: Type.Optional(Type.String({ minLength: 1 })),
		timeoutMs: Type.Optional(
			Type.Integer({ minimum: PLAYBOOK_COMMAND_MIN_TIMEOUT_MS, maximum: PLAYBOOK_COMMAND_MAX_TIMEOUT_MS }),
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

export function playbookCommandsPath(cwd: string): string {
	return join(cwd, ".clio-coder", "playbooks", "commands.yaml");
}

function firstSchemaError(value: unknown): string | null {
	if (Value.Check(RegistrySchema, value)) return null;
	const first = [...Value.Errors(RegistrySchema, value)][0];
	return first ? `${first.instancePath || "(root)"}: ${first.message}` : "command registry failed validation";
}

/** Reject a relative directory that climbs out of the workspace or is absolute. */
function checkCwd(id: string, value: string, sourcePath: string): string {
	if (isAbsolute(value)) {
		throw new Error(`playbook commands ${sourcePath}: command '${id}' cwd must be workspace-relative`);
	}
	const normalized = normalize(value);
	if (normalized === ".." || normalized.startsWith(`..${"/"}`) || normalized.split(/[\\/]/u).includes("..")) {
		throw new Error(`playbook commands ${sourcePath}: command '${id}' cwd escapes the workspace`);
	}
	return normalized === "." ? "" : normalized;
}

export function parsePlaybookCommands(raw: string, sourcePath: string): PlaybookCommandRegistry {
	let parsed: unknown;
	try {
		parsed = yaml.parse(raw);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`playbook commands ${sourcePath}: invalid YAML (${reason})`);
	}
	const schemaError = firstSchemaError(parsed);
	if (schemaError !== null) throw new Error(`playbook commands ${sourcePath}: ${schemaError}`);
	const registry = parsed as {
		version: 1;
		commands: Record<
			string,
			{
				argv: string[];
				argumentSlots?: PlaybookCommandArgumentSlot[];
				cwd?: string;
				timeoutMs?: number;
				env?: string[];
				description?: string;
			}
		>;
	};
	const commands = new Map<string, PlaybookCommand>();
	for (const [id, entry] of Object.entries(registry.commands)) {
		if (!COMMAND_ID_RE.test(id)) {
			throw new Error(`playbook commands ${sourcePath}: command id '${id}' must match ${COMMAND_ID_RE.source}`);
		}
		const executable = entry.argv[0] ?? "";
		if (executable.trim().length === 0) {
			throw new Error(`playbook commands ${sourcePath}: command '${id}' has an empty executable`);
		}
		for (const name of entry.env ?? []) {
			if (!ENV_NAME_RE.test(name)) {
				throw new Error(`playbook commands ${sourcePath}: command '${id}' env name '${name}' is not a variable name`);
			}
		}
		if (entry.argumentSlots)
			validatePlaybookCommandArgs(
				{ id, argv: entry.argv, cwd: "", timeoutMs: 1000, env: [], description: "", argumentSlots: entry.argumentSlots },
				entry.argumentSlots.map(() => "{{slot}}"),
				{ allowTemplates: true },
			);
		commands.set(id, {
			id,
			argv: [...entry.argv],
			...(entry.argumentSlots ? { argumentSlots: entry.argumentSlots.map((slot) => ({ ...slot })) } : {}),
			cwd: entry.cwd === undefined ? "" : checkCwd(id, entry.cwd, sourcePath),
			timeoutMs: entry.timeoutMs ?? PLAYBOOK_COMMAND_DEFAULT_TIMEOUT_MS,
			env: [...(entry.env ?? [])],
			description: entry.description ?? "",
		});
	}
	return { version: 1, commands, path: sourcePath };
}

/**
 * Read the registry, or null when the repo declares none. Null is a distinct
 * answer from an empty registry: callers turn it into a validation failure
 * only for playbooks that actually contain a code step.
 */
export function loadPlaybookCommands(cwd: string): PlaybookCommandRegistry | null {
	const path = playbookCommandsPath(cwd);
	if (!existsSync(path)) return null;
	return parsePlaybookCommands(readFileSync(path, "utf8"), path);
}

/** Bind authored code-step arguments before plan admission; each stays one argv token. */
export function resolvePlaybookCommandArgs(
	args: ReadonlyArray<string>,
	vars: Readonly<Record<string, string>> = {},
): string[] {
	if (args.length > 64) throw new Error("playbook code args: at most 64 arguments are allowed");
	return args.map((token) => {
		const match = /^\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}$/u.exec(token);
		if (!match && token.includes("{{")) throw new Error("playbook code args: placeholders must occupy a whole argument");
		const value = match ? vars[match[1] ?? ""] : token;
		if (value === undefined)
			throw new Error(`playbook code args: missing variable ${match?.[1]} (pass --var name=value)`);
		if (value.includes("\0") || value.length > 8192)
			throw new Error("playbook code args: invalid NUL or oversized argument");
		return value;
	});
}

/** Enforce operator-declared data slots; playbooks cannot append flags or executable code. */
export function validatePlaybookCommandArgs(
	command: PlaybookCommand,
	args: ReadonlyArray<string>,
	options: { allowTemplates?: boolean } = {},
): void {
	const slots = command.argumentSlots ?? [];
	if (
		slots.length > 64 ||
		new Set(slots.map((slot) => slot.name)).size !== slots.length ||
		slots.some(
			(slot) =>
				!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(slot.name) ||
				!Number.isInteger(slot.maxLength) ||
				slot.maxLength < 1 ||
				slot.maxLength > 8192,
		)
	) {
		throw new Error(`playbook command '${command.id}': invalid argumentSlots declaration`);
	}
	if (args.length !== slots.length) {
		throw new Error(
			`playbook command '${command.id}': expected ${slots.length} declared argument slots, got ${args.length}; the operator must declare argumentSlots in commands.yaml`,
		);
	}
	for (let index = 0; index < slots.length; index++) {
		const slot = slots[index];
		const value = args[index];
		if (!slot || typeof value !== "string") throw new Error(`playbook command '${command.id}': invalid argument`);
		if (options.allowTemplates && /^\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}$/u.test(value)) continue;
		if (value.length === 0 || value.length > slot.maxLength || value.includes("\0") || value.startsWith("-")) {
			throw new Error(
				`playbook command '${command.id}': argument '${slot.name}' must be nonempty data of at most ${slot.maxLength} characters, without NUL or a leading dash; fixed flags belong in argv`,
			);
		}
	}
}
